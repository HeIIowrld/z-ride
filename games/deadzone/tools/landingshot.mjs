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

/* Renders the landing page from its source module and screenshots it, in both
   languages and both directions, without needing the Worker deployed.

   renderLanding() is a pure function of a Request, which is the only reason
   this is possible — worth preserving. */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { renderLanding } from '../packages/landing/src/worker.js';

const OUT = resolve(process.argv[2] || 'shots-ui');
await mkdir(OUT, { recursive: true });

const PUBLIC = resolve('packages/client/public');
const TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/' || path === '/landing') {
    const html = await Promise.resolve(renderLanding(new Request("https://overrun.test/landing"))).then(r => r.text());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  try {
    const body = await readFile(join(PUBLIC, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { void e; res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}/landing`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});

const VIEWS = [
  { tag: 'desktop', width: 1440, height: 900 },
  { tag: 'phone', width: 393, height: 852 }
];

let problems = 0;
for (const v of VIEWS) {
  const page = await browser.newPage({ viewport: { width: v.width, height: v.height } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: join(OUT, `landing-${v.tag}-top.png`) });
  // Scrolled, so the scroll-edge fade under the bar is actually exercised.
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `landing-${v.tag}-scrolled.png`) });

  const scrolled = await page.evaluate(() =>
    getComputedStyle(document.querySelector('header.bar')).getPropertyValue('--scrolled').trim());
  if (scrolled !== '1') { console.log(`  ${v.tag}: scroll-edge did not arm (--scrolled=${scrolled || 'unset'})`); problems++; }

  // Persian, right-to-left.
  await page.evaluate(() => window.scrollTo(0, 0));
  const fa = await page.$('.langtoggle button:not([aria-pressed="true"])');
  if (fa) { await fa.click(); await page.waitForTimeout(700); }
  await page.screenshot({ path: join(OUT, `landing-${v.tag}-fa.png`) });

  const dir = await page.evaluate(() => document.documentElement.dir);
  if (dir !== 'rtl') { console.log(`  ${v.tag}: language toggle did not switch to rtl (dir=${dir})`); problems++; }

  // Every image must actually have pixels.
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll('img')].filter(i => i.getAttribute('src') && i.complete && i.naturalWidth === 0)
      .map(i => i.getAttribute('src')));
  if (broken.length) { console.log(`  ${v.tag}: broken images ${broken.join(', ')}`); problems++; }

  if (errors.length) { console.log(`  ${v.tag}: ${errors.slice(0, 2).join(' | ')}`); problems++; }
  console.log(`${v.tag}: captured`);
  await page.close();
}

await browser.close();
server.close();
console.log(problems ? `\n${problems} problem(s)` : '\nlanding page clean');
process.exit(problems ? 1 : 0);
