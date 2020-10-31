const assert = require('chai').assert;
const Servez = require('../../lib/servez');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

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

});