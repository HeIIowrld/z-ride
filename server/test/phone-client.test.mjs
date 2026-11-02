import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createPhoneClientService } from '../phone-client.mjs';

test('phone reference client serves only allow-listed static assets with same-origin CSP', async () => {
  const client = createPhoneClientService();
  const server = http.createServer((req, res) => {
    if (!client.handleHttp(req, res, new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  // Ephemeral loopback ports can be reused by parallel tests while fetch keeps
  // old idle connections. These static-asset checks do not test keep-alive.
  const request = (path, options = {}) => fetch(base + path, { ...options, headers: { connection: 'close', ...options.headers } });
  try {
    for (const path of ['/play', '/play/', '/play/app.js', '/play/style.css', '/play/arena.js', '/play/arena.css']) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"));
      assert.ok(response.headers.get('content-security-policy').includes('ws://127.0.0.1:' + server.address().port));
      assert.ok(response.headers.get('content-security-policy').includes('wss://127.0.0.1:' + server.address().port));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      for (const restriction of ['camera=()', 'microphone=()', 'geolocation=()']) assert.ok(response.headers.get('permissions-policy').includes(restriction));
      assert.ok((await response.text()).length > 50);
    }
    assert.equal((await request('/play/private.env')).status, 404);
    assert.equal((await request('/play', { method: 'POST' })).status, 405);
    const head = await request('/play', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('phone CSP socket sources preserve one validated host and never interpolate unsafe Host syntax', () => {
  const client = createPhoneClientService();
  const policy = host => {
    let headers;
    client.handleHttp({ method: 'HEAD', headers: { host } }, { writeHead(_status, value) { headers = value; }, end() {} }, '/play');
    return headers['content-security-policy'];
  };
  for (const host of ['afsd.iptime.org:8000', '192.168.0.219:8000', '[::1]:8000']) {
    assert.ok(policy(host).includes(' ws://' + host + ' wss://' + host + ';'));
  }
  for (const host of ["afsd.iptime.org'; script-src *", 'host/path', 'host@evil.invalid', 'host:99999', 'host *']) {
    assert.ok(!policy(host).includes(' ws://'));
    assert.ok(!policy(host).includes('script-src *'));
  }
});
