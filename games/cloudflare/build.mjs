// 게임마다 배포 폴더(dist/<게임>)를 만든다: 정적 파일 + 차량 SDK + wrangler 설정.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './adapters.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const games = join(here, '..');
for (const id of Object.keys(ADAPTERS)) {
  const out = join(here, 'dist', id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  cpSync(join(games, id, 'public'), join(out, 'assets'), { recursive: true });
  cpSync(join(games, 'sdk', 'zride-car.js'), join(out, 'assets', 'zride-car.js'));
  writeFileSync(join(out, 'wrangler.jsonc'), JSON.stringify({
    name: `zride-${id}`,
    main: '../../worker.mjs',
    compatibility_date: '2026-11-01',
    assets: { directory: './assets', binding: 'ASSETS', run_worker_first: true, html_handling: 'none' },
    vars: { GAME: id },
    durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: true },
  }, null, 2) + '\n');
}
// 게임 모음 첫 화면은 정적 파일만 올린다. 게임 주소는 위에서 만든 Worker 이름으로 정해진다
const SUBDOMAIN = process.env.CF_SUBDOMAIN ?? 'zride-charge-games-cloudflare';
const hub = join(here, 'dist', 'charge-hub');
rmSync(hub, { recursive: true, force: true });
mkdirSync(join(hub, 'assets'), { recursive: true });
cpSync(join(games, 'charge-hub', 'public'), join(hub, 'assets'), { recursive: true });
writeFileSync(join(hub, 'assets', 'links.json'), JSON.stringify(Object.fromEntries(Object.keys(ADAPTERS).map(id => [id, `https://zride-${id}.${SUBDOMAIN}.workers.dev`])), null, 2));
writeFileSync(join(hub, 'assets', '_headers'), "/*\n  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n");
writeFileSync(join(hub, 'wrangler.jsonc'), JSON.stringify({
  name: 'zride-charge-hub', compatibility_date: '2026-11-01',
  assets: { directory: './assets' }, workers_dev: true, preview_urls: false,
}, null, 2) + '\n');
console.log('built', [...Object.keys(ADAPTERS), 'charge-hub'].join(', '));
