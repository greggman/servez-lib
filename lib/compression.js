/*
Adapted from: https://github.com/pirxpilot/connect-gzip-static

The MIT License (MIT)

Copyright (c) 2013 Damian Krzeminski

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

const send = require('send');
const debug = require('debug')('compress');
const parse = require('url').parse;
const fs = require('fs');
const path = require('path');
const mime = send.mime;

function setHeader(res, path, encoding) {
  const type = mime.lookup(path);
  const charset = mime.charsets.lookup(type);

  debug('content-type %s', type);
  res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Vary', 'Accept-Encoding');
}

function handleGzipBroti(root, options) {
  const setHeaders = options.setHeaders;

  const methods = [];
  if (options.brotli) {
    methods.push({ extension: '.br', encoding: 'br' });
  }
  if (options.gzip) {
    methods.push({ extension: '.gz', encoding: 'gzip' });
  }

  function checkExtension(req, method) {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!~acceptEncoding.indexOf(method.encoding)) {
      return;
    }

    const name = {
      orig: parse(req.url).pathname
    };

    if (name.orig[name.orig.length - 1] === '/') {
      name.compressed = name.orig;
      name.orig += options.index;
      name.index = options.index + method.extension;
    } else {
      name.compressed = name.orig + method.extension;
    }
    name.full = path.join(root, name.orig + method.extension);
    debug('request %s, check for %s', req.url, name.full);

    try {
      const stats = fs.statSync(name.full);  // lgtm [js/path-injection]
      if (!stats.isDirectory()) {
        name.encoding = method.encoding;
        return name;
      }
    }
    catch (e) {
      // file probably didn't exist
    }
  }

  return function (req, res, next) {
    if (req.method !== 'GET'  && req.method !== 'HEAD') {
      return next();
    }

    let name;
    for (const method of methods) {
      name = checkExtension(req, method);
      if (name) {
        break;
      }
    }

    if (!name) {
      debug('Passing %s', req.url);
      return next();
    }

    debug('Sending %s', name.full);
    setHeader(res, name.orig, name.encoding);

    const stream = send(req, name.compressed, {
        maxAge: options.maxAge || 0,
        root:  root,
        index: name.index,
        cacheControl: options.cacheControl,
        lastModified: options.lastModified,
        etag: options.etag,
        dotfiles: options.dotfiles
      })
      .on('error', next);

    if (setHeaders) {
      stream.on('headers', setHeaders);
    }
    stream.pipe(res);
  };
}

module.exports = handleGzipBroti;
