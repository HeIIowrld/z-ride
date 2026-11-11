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

/* Plays the DEPLOYED game and asserts it is actually playable.

   Not "the page loads" and not "the bundle is the right size" — it presses
   SOLO, holds a movement key, fires, and then checks that the simulation
   advanced, the player moved, and enemies exist. A build can pass every
   static check and still be a game nobody can start; that is precisely what
   the 44.1 kHz audio bug did.

   Usage:  node tools/livecheck.mjs [url] [sampleRate]                       */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

let URL = process.argv[2] || 'https://overrun.mahdi-mortazavi-135.workers.dev/';
const RATE = Number(process.argv[3] || 48000);

/* `local` serves packages/client/dist instead. Useful when the deployed host
   is unreachable from wherever this is running — the bundle is built from the
   same sources, so it exercises the same code. */
let server = null;
if (URL === 'local') {
  const DIST = resolve('packages/client/dist');
  const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
  };
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    for (const candidate of [join(DIST, path), join(DIST, 'index.html')]) {
      try {
        const body = await readFile(candidate);
        res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' });
        res.end(body);
        return;
      } catch (e) { void e; }
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, r));
  URL = `http://127.0.0.1:${server.address().port}/`;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Pin the sample rate to the value that used to break it.
await page.addInitScript(rate => {
  const Real = window.AudioContext || window.webkitAudioContext;
  if (!Real) return;
  const Pinned = function (opts) { return new Real({ ...(opts || {}), sampleRate: rate }); };
  Pinned.prototype = Real.prototype;
  window.AudioContext = Pinned;
  window.webkitAudioContext = Pinned;
}, RATE);

console.log(`loading ${URL} at ${RATE} Hz`);
await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForSelector('[data-a="solo"]', { timeout: 120000 });
console.log('menu ready');

await page.locator('[data-a="solo"]').first().click();
await page.waitForFunction(() => window.__overrun && window.__overrun.sim && window.__overrun.sim.players.length > 0, null, { timeout: 60000 });
console.log('match started');

const before = await page.evaluate(() => {
  const p = window.__overrun.sim.players[0];
  return { tick: window.__overrun.sim.tick, x: p.x, z: p.z };
});

// Actually play: hold a direction, fire at the middle of the screen.
await page.mouse.move(900, 300);
await page.keyboard.down('w');
await page.mouse.down();
await page.waitForTimeout(6000);
await page.mouse.up();
await page.keyboard.up('w');
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const a = window.__overrun, p = a.sim.players[0];
  return {
    tick: a.sim.tick, x: p.x, z: p.z, hp: p.hp, kills: p.kills,
    enemies: a.sim.aliveEnemies, wave: a.sim.director ? a.sim.director.wave : null,
    ctxRate: a.audio.ctx ? a.audio.ctx.sampleRate : null,
    sounds: a.audio.buffers.size, audioFailed: !!a.audio.failed
  };
});

await page.screenshot({ path: 'live-play.png' });
await browser.close();
if (server) server.close();

const ticked = after.tick > before.tick;
const moved = Math.hypot(after.x - before.x, after.z - before.z) > 0.5;
const fatal = errors.filter(e => /NotSupportedError|ConvolverNode/.test(e));
const ok = ticked && moved && after.enemies > 0 && fatal.length === 0;

console.log(JSON.stringify({ before, after, ticked, moved, errors: errors.slice(0, 5) }, null, 2));
console.log(ok ? '\nPLAYABLE' : '\nNOT PLAYABLE');
process.exit(ok ? 0 : 1);
