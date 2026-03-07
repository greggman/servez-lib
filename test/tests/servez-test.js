const assert = require('chai').assert;
const Servez = require('../../lib/servez');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'data');
const fileTxtContents = fs.readFileSync(path.join(root, 'file.txt'), 'utf8');
const fooHtmlContents = fs.readFileSync(path.join(root, 'foo.html'), 'utf8');
const fileTxtGzContents = fs.readFileSync(path.join(root, 'file.txt.gz'));

function makeServer(options = {}) {
  return new Promise((resolve, reject) => {
    const servez = new Servez(Object.assign({}, options, {
      root,
      port: 8080,
      scan: options.scan === undefined ? true : options.scan,
      extensions: ['html'],
    }));
    servez.on('start', (startInfo) => {
      resolve({servez, startInfo, baseUrl: startInfo.baseUrl});
    });
    servez.on('error', reject);
  });
}

describe('servez-lib', () => {

  let server;
  afterEach(() => {
    if (server) {
      server.close();
      server = undefined;
    }
  })

  it('gets text', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    const text = await res.text();
    assert.strictEqual(text, fileTxtContents);
  });

  it('gets binary gz', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt.gz`);
    const arrayBuffer = await res.arrayBuffer();
    const expected = new Uint8Array(fileTxtGzContents.buffer, fileTxtGzContents.byteOffset, fileTxtGzContents.byteLength);
    assert.deepEqual(new Uint8Array(arrayBuffer), expected);
  });

  it('gets text from binary gz when gzip true', async() => {
    const {servez, baseUrl} = await makeServer({gzip: true});
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    assert.strictEqual(res.headers.get('content-encoding'), 'gzip');
    const text = await res.text();
    assert.strictEqual(text, fileTxtContents);
  });

  it('fails on missing file', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res = await fetch(`${baseUrl}/missing.txt`);
    assert.strictEqual(res.status, 404);
  });

  it('scan for port', async() => {
    const server1 = await makeServer();
    const server2 = await makeServer();
    assert.notStrictEqual(server1.baseUrl, server2.baseUrl);
    server1.servez.close();
    server2.servez.close();
  });

  it('scans for port if only 127.0.0.1 is in use', async() => {
    const server1 = await makeServer({local: true});
    const server2 = await makeServer();
    assert.notStrictEqual(server1.baseUrl, server2.baseUrl);
    server1.servez.close();
    server2.servez.close();
  });

  it('does not scan for port when scan false', async() => {
    const server1 = await makeServer();
    let threw = false;
    try {
      const server2 = await makeServer({scan: false});
      server2.servez.close();
    } catch (e) {
      threw = true;
    }
    assert.isOk(threw);
    server1.servez.close();
  });

  it('returns robots.txt if robots true', async() => {
    const {servez, baseUrl} = await makeServer({robots: true});
    server = servez;
    const res = await fetch(`${baseUrl}/robots.txt`);
    const text = await res.text();
    assert.strictEqual(text, 'User-agent: *\nDisallow: /');
  });

  it('returns 404 if robots false', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res = await fetch(`${baseUrl}/robots.txt`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for folder if index false', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res1 = await fetch(`${baseUrl}/folder`);
    assert.strictEqual(res1.status, 404);
    const res2 = await fetch(`${baseUrl}/folder/`);
    assert.strictEqual(res2.status, 404);
    const res3 = await fetch(`${baseUrl}/folder/index.html`);
    assert.strictEqual(res3.status, 200);
  });

  it('returns index.html for folder if index true', async() => {
    const {servez, baseUrl} = await makeServer({index: true});
    server = servez;
    const res1 = await fetch(`${baseUrl}/folder`);
    assert.strictEqual(res1.status, 200);
    const res1Text = await res1.text();
    const res2 = await fetch(`${baseUrl}/folder/`);
    assert.strictEqual(res2.status, 200);
    const res2Text = await res2.text();
    const res3 = await fetch(`${baseUrl}/folder/index.html`);
    assert.strictEqual(res3.status, 200);
    const res3Text = await res3.text();
    assert.strictEqual(res1Text, res2Text);
    assert.strictEqual(res1Text, res3Text);
  });

  it('returns something for folder if index false and dirs true', async() => {
    const {servez, baseUrl} = await makeServer({dirs: true});
    server = servez;
    const res1 = await fetch(`${baseUrl}/folder`);
    assert.strictEqual(res1.status, 200);
    const res2 = await fetch(`${baseUrl}/folder/`);
    assert.strictEqual(res2.status, 200);
    const res2Text = await res2.text();
    const res3 = await fetch(`${baseUrl}/folder/index.html`);
    assert.strictEqual(res3.status, 200);
    const res3Text = await res3.text();
    assert.notStrictEqual(res2Text, res3Text);
  });

  it('listing is kodi compatible', async() => {
    const {servez, baseUrl} = await makeServer({dirs: true});
    server = servez;
    const res = await fetch(`${baseUrl}/folder`);
    const html = await res.text();
    const dateRE = /<td align="right">([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}) +<\/td>/;
    const sizeRE = /> *([0-9.]+)(B|K|M|G| )<\/td>/
    const itemRE = /<a href=\"(.*)\">(.*)<\/a>/
    const items = html.split('\n').filter(line => itemRE.test(line));
    assert.strictEqual(items.length, 4);
    const files = items.filter(item => item.indexOf('/"') < 0);
    assert.strictEqual(files.length, 2);
    for (const item of files) {
      assert.isTrue(sizeRE.test(item));
      assert.isTrue(dateRE.test(item));
    }
  });

  it('fails if bad auth', async() => {
    const username = 'foo';
    const password = 'bar';
    const {servez, baseUrl} = await makeServer({username, password});
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    assert.strictEqual(res.status, 401);
  });

  it('succeeds if good auth', async() => {
    const username = 'foo';
    const password = 'bar';
    const {servez, baseUrl} = await makeServer({username, password});
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(username + ":" + password).toString('base64')}`,
      },
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.strictEqual(text, fileTxtContents);
  });

  it('gets html when non-html', async() => {
    const {servez, baseUrl} = await makeServer();
    server = servez;
    const res = await fetch(`${baseUrl}/foo`);
    const text = await res.text();
    assert.strictEqual(text, fooHtmlContents);
  });

  it('emits host before start', async() => {
    // 'server' is shared above to cleanup.
    server = new Servez({
      root,
      port: 8080,
      scan: true,
    });

    let host;
    server.on('host', (info) => {
      host = info.root;
    });
    await new Promise((resolve, reject) => {
      server.on('start', resolve);
      server.on('error', reject);
    });

    assert(/^http(s*):\/\/.*?\/$/.test(host));
  });

  it('does not sends headers for sharedArrayBuffers by default', async() => {
    const {servez, baseUrl} = await makeServer({sharedArrayBuffers: true});
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    assert(res.headers.has('cross-origin-embedder-policy'));
    assert(res.headers.has('cross-origin-opener-policy'));
  });

  it('sends correct headers for sharedArrayBuffers', async() => {
    const {servez, baseUrl} = await makeServer({sharedArrayBuffers: true});
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    assert.strictEqual(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.strictEqual(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  });

  it('sends added headers', async() => {
    const {servez, baseUrl} = await makeServer({
      headers: {
        'animal': 'dog',
        'fruit': 'banana',
      }
    });
    server = servez;
    const res = await fetch(`${baseUrl}/file.txt`);
    assert.strictEqual(res.headers.get('animal'), 'dog');
    assert.strictEqual(res.headers.get('fruit'), 'banana');
  });

  describe('webdav', () => {

    async function webdavFetch(baseUrl, path, method, extraHeaders = {}) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Depth': '0', ...extraHeaders },
      });
    }

    async function propfind(baseUrl, path, depth = '1') {
      return fetch(`${baseUrl}${path}`, {
        method: 'PROPFIND',
        headers: { 'Depth': depth },
      });
    }

    function parseXml(text) {
      // Minimal XML element text extractor for testing
      return {
        includes: (str) => text.includes(str),
        text,
      };
    }

    it('OPTIONS returns DAV headers', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/`, { method: 'OPTIONS' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('dav'), '1, 2');
      assert.ok(res.headers.get('allow').includes('PROPFIND'));
      assert.strictEqual(res.headers.get('ms-author-via'), 'DAV');
    });

    it('PROPFIND on root returns 207 with XML', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/');
      assert.strictEqual(res.status, 207);
      assert.ok(res.headers.get('content-type').includes('xml'));
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('multistatus'));
      assert.ok(xml.includes('collection'));
    });

    it('PROPFIND on root Depth:1 lists files', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/', '1');
      assert.strictEqual(res.status, 207);
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('file.txt'));
      assert.ok(xml.includes('folder'));
    });

    it('PROPFIND on file returns 207 with file info', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/file.txt', '0');
      assert.strictEqual(res.status, 207);
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('file.txt'));
      assert.ok(xml.includes('getcontentlength'));
      assert.ok(xml.includes('getcontenttype'));
      assert.ok(xml.includes('text/plain'));
    });

    it('PROPFIND reports correct file size', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const expectedSize = fs.statSync(path.join(root, 'file.txt')).size;
      const res = await propfind(baseUrl, '/file.txt', '0');
      const xml = parseXml(await res.text());
      assert.ok(xml.includes(`>${expectedSize}<`));
    });

    it('PROPFIND reports correct MIME types for various extensions', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;

      const cases = [
        ['/image.jpg',  'image/jpeg'],
        ['/image.png',  'image/png'],
        ['/image.svg',  'image/svg+xml'],
        ['/foo.html',   'text/html'],
      ];

      for (const [filePath, expectedType] of cases) {
        const res = await propfind(baseUrl, filePath, '0');
        assert.strictEqual(res.status, 207, `${filePath} should return 207`);
        const xml = parseXml(await res.text());
        assert.ok(xml.includes(expectedType), `${filePath} should have MIME type ${expectedType}`);
      }
    });

    it('PROPFIND on subdirectory lists contents', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/folder/', '1');
      assert.strictEqual(res.status, 207);
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('collection'));
      assert.ok(xml.includes('index.html'));
    });

    it('PROPFIND on missing path returns 404', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/does-not-exist', '0');
      assert.strictEqual(res.status, 404);
    });

    it('PROPFIND response includes required DAV properties', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/file.txt', '0');
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('displayname'));
      assert.ok(xml.includes('getlastmodified'));
      assert.ok(xml.includes('creationdate'));
      assert.ok(xml.includes('resourcetype'));
      assert.ok(xml.includes('lockdiscovery'));
      assert.ok(xml.includes('supportedlock'));
    });

    it('PROPFIND hrefs are absolute URIs', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await propfind(baseUrl, '/file.txt', '0');
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('http://'));
    });

    it('LOCK returns 200 with lock token', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await webdavFetch(baseUrl, '/', 'LOCK');
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('lock-token'));
      assert.ok(res.headers.get('lock-token').includes('urn:uuid:'));
      const xml = parseXml(await res.text());
      assert.ok(xml.includes('lockdiscovery'));
      assert.ok(xml.includes('activelock'));
    });

    it('UNLOCK returns 204', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await webdavFetch(baseUrl, '/', 'UNLOCK', {
        'Lock-Token': '<urn:uuid:fake-token>',
      });
      assert.strictEqual(res.status, 204);
    });

    it('PUT returns 405', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/file.txt`, { method: 'PUT', body: 'data' });
      assert.strictEqual(res.status, 405);
    });

    it('DELETE returns 405', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/file.txt`, { method: 'DELETE' });
      assert.strictEqual(res.status, 405);
    });

    it('MKCOL returns 405', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/newdir`, { method: 'MKCOL' });
      assert.strictEqual(res.status, 405);
    });

    it('HEAD on directory returns 200', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/folder/`, { method: 'HEAD' });
      assert.strictEqual(res.status, 200);
    });

    it('HEAD on file returns 200', async() => {
      const {servez, baseUrl} = await makeServer();
      server = servez;
      const res = await fetch(`${baseUrl}/file.txt`, { method: 'HEAD' });
      assert.strictEqual(res.status, 200);
    });

  });

});