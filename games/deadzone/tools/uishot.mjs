/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Captures every menu-layer screen, at desktop and phone sizes, so a UI change
   can be looked at rather than imagined. Also the only practical way to check
   the accessibility paths — reduced transparency and increased contrast are
   media queries nobody remembers to toggle by hand.

   Usage: npm run build && node tools/uishot.mjs [outDir]                    */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] || 'shots-ui');
await mkdir(OUT, { recursive: true });

const DIST = resolve('packages/client/dist');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  for (const c of [join(DIST, path), join(DIST, 'index.html')]) {
    try {
      const body = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      res.end(body); return;
    } catch (e) { void e; }
  }
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required']
});

// Each screen: the panel id to show, and any DOM it needs populated first.
const SCREENS = [
  { name: 'menu', panel: 'titleScreen' },
  { name: 'howto', panel: 'howScreen' },
  { name: 'join', panel: 'joinScreen' },
  { name: 'pause', panel: 'pauseScreen' },
  { name: 'upgrade', panel: 'upgradeScreen', prep: 'upgrade' },
  { name: 'results', panel: 'deathScreen', prep: 'results' }
];

const VIEWPORTS = [
  { tag: 'desktop', width: 1440, height: 900 },
  { tag: 'phone', width: 844, height: 390 }     // landscape, which is how it plays
];

async function shoot(page, name) {
  await page.waitForTimeout(650);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('  ' + name);
}

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForSelector('[data-a="solo"]', { timeout: 120000 });
  console.log(vp.tag + ':');

  for (const s of SCREENS) {
    await page.evaluate(({ panel, prep }) => {
      // Populate the panels whose content is built at runtime, using markup
      // that matches what the game produces, so the screenshot shows the real
      // layout rather than an empty box.
      if (prep === 'upgrade') {
        document.getElementById('cards').innerHTML = [
          ['pas', '✦', 'HEAVY ROUNDS', '+22% damage', 'PASSIVE'],
          ['act', '⌁', 'LANCE', 'Unlock: piercing railgun', 'WEAPON'],
          ['pas', '⊟', 'STABILISER', '-25% spread and recoil', 'PASSIVE']
        ].map(([k, ic, nm, ds, tp]) =>
          `<div class="card ${k}"><div class="ic">${ic}</div><div class="nm">${nm}</div>` +
          `<div class="ds">${ds}</div><div class="tp">${tp}</div></div>`).join('');
        document.getElementById('choiceTimer').textContent = 'AUTO-PICKS IN 8';
      }
      if (prep === 'results') {
        document.getElementById('summary').innerHTML = [
          ['WAVE', '14'], ['KILLS', '312'], ['ACCURACY', '61%'], ['BEST COMBO', '27']
        ].map(([a, b]) => `<div><div class="lbl small">${a}</div><div class="num" style="font-size:26px">${b}</div></div>`).join('');
        document.getElementById('xpBar').classList.remove('hidden');
        document.getElementById('xpFill').style.transform = 'scaleX(.62)';
      }
      for (const p of document.querySelectorAll('.panel')) p.classList.remove('show');
      document.getElementById(panel).classList.add('show');
      document.getElementById('boot')?.classList.add('gone');
    }, s);
    await shoot(page, `${vp.tag}-${s.name}`);
  }

  // Accessibility paths, on the busiest screen.
  for (const [tag, media] of [
    ['reduced-transparency', { name: 'prefers-reduced-transparency', value: 'reduce' }],
    ['more-contrast', { name: 'prefers-contrast', value: 'more' }],
    ['reduced-motion', { name: 'prefers-reduced-motion', value: 'reduce' }]
  ]) {
    await page.emulateMedia({ [media.name.replace('prefers-', '')]: media.value }).catch(() => {});
    await page.evaluate(m => {
      // Playwright only emulates a subset; force the rest through a style tag
      // so the fallback tokens are still exercised visually.
      const s = document.createElement('style');
      s.id = 'a11y-force';
      s.textContent = m === 'reduced-transparency'
        ? ':root{--glass-fill:#131F2B;--glass-fill-lg:#101A24;--glass-blur:0px;--glass-blur-lg:0px}'
        : m === 'more-contrast'
          ? ':root{--glass-fill:#0C141D;--glass-fill-lg:#0A1119;--glass-blur:0px;--glass-blur-lg:0px;--label-2:rgba(240,248,252,.88);--separator:rgba(190,215,230,.38)}'
          : '';
      document.getElementById('a11y-force')?.remove();
      document.head.appendChild(s);
      for (const p of document.querySelectorAll('.panel')) p.classList.remove('show');
      document.getElementById('titleScreen').classList.add('show');
    }, tag);
    await shoot(page, `${vp.tag}-a11y-${tag}`);
    await page.evaluate(() => document.getElementById('a11y-force')?.remove());
  }

  if (errors.length) console.log('  errors: ' + errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log('\nwrote ' + OUT);
