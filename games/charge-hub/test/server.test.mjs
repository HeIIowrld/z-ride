import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubServer, gameLinks } from '../server.mjs';

test('links.json이 없으면 같은 호스트 이름에 게임 포트를 붙인다', () => {
  const links = gameLinks('192.168.0.5:8300', '/nope/links.json');
  assert.equal(links['power-castle'], 'http://192.168.0.5:8240');
  assert.equal(links['charge-relay'], 'http://192.168.0.5:8200');
});

test('links.json(터널 주소)이 있으면 그 주소를 쓰고 끝의 /는 뗀다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'));
  const path = join(dir, 'links.json');
  writeFileSync(path, JSON.stringify({ 'volt-rush': 'https://a-b.trycloudflare.com/' }));
  const links = gameLinks('x', path);
  assert.equal(links['volt-rush'], 'https://a-b.trycloudflare.com');
  assert.equal(links['power-tug'], 'http://x:8220');
});

test('첫 화면과 게임 주소를 보안 헤더와 함께 준다', async t => {
  const http = createHubServer({ linksPath: '/nope/links.json' });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => http.close());
  const base = `http://127.0.0.1:${http.address().port}`;
  for (const path of ['/', '/hub.js', '/style.css']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const links = await (await fetch(base + '/links.json')).json();
  assert.equal(Object.keys(links).length, 4);
  assert.equal((await fetch(base + '/nope')).status, 404);
});
