const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

function escapeXml(unsafe) {
    return unsafe.replace(/[<>&"']/g, (c) => {
        return {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c];
    });
}

module.exports = function webdav(settings) {
  return async (req, res, next) => {
    const webdavWriteMethods = ['PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'PROPPATCH', 'PATCH'];
    const davHeaders = { 'DAV': '1, 2', 'Allow': 'OPTIONS, GET, HEAD, PROPFIND, LOCK, UNLOCK' };
    const xmlContentType = 'text/xml; charset="utf-8"';
    const protocol = settings.ssl ? 'https' : 'http';
    const baseUrl = `${protocol}://${req.get('host')}`;

    if (req.method === 'OPTIONS') {
      return res.status(200).set({
        ...davHeaders,
        'MS-Author-Via': 'DAV',
      }).end();
    }

    if (req.method === 'LOCK') {
      const lockToken = `urn:uuid:${crypto.randomUUID()}`;
      const xml = `<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${lockToken}</d:href></d:locktoken><d:lockroot><d:href>${escapeXml(baseUrl + req.path)}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;
      return res.status(200).set({
        'Content-Type': xmlContentType,
        'Lock-Token': `<${lockToken}>`,
        ...davHeaders,
      }).send(xml);
    }

    if (req.method === 'UNLOCK') {
      return res.status(204).end();
    }

    // Read-only: reject write methods with 405.
    if (webdavWriteMethods.includes(req.method)) {
      return res.status(405).set(davHeaders).end();
    }

    // Handle HEAD on directories (express.static handles HEAD on files)
    if (req.method === 'HEAD') {
      try {
        const fullPath = path.join(settings.root, decodeURIComponent(req.path));
        const stats = await fs.promises.stat(fullPath);
        if (stats.isDirectory()) {
          return res.status(200).set({ ...davHeaders, 'Content-Type': 'text/html' }).end();
        }
      } catch (e) {
        /* fall through to static middleware */
      }
      return next();
    }

    if (req.method !== 'PROPFIND') {
      return next();
    }

    // PROPFIND Logic (Read-Only)
    try {
      const relativePath = decodeURIComponent(req.path);
      const fullPath = path.join(settings.root, relativePath);
      const stats = await fs.promises.stat(fullPath);

      let entries = [{ name: '', stat: stats, isDir: stats.isDirectory() }];
      const depth = req.get('Depth') || '1';

      if (stats.isDirectory() && depth !== '0') {
        const dirContents = await fs.promises.readdir(fullPath);
        const children = await Promise.all(dirContents.map(async (name) => {
          const fStat = await fs.promises.stat(path.join(fullPath, name));
          return { name, stat: fStat, isDir: fStat.isDirectory() };
        }));
        entries = entries.concat(children);
      }

      let xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">`;

      for (const item of entries) {
        let href;
        if (item.name === '') {
          // Root entry: use absolute URI
          href = baseUrl + req.path;
          if (item.isDir && !href.endsWith('/')) {
            href += '/';
          }
        } else {
          // Child entry: URL-encode the filename from readdir
          const base = req.path.endsWith('/') ? req.path : req.path + '/';
          href = baseUrl + base + encodeURIComponent(item.name);
          if (item.isDir) {
            href += '/';
          }
        }

        const displayName = item.name || path.basename(req.path.replace(/\/$/, '')) || '/';
        const creationDate = (item.stat.birthtime || item.stat.mtime).toISOString();
        xml += `
<d:response>
  <d:href>${escapeXml(href)}</d:href>
  <d:propstat>
    <d:prop>
      <d:displayname>${escapeXml(displayName)}</d:displayname>
      <d:creationdate>${creationDate}</d:creationdate>
      <d:getlastmodified>${item.stat.mtime.toUTCString()}</d:getlastmodified>
      ${item.isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'}
      <d:lockdiscovery/>
      <d:supportedlock>
        <d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry>
      </d:supportedlock>${item.isDir ? '' : `
      <d:getcontentlength>${item.stat.size}</d:getcontentlength>
      <d:getcontenttype>${escapeXml(mime.lookup(item.name || path.basename(decodeURIComponent(req.path))) || 'application/octet-stream')}</d:getcontenttype>`}
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
      }
      xml += `\n</d:multistatus>`;

      res.status(207).set({
          'Content-Type': xmlContentType,
          'DAV': '1, 2',
      }).send(xml);
    } catch (err) {
      res.status(err.code === 'ENOENT' ? 404 : 500).end();
    }
  }
}
