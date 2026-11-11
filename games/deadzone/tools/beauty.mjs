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

/* Staged capture for the landing page.

   The regular smoke test plays the game honestly, which means it mostly
   photographs an empty arena between spawns. This one stages the moment you
   actually want on a store page: a real fight, mid-combo, with the arena full.
   Everything it does goes through the simulation's own API — nothing is faked
   into the renderer. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOT_DIR || 'shots/press';
mkdirSync(OUT, { recursive: true });
const W = +(process.env.W || 1600), H = +(process.env.H || 900);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto((process.env.BASE || 'http://localhost:4173') + '/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => window.__overrun && window.__overrun.state === 'title', { timeout: 60000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/00-title.png` });

async function stage(mode, setup, hold = 2200) {
  await page.evaluate((m) => window.__overrun.startLocal(m), mode);
  await page.waitForFunction(() => window.__overrun.state === 'play', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(setup);
  await page.waitForTimeout(hold);
}

// 1 — co-op, deep wave, the arena full and the combo ladder lit
await stage('coop', () => {
  const a = window.__overrun, s = a.sim;
  s.director.wave = 14;
  for (let i = 0; i < 4; i++) a.sim.applyUpgrade(a.me, 'dmg');
  a.sim.applyUpgrade(a.me, 'w1');
  a.sim.grantAbility(a.me, 'shock', 0);
  a.sim.grantAbility(a.me, 'turret', 1);
  a.me.combo = 9; a.me.comboT = 3;
  a.run.score = 128400;
  const kinds = ['rusher','rusher','rusher','shard','shard','bruiser','spitter','stalker','splitter','sapper','warden','elite'];
  for (let i = 0; i < 44; i++) {
    const ang = Math.random() * Math.PI * 2;
    const d = 9 + Math.random() * 26;
    s.spawnEnemy(kinds[i % kinds.length], a.me.x + Math.cos(ang) * d, a.me.z + Math.sin(ang) * d);
  }
  a.me.input.fire = true;
  a.ui.banner('WAVE 14', 'THEY LEARN');
}, 2600);
await page.screenshot({ path: `${OUT}/01-coop-swarm.png` });

// 2 — the same fight a beat later, mid-explosion
await page.evaluate(() => {
  const a = window.__overrun;
  a.sim.explode(a.me.x + 7, a.me.z - 5, 8, 90, false, a.me);
  a.sim.explode(a.me.x - 9, a.me.z + 3, 6, 70, false, a.me);
  a.me.input.fire = true;
});
await page.waitForTimeout(180);
await page.screenshot({ path: `${OUT}/02-explosion.png` });

// 3 — a boss
await stage('coop', () => {
  const a = window.__overrun, s = a.sim;
  s.director.wave = 20;
  const e = s.spawnEnemy('boss', a.me.x + 12, a.me.z - 10);
  if (e) e.spawnT = 0;
  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2;
    s.spawnEnemy('rusher', a.me.x + Math.cos(ang) * (12 + Math.random() * 16), a.me.z + Math.sin(ang) * (12 + Math.random() * 16));
  }
  a.me.input.fire = true;
  a.ui.banner('CHAMPION', 'WAVE 20');
}, 2800);
await page.screenshot({ path: `${OUT}/03-boss.png` });

// 4 — team deathmatch, everyone alive and shooting
await stage('tdm', () => {
  const a = window.__overrun;
  a.sim.teamScore[0] = 22; a.sim.teamScore[1] = 19;
  for (const p of a.sim.players) { p.kills = 3 + ((Math.random() * 8) | 0); p.deaths = (Math.random() * 6) | 0; }
  // Pull the other team into frame so the shot shows a fight, not a lobby.
  let i = 0;
  for (const p of a.sim.players) {
    if (p === a.me) continue;
    const ang = (i++ / 7) * Math.PI * 2;
    p.x = a.me.x + Math.cos(ang) * (9 + (i % 3) * 4);
    p.z = a.me.z + Math.sin(ang) * (9 + (i % 3) * 4);
  }
  a.me.input.fire = true;
}, 2400);
await page.screenshot({ path: `${OUT}/04-tdm.png` });

// 5 — squad royale with the ring closing
await stage('squad', () => {
  const a = window.__overrun;
  a.sim.matchTime = a.sim.mode.timeLimit * 0.93;
  a.sim.teamScore[0] = 14; a.sim.teamScore[1] = 11; a.sim.teamScore[2] = 9; a.sim.teamScore[3] = 6;
  let i = 0;
  for (const p of a.sim.players) {
    if (p === a.me) continue;
    const ang = (i++ / 7) * Math.PI * 2;
    p.x = a.me.x + Math.cos(ang) * (7 + (i % 3) * 5);
    p.z = a.me.z + Math.sin(ang) * (7 + (i % 3) * 5);
  }
  a.me.input.fire = true;
}, 2400);
await page.screenshot({ path: `${OUT}/05-squad.png` });

// 6 — the upgrade choice, which is the loop's other half
await page.evaluate(() => {
  const a = window.__overrun;
  a.startLocal('coop');
});
await page.waitForFunction(() => window.__overrun.state === 'play', { timeout: 20000 });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const a = window.__overrun;
  a.sim.director.wave = 7;
  a.state = 'choice';
  const cards = window.__overrunOffer ? window.__overrunOffer() : null;
  a.checkLocalFlow && (a.sim.director.phase = 'choice', a.checkLocalFlow());
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/06-upgrades.png` });

// 7 — portrait-ish mobile framing, to prove the HUD adapts
await page.setViewportSize({ width: 844, height: 390 });
await page.evaluate(() => { window.__overrun.stage.resize(); window.__overrun.startLocal('coop'); });
await page.waitForFunction(() => window.__overrun.state === 'play', { timeout: 20000 });
await page.waitForTimeout(700);
await page.evaluate(() => {
  const a = window.__overrun, s = a.sim;
  s.director.wave = 9;
  a.me.combo = 6; a.me.comboT = 3; a.run.score = 41200;
  for (let i = 0; i < 26; i++) {
    const ang = Math.random() * Math.PI * 2;
    s.spawnEnemy(['rusher','shard','spitter','stalker','bruiser'][i % 5], a.me.x + Math.cos(ang) * (8 + Math.random() * 20), a.me.z + Math.sin(ang) * (8 + Math.random() * 20));
  }
  a.me.input.fire = true;
});
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/07-mobile.png` });

console.log('errors:', errors.slice(0, 8));
await browser.close();
