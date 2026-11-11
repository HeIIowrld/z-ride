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

/* Headless capture harness.

   Runs the built game in Chromium with software WebGL, drives it through real
   input, and writes screenshots. This is how the game gets looked at without
   a human in the loop — and it doubles as a smoke test, because a page that
   throws never reaches the first screenshot. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOT_DIR || 'shots';
mkdirSync(OUT, { recursive: true });

const W = +(process.env.W || 1280), H = +(process.env.H || 720);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required'
  ]
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

const base = process.env.BASE || 'http://localhost:4173';
await page.goto(base + '/?debug', { waitUntil: 'networkidle', timeout: 45000 });

// Wait for the boot sequence to finish rather than guessing at a delay.
await page.waitForFunction(() => window.__overrun && window.__overrun.state === 'title', { timeout: 60000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-title.png` });

// Start a solo co-op run through the actual UI, not through an internal API,
// so the click path is exercised too.
await page.evaluate(() => {
  const cards = document.querySelectorAll('#modeGrid .mode');
  cards[0].querySelector('[data-a="solo"]').click();
});
await page.waitForFunction(() => window.__overrun.state === 'play', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/02-arena.png` });

// Drive it: move, aim, fire, dash. The bot-free player needs real input.
async function play(seconds, opts = {}) {
  const t0 = Date.now();
  await page.mouse.move(W * 0.7, H * 0.4);
  await page.keyboard.down('KeyD');
  if (opts.fire !== false) await page.mouse.down();
  let i = 0;
  while (Date.now() - t0 < seconds * 1000) {
    i++;
    await page.mouse.move(W * (0.5 + Math.cos(i * 0.3) * 0.3), H * (0.5 + Math.sin(i * 0.3) * 0.25));
    if (i % 12 === 0) await page.keyboard.press('Space');
    if (i % 40 === 0) { await page.keyboard.up('KeyD'); await page.keyboard.down('KeyA'); }
    if (i % 40 === 20) { await page.keyboard.up('KeyA'); await page.keyboard.down('KeyD'); }
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyA');
}

await play(12);
await page.screenshot({ path: `${OUT}/03-combat.png` });

await play(20);
await page.screenshot({ path: `${OUT}/04-fight.png` });

const stats = await page.evaluate(() => {
  const a = window.__overrun;
  return {
    state: a.state,
    wave: a.sim.director.wave,
    enemies: a.sim.aliveEnemies,
    kills: a.me ? a.me.kills : 0,
    hp: a.me ? Math.round(a.me.hp) : 0,
    score: a.run.score,
    tier: a.stage.tier,
    frameMs: +a.lastFrameMs.toFixed(2),
    draws: a.stage.info.render.calls,
    tris: a.stage.info.render.triangles,
    combo: a.me ? a.me.combo : 0
  };
});

// PvP: bots make it look like a match without a second browser.
await page.evaluate(() => window.__overrun.startLocal('tdm'));
await page.waitForFunction(() => window.__overrun.state === 'play', { timeout: 20000 });
await page.waitForTimeout(2500);
await play(10);
await page.screenshot({ path: `${OUT}/05-tdm.png` });

const pvp = await page.evaluate(() => {
  const a = window.__overrun;
  return { players: a.sim.players.length, teamScore: a.sim.teamScore, frameMs: +a.lastFrameMs.toFixed(2) };
});

console.log(JSON.stringify({ stats, pvp, errors: errors.slice(0, 12) }, null, 2));
await browser.close();
