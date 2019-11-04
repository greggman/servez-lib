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
 * @property {string} [username] username required to access using basic auth
 * @property {string} [password] username required to access using basic auth
 * @property {boolean} [ssl] true = use https
 * @property {string} [cert] path to https cert file.
 * @property {string} [key] path to https key file.
 * @property {boolean} [scan] true = scan for a port starting at `port`
 */

const noopLogger = {
  log() {},
  error() {},
};

class Servez extends EventEmitter {
  constructor(settings) {
    super();
    const root = settings.root;
    const local = settings.local;
    const hostname = local ? '127.0.0.1' : undefined;
    const logger = settings.logger || noopLogger;

    const app = express();

    staticOptions.index = settings.index ? 'index.html' : false;

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
      logger.log(req.method, req.originalUrl);
      next();
    });

    if (settings.gzip || settings.brotli) {
      app.use(compression(this.root, Object.assign({}, staticOptions, {
        gzip: settings.gzip,
        brotli: settings.brotli,
      })));
    }

    app.use(express.static(root, staticOptions));
    if (settings.dirs) {
      app.use(serveIndex(root, {
        icons: true,
        stylesheet: path.join(__dirname, '..', 'src', 'listing.css'),
        template: path.join(__dirname, '..', 'src', 'listing.html'),
      }));
    }

    function localErrorHandler(err, req, res, next) {
      debug(`ERROR: ${req.method} ${req.url} ${err}`);
      logger.error(`ERROR: ${req.method} ${req.url} ${err}`);
      res.status(500).send(`<pre>${err}</pre>`);
    }

    function nonErrorLocalErrorHandler(req, res, next) {
      debug(`ERROR: ${req.method} ${req.url} 404`);
      logger.error(`ERROR: ${req.method} ${req.url}`);
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
        const credentials = {
          key: fs.readFileSync(settings.key, 'utf8'),
          cert: fs.readFileSync(settings.cert, 'utf8'),
        };
        server = https.createServer(credentials, app);
      } else {
        server = http.createServer(app);
      }
      server.on('error', (e) => {
        if (!settings.scan || started) {
          return logger.error('ERROR:', e.message);
        }
        if (settings.scan) {
          ++port;
          server.listen(port, hostname);
        }
      });
      server.on('listening', () => {
        started = true;
        logger.log('server started on ', hostname || '::' , port, 'for path:', root);
        logger.log('available on:');
        const protocol = settings.ssl ? 'https://' : 'http://';
        logger.log(`   ${protocol}localhost:${port}`);
        if (!hostname) {
          const iFaces = os.networkInterfaces();
          Object.keys(iFaces).forEach(function (dev) {
            iFaces[dev].forEach(function (details) {
              if (details.family === 'IPv4') {
                logger.log(`   ${protocol}${details.address}:${port}`);
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
      logger.error('ERROR:', e, e.message, e.stack);
    }

    this.close = function() {
      server.destroy();
    };
  }
}

module.exports = Servez;
