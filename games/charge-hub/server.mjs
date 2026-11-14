// 충전소 게임 모음 첫 화면. 정적 파일과 게임 주소(links.json)만 준다.
// 게임 주소는 터널을 열 때마다 바뀌므로 커밋하지 않는 links.json에서 읽는다. 없으면 같은 컴퓨터의 포트로 잇는다.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const FILES = { '/': 'index.html', '/hub.js': 'hub.js', '/style.css': 'style.css' };
const PORTS = { 'charge-relay': 8200, 'power-tug': 8220, 'volt-rush': 8230, 'power-castle': 8240 };
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

/** 게임별 주소. links.json(터널 주소)이 있으면 그걸, 없으면 요청이 온 호스트 이름에 게임 포트를 붙인다. */
export function gameLinks(host, linksPath = join(here, 'links.json')) {
  const saved = existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, 'utf8')) : {};
  const name = String(host ?? 'localhost').split(':')[0];
  return Object.fromEntries(Object.entries(PORTS).map(([id, port]) => [id, String(saved[id] ?? `http://${name}:${port}`).replace(/\/+$/, '')]));
}

export function createHubServer({ linksPath } = {}) {
  const files = Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, { body: readFileSync(join(here, 'public', file)), type: TYPES[file.split('.').pop()] }]));
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method !== 'GET') { res.writeHead(405, HEADERS); return res.end(); }
    if (pathname === '/links.json') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(gameLinks(req.headers.host, linksPath)));
    }
    if (pathname === '/healthz') { res.writeHead(200, { ...HEADERS, 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    const file = files[pathname];
    if (!file) { res.writeHead(404, HEADERS); return res.end('not found'); }
    res.writeHead(200, { ...HEADERS, 'content-type': file.type });
    res.end(file.body);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8300);
  createHubServer().listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(JSON.stringify({ event: 'server.ready', port })));
}
