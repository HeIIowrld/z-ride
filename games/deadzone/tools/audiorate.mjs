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

/* Regression test for the bug that made the game unstartable on any device
   whose audio hardware does not run at 44.1 kHz.

   Every sound, including the reverb impulse response, was synthesised at a
   hard-coded 44100. AudioBufferSourceNode resamples a mismatched buffer and
   says nothing; ConvolverNode throws NotSupportedError. Audio init is awaited
   before a match starts, so that throw stopped the game dead — reproducibly,
   on 48 kHz and 96 kHz output, which is most hardware sold this decade.

   This forces the context rate to each of the common values, presses SOLO, and
   asserts the match actually starts. Run it against a built dist:

       npm run build && node tools/audiorate.mjs                             */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const DIST = resolve('packages/client/dist');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

const server = createServer(async (req, res) => {
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
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required']
});

let failures = 0;

// The last case is not a rate at all: it is an audio stack that refuses to
// start. The game must still be playable, silently. That is the invariant the
// original bug violated, and rates are only one way to violate it.
for (const rate of [44100, 48000, 96000, 'hostile']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // Pin the context rate the way a sound card would. Chrome honours the
  // sampleRate option, so this is the real code path, not a stub.
  await page.addInitScript(rateValue => {
    if (rateValue === 'hostile') {
      const Broken = function () { throw new Error('simulated: audio hardware unavailable'); };
      window.AudioContext = Broken;
      window.webkitAudioContext = Broken;
      return;
    }
    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) return;
    const Pinned = function (opts) { return new Real({ ...(opts || {}), sampleRate: rateValue }); };
    Pinned.prototype = Real.prototype;
    window.AudioContext = Pinned;
    window.webkitAudioContext = Pinned;
  }, rate);

  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#menu') && !document.querySelector('#boot.on'), null, { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(2000);

  await page.waitForSelector('[data-a="solo"]', { timeout: 30000 });
  await page.locator('[data-a="solo"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => {
    const app = window.__overrun;
    return {
      players: app && app.sim && app.sim.players ? app.sim.players.length : 0,
      tick: app && app.sim ? app.sim.tick : null,
      ctxRate: app && app.audio && app.audio.ctx ? app.audio.ctx.sampleRate : null,
      sounds: app && app.audio && app.audio.buffers ? app.audio.buffers.size : null,
      reverb: !!(app && app.audio && app.audio.convolver)
    };
  });

  const started = state.players > 0;
  const fatal = errors.filter(e => /NotSupportedError|ConvolverNode/.test(e));
  const ok = started && fatal.length === 0;
  if (!ok) failures++;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(rate).padEnd(8)} ` + JSON.stringify({ ...state, errors: errors.slice(0, 3) }));
  await page.close();
}

await browser.close();
server.close();

console.log(failures ? `\n${failures} case(s) failed` : '\nevery case starts a match');
process.exit(failures ? 1 : 0);
