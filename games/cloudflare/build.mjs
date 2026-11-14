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
    observability: { enabled: true },
  }, null, 2) + '\n');
}
console.log('built', Object.keys(ADAPTERS).join(', '));
