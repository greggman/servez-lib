/*
The MIT License (MIT)

Copyright (c) 2019 Gregg Tavares

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/
'use strict';

const express = require('express');
const cors = require('cors');
const serveIndex = require('serve-index');
const path = require('path');
const fs = require('fs');
const enableDestroy = require('server-destroy');
const debug = require('debug')('servez');
const EventEmitter = require('events');
const compression = require('./compression');
const auth = require('basic-auth');
const secureCompare = require('secure-compare');
const http = require('http');
const https = require('https');
const os = require('os');
const selfsigned = require('selfsigned');
const createHtmlRender = require('./listing');

const staticOptions = {
  fallthrough: true,  // true = call next middleware if no file, false = return 404
  setHeaders: setHeaders,
};

function setHeaders(res /*, path, stat */) {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate', // HTTP 1.1.
    'Pragma':        'no-cache',                            // HTTP 1.0.
    'Expires':       '0',                                   // Proxies.
  });
}

function fileExists(filename) {
  try {
    const stat = fs.statSync(filename);
    return !!stat;
  } catch (e) {
    return false;
  }
}

/**
 * @typedef {Object} Logger
 * @property {function} log
 * @property {function} error
 * @property {ansiColor} [c] ansi-colors compatible colorizer.
 */

/**
 * @typedef {Object} Settings
 * @property {string} root folder to server
 * @property {number} port port to server
 * @property {boolean} [local] true = only serve to the local machine
 * @property {Logger} [logger] function for logging
 * @property {boolean} [index] true = serve index.html if folder 
 * @property {boolean} [dirs] true = show listing if folder
 * @property {boolean} [gzip] true = serve .gz files if they exist
 * @property {boolean} [brotli] true = serve .br files if they exist
 * @property {boolean} [robots] true = serve a robots.txt disallow if robots.txt does not exist
 * @property {boolean} [hidden] true = show dotfiles
 * @property {string} [username] username required to access using basic auth
 * @property {string} [password] username required to access using basic auth
 * @property {string[]} [extensions] extensions. If a path is not file these extensions will be added and tried
 * @property {boolean} [ssl] true = use https
 * @property {string} [cert] path to https cert file.
 * @property {string} [key] path to https key file.
 * @property {boolean} [scan] true = scan for a port starting at `port`
 * @property {string} dataDir path to store data like fake cert
 */

const noopLogger = {
  log() {},
  error() {},
  c: new Proxy({}, {
    get(target, name) {
      return s => s;
    },
  }),
};

class Servez extends EventEmitter {
  constructor(settings) {
    super();
    const root = settings.root;
    const local = settings.local;
    const hostname = local ? '127.0.0.1' : undefined;
    const logger = settings.logger || noopLogger;
    const log = logger.log.bind(logger);
    const error = logger.error.bind(logger);
    const c = logger.c || noopLogger.c;

    const app = express();

    staticOptions.index = settings.index ? 'index.html' : false;
    if (settings.extensions) {
      staticOptions.extensions = settings.extensions;
    }

    if (settings.username || settings.password) {
      app.use(function (req, res, next) {
        const credentials = auth(req);

        // We perform these outside the if to avoid short-circuiting and giving
        // an attacker knowledge of whether the username is correct via a timing
        // attack.
        if (credentials) {
          const usernameEqual = secureCompare(settings.username, credentials.name);
          const passwordEqual = secureCompare(settings.password, credentials.pass);
          if (usernameEqual && passwordEqual) {
            return next();
          }
        }

        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm=""');
        res.end('Access denied');
      });
    }

    if (settings.cors) {
      app.use(cors());
    }

    if (settings.robots) {
      if (!fileExists(path.join(root, 'robots.txt'))) {
        app.use(function (req, res, next) {
          if (req.url === '/robots.txt') {
            res.setHeader('Content-Type', 'text/plain');
            return res.end('User-agent: *\nDisallow: /');
          }

          next();
        });
      }
    }

    app.use((req, res, next) => {
      log(`${req.method} ${c.cyan(req.originalUrl)}`);
      next();
    });

    if (settings.gzip || settings.brotli) {
      app.use(compression(root, Object.assign({}, staticOptions, {
        gzip: settings.gzip,
        brotli: settings.brotli,
      })));
    }

    app.use(express.static(root, staticOptions));
    if (settings.dirs) {
      app.use(serveIndex(root, {
        icons: true,
        hidden: settings.hidden,
        template: createHtmlRender(),
        // PS: I thought about filtering out .gz and .br files if those
        // features are on but it's complicated.
        // If foo.txt exists and foo.txt.gz exists then we don't want to display foo.txt.gz
        // If foo.txt does NOT exist and foo.txt.gz exists then we want to display
        // foo.txt instead but this filter doesn't let us change things, only filter.
        // It's not a big deal so punting.
      }));
    }

    function localErrorHandler(err, req, res, next) {
      debug(`ERROR: ${req.method} ${req.url} ${err}`);
      error(`ERROR: ${req.method} ${c.cyan(req.url)} ${err}`);
      res.status(500).send(`<pre>${err}</pre>`);
    }

    function nonErrorLocalErrorHandler(req, res, next) {
      debug(`ERROR: ${req.method} ${req.url} [404]`);
      error(`ERROR: ${req.method} ${c.cyan(req.url)} [404: does not exist]`);
      res.status(404).send(`<pre>ERROR 404: No such path ${req.path}</pre>`);
    }

    app.use(nonErrorLocalErrorHandler);
    app.use(localErrorHandler);

    let server;
    let port = settings.port;
    let started = false;
    try {
      debug('starting server');

      if (settings.ssl) {
        const fakeCert = getFakeCert(settings.dataDir);
        const credentials = {
          key: settings.key ? fs.readFileSync(settings.key, 'utf8') : fakeCert,
          cert: settings.cert ? fs.readFileSync(settings.cert, 'utf8') : fakeCert,
        };
        server = https.createServer(credentials, app);
      } else {
        server = http.createServer(app);
      }
      server.on('error', (e) => {
        if (!settings.scan || started) {
          error('ERROR:', e.message);
          this.emit('error', e);
          return;
        }
        if (settings.scan) {
          ++port;
          server.listen(port, hostname);
        }
      });
      server.on('listening', () => {
        started = true;
        log(c.yellow(`server started on ${hostname || '::'}${port} for path: ${c.cyan(root)}`));
        log(c.yellow('available on:'));
        const protocol = settings.ssl ? 'https://' : 'http://';
        log(`   ${protocol}localhost:${port}`);
        if (!hostname) {
          const iFaces = os.networkInterfaces();
          Object.keys(iFaces).forEach(function (dev) {
            iFaces[dev].forEach(function (details) {
              if (details.family === 'IPv4') {
                log(`   ${protocol}${details.address}:${port}`);
              }
            });
          });
        }
        this.emit('start', {
          port,
          protocol,
          baseUrl: `${protocol}localhost:${port}`,
        });
      });
      server.on('close', () => {
        this.emit('close');
      });
      enableDestroy(server);
      server.listen(port, hostname);
    } catch (e) {
      debug('error starting server');
      error('ERROR:', e, e.message, e.stack);
    }

    this.close = function() {
      server.destroy();
    };
  }
}

function getFakeCert(dataDir) {
  if (!dataDir) {
    throw new Error("dataDir not set");
  }

  const cachedCertFilename = path.join(dataDir, 'cached-fake-cert.pem');

  // I don't like the idea of storing this here but where else? Don't want to
  // store it in the user folder as it should probably not be shared across
  // projects and don't want some library spewing files into some global space.
  if (fs.existsSync(cachedCertFilename)) {
    const stat = fs.statSync(cachedCertFilename);
    const now = new Date();
     // 28 days (voodoo. I travel, no idea if expiration dates are timezone dependent)
     // so cert is valid for 30 days but we make a new one at 28
    const timeToLiveMs = 1000 * 60 * 60 * 24 * 28;
    if (now - stat.mtime < timeToLiveMs) {
      debug(`using cached fake cert: ${cachedCertFilename}`);
      // scary if this file gets corrupted
      return fs.readFileSync(cachedCertFilename, 'utf8');
    }
  }

  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    days: 30,
    keySize: 2048,
    extensions: [
      // {
      //   name: 'basicConstraints',
      //   cA: true,
      // },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        timeStamping: true,
      },
      {
        name: 'subjectAltName',
        altNames: [
          {
            // type 2 is DNS
            type: 2,
            value: 'localhost',
          },
          {
            type: 2,
            value: 'localhost.localdomain',
          },
          {
            type: 2,
            value: 'lvh.me',
          },
          {
            type: 2,
            value: '*.lvh.me',
          },
          {
            type: 2,
            value: '[::1]',
          },
          {
            // type 7 is IP
            type: 7,
            ip: '127.0.0.1',
          },
          {
            type: 7,
            ip: 'fe80::1',
          },
        ],
      },
    ],
  });
  const fakeCert = pems.private + pems.cert;
  debug(`caching fake cert: ${cachedCertFilename}`);
  fs.writeFileSync(cachedCertFilename, fakeCert);
  return fakeCert;
}

module.exports = Servez;
