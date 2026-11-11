import { createVehicleFeed } from '../../shared/vehicle.js';
import { getSeat, setSeat } from '../../shared/seat.js';
import { addItem } from '../../shared/inventory.js';
import { awardMinigame } from '../../shared/loot-client.js';
import { startLootTracking } from '../../shared/loot-tracker.js';
startLootTracking();
import { getBest, saveRecord } from '../../shared/records.js';
import { ensurePassenger } from '../../shared/passenger.js';
import { sketchLine, hatchRect, drawFinger } from '../../shared/sketch.js';

const canvas = document.querySelector('#game'), ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id), dev = new URLSearchParams(location.search).get('dev') === '1';
let w = 0, h = 0, dpr = 1, feed, running = false, ended = false, lastFrame = 0, endReason = null;
let speed = 42, speedLimit = null, feedDistance = 0, worldM = 0, score = 0, cleared = 0;
let perfects = 0, combo = 0, maxCombo = 0, parts = 0, startAt = 0, jump = null, lane = 1;
let stoppedAt = 0, speeding = 0, muted = false, audio, toastTimer = 0, seed = 7139, poles = [];
let cameraX = 0, playerScreenX = 0, warningBeepAt = 0, landedAt = 0;
// World scale is intentionally modest: the standing pole must drift to the
// trailing danger edge in a few seconds, while adjacent poles remain reachable.
const REACH = 40, IDEAL = 31, PERFECT = 4.5, GAME_SPEED = 1.9;
const names = ['위쪽', '중간', '아래'];
const poleObstacles = ['표지판', '변압기', '까치집', '전단지'];
const treeObstacles = ['새둥지', '벌집', '다람쥐'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function resize() { const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2); w = r.width; h = r.height; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
new ResizeObserver(resize).observe(canvas); resize();
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function makePole(index, distance) {
  const tree = index > 10 && rand() < .25;
  const p = { index, distance, tree, height: .9 + rand() * .2, lean: (rand() - .5) * 4, obstacles: [], ground: rand() * 8 - 4, arms: 1 + Math.floor(rand() * 2) };
  if (index > 10 && rand() < .2) p.obstacles.push({ lane: Math.floor(rand() * 3), type: tree ? treeObstacles[Math.floor(rand() * treeObstacles.length)] : poleObstacles[Math.floor(rand() * poleObstacles.length)] });
  if (index > 30 && rand() < .22) p.obstacles.push({ lane: Math.floor(rand() * 3), type: tree ? treeObstacles[Math.floor(rand() * treeObstacles.length)] : poleObstacles[Math.floor(rand() * poleObstacles.length)] });
  return p;
}
function nextGap() { return 26 + rand() * 13; }
function updateHud() {
  $('score').textContent = score.toLocaleString('ko-KR'); $('combo').textContent = combo; $('parts').textContent = parts;
  $('speed').textContent = Math.round(speed); $('limit').textContent = speedLimit == null ? '제한 속도 정보 없음' : `제한 ${Math.round(speedLimit)} km/h`;
  $('height-name').textContent = names[lane];
}
function beep(f = 660, d = .1) { if (muted) return; try { audio ||= new AudioContext(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; g.gain.setValueAtTime(.055, audio.currentTime); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + d); o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + d); } catch {} }
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 850); }
function reset() {
  running = true; ended = false; endReason = null; score = cleared = perfects = combo = maxCombo = parts = feedDistance = worldM = speeding = stoppedAt = 0;
  startAt = performance.now(); lane = 1; jump = null; seed = 7139; cameraX = getSeat() === 'right' ? w * .35 : w * .65; playerScreenX = 0; landedAt = 0;
  poles = [makePole(1, 0), makePole(2, 38), makePole(3, 76), makePole(4, 114)];
  $('start').classList.add('hidden'); $('result').classList.add('hidden'); $('pause').classList.add('hidden'); updateHud(); lastFrame = performance.now(); requestAnimationFrame(frame);
}
function pxPerMeter() { return w / 60; }
function worldX(p) { return (p.distance - worldM) * pxPerMeter(); }
function screenX(p) { const direction = getSeat() === 'right' ? -1 : 1; return cameraX + direction * worldX(p); }
function playerX() { return playerScreenX || w * .32; }
function updateCamera(dt) {
  const direction = getSeat() === 'right' ? -1 : 1;
  if (jump) {
    const t = clamp((performance.now() - jump.at) / 250, 0, 1);
    const fromX = cameraX + direction * worldX(poles[0]), landingX = cameraX + direction * worldX(jump.target);
    playerScreenX = clamp(fromX + (landingX - fromX) * t, w * .04, w * .96);
    if (t >= 1) playerScreenX = landingX;
  } else {
    // Keep the camera in world space while standing. Following pole[0] here
    // cancels its world motion and makes the danger timer impossible to reach.
    playerScreenX = cameraX + direction * worldX(poles[0]);
  }
}
window.__polejump = { getState() {
  const direction = getSeat() === 'right' ? -1 : 1;
  const edge = getSeat() === 'right' ? w * .85 : w * .15;
  const nextPoleDistanceM = poles.length > 1 ? Math.abs(screenX(poles[1]) - screenX(poles[0])) / pxPerMeter() : null;
  const nextPoleScreenX = poles.length > 1 ? screenX(poles[1]) : null;
  const frontInset = getSeat() === 'right' ? w * .08 : w * .92;
  const nextPoleInWindow = nextPoleScreenX != null && (direction > 0 ? nextPoleScreenX <= frontInset : nextPoleScreenX >= frontInset) && nextPoleScreenX >= w * .03 && nextPoleScreenX <= w * .97;
  const canJump = running && !stoppedAt && !jump && performance.now() - landedAt >= 150 && nextPoleInWindow;
  return { running, score, cleared, ninjaScreenX: playerX(), dangerEdgeX: edge,
    nextPoleDistanceM, nextPoleScreenX, nextPoleInWindow, canJump,
    reachM: poles.length > 1 ? (poles[1].distance - poles[0].distance > 70 ? REACH * 2.1 : cleared < 10 ? REACH * 1.3 : REACH) : REACH, endReason };
} };
function doJump() {
  if (!running || stoppedAt || jump || poles.length < 2 || performance.now() - landedAt < 150) return;
  const direction = getSeat() === 'right' ? -1 : 1;
  const gap = poles[1].distance - poles[0].distance;
  const nextX = screenX(poles[1]), frontInset = direction > 0 ? w * .92 : w * .08;
  const inWindow = direction > 0 ? nextX <= frontInset : nextX >= frontInset;
  const backInset = direction > 0 ? w * .03 : w * .97;
  if (!inWindow || (direction > 0 ? nextX < backInset : nextX > backInset)) { finish('fall'); return; }
  const d = Math.abs(nextX - playerX()) / pxPerMeter();
  const target = poles[1], obstacle = target.obstacles.find(o => o.lane === lane);
  jump = { at: performance.now(), target, obstacle: obstacle || null, lane, d, gap };
  beep(520, .08);
}
function formatTime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function finish(reason) {
  if (ended) return; ended = true; running = false;
  endReason = reason;
  const prior = getBest('pole-jump'), durationMs = performance.now() - startAt;
  const record = saveRecord({ gameId: 'pole-jump', score, durationMs, distanceM: feedDistance, stats: { poles: cleared, perfects, maxCombo, parts }, endReason: reason });
  const isBest = !prior || record.score > prior.score;
  if (isBest) { try { const skins = JSON.parse(localStorage.getItem('zride.skins') || '[]'); if (!skins.includes('ninja_gold')) skins.push('ninja_gold'); localStorage.setItem('zride.skins', JSON.stringify(skins)); } catch {} }
  $('final-score').textContent = score.toLocaleString('ko-KR'); $('final-poles').textContent = cleared; $('final-combo').textContent = maxCombo; $('final-perfects').textContent = perfects;
  $('final-time').textContent = formatTime(durationMs); $('final-parts').textContent = parts;
  awardMinigame('pole-jump',{score,poles:cleared}).then(out=>{const line=document.createElement('p');line.textContent=`획득 아이템: ${(out.items||[]).map(x=>x.name).join(', ')||'없음'}`;$('result').append(line);});
  $('reason').textContent = ({ fall: '다음 발판까지 닿지 못했어요.', pushed_out: '위험 구역 끝에 도달했어요.', obstacle: '착지한 발판에 장애물이 있었어요.', speeding: '과속 상태가 계속됐어요.' })[reason];
  $('result-title').textContent = reason === 'speeding' ? '과속 감지!' : '모험 종료'; $('best-badge').classList.toggle('hidden', !isBest); $('result').classList.remove('hidden'); if (reason === 'speeding') beep(180, .3);
}
function laneMove(d) { if (!running || stoppedAt || jump) return; lane = clamp(lane - d, 0, 2); updateHud(); }
function completeJump() {
  if (!jump) return;
  if (jump.obstacle) { jump = null; draw(performance.now()); finish('obstacle'); return; }
  cleared++; score += 10;
  const isPerfect = Math.abs(jump.d - IDEAL) <= (cleared <= 10 ? PERFECT * 1.4 : PERFECT);
  if (isPerfect) { combo++; perfects++; maxCombo = Math.max(maxCombo, combo); score += 5 * Math.min(combo, 5); toast('완벽 착지!'); beep(880, .12); }
  else { combo = 0; toast('착지 +10'); beep(620, .08); }
  poles.shift(); const last = poles.at(-1); poles.push(makePole(last.index + 1, last.distance + nextGap()));
  if (cleared && cleared % 10 === 0) { parts++; addItem('part', 1, { from: 'pole-jump' }); toast('+1 부품'); }
  jump = null; landedAt = performance.now(); playerScreenX = screenX(poles[0]); updateHud();
}
function frame(now) {
  if (!running) return;
  const dt = Math.min((now - lastFrame) / 1000, .06); lastFrame = now;
  if (speed < 3) { if (!stoppedAt) stoppedAt = now; $('pause').classList.remove('hidden'); } else { stoppedAt = 0; $('pause').classList.add('hidden'); }
  if (speedLimit != null && speed > speedLimit) { speeding += dt; document.body.classList.add('speeding'); if (Math.floor(speeding * 3) !== Math.floor((speeding - dt) * 3)) beep(850, .05); if (speeding >= 2) { draw(now); finish('speeding'); return; } } else { speeding = 0; document.body.classList.remove('speeding'); }
  if (!stoppedAt) {
    const speedFactor = cleared < 5 ? .8 + .2 * (cleared / 5) : cleared >= 30 ? 1.15 : 1;
    worldM += speed / 3.6 * GAME_SPEED * speedFactor * dt; updateCamera(dt);
    const edge = getSeat() === 'right' ? w * .85 : w * .15;
    const endangered = getSeat() === 'right' ? playerX() > edge : playerX() < edge;
    const outEdge = getSeat() === 'right' ? w * .97 : w * .03;
    const pushedOut = getSeat() === 'right' ? playerX() > outEdge : playerX() < outEdge;
    if (endangered && now - warningBeepAt > 420) { warningBeepAt = now; beep(980, .07); }
    if (pushedOut) { draw(now); finish('pushed_out'); return; }
    if (jump && now - jump.at >= 250) completeJump();
  }
  updateHud(); draw(now); requestAnimationFrame(frame);
}
function yLevel(ln, top, bottom) { return top + (ln + 1) * (bottom - top) / 4; }
function drawTree(x, base, top, p) {
  const stemX = x + p.lean;
  sketchLine(ctx, stemX - 5, base, stemX - 2, top + 20, { seed: p.index, width: 3 });
  sketchLine(ctx, stemX + 5, base, stemX + 2, top + 20, { seed: p.index + 1, width: 3 });
  ctx.save(); ctx.strokeStyle = '#171717'; ctx.lineWidth = 2;
  const blobs = [[stemX - 13, top + 17, 17], [stemX + 6, top + 11, 20], [stemX - 3, top - 3, 19], [stemX + 20, top + 18, 14]];
  for (const [cx, cy, r] of blobs) { ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * .12, Math.PI * 1.85); ctx.stroke(); }
  for (let ln = 0; ln < 3; ln++) { const y = yLevel(ln, top, base); sketchLine(ctx, stemX, y, stemX + 20, y - 3, { seed: p.index + ln, width: 2.4 }); }
  ctx.restore();
}
function drawPole(x, top, base, p) {
  const widthBottom = 12, widthTop = 6, lean = p.lean;
  sketchLine(ctx, x - widthBottom / 2, base, x - widthTop / 2 + lean, top, { seed: p.index, width: 2.5 });
  sketchLine(ctx, x + widthBottom / 2, base, x + widthTop / 2 + lean, top, { seed: p.index + 4, width: 2.5 });
  sketchLine(ctx, x - widthBottom / 2, base, x + widthBottom / 2, base, { seed: p.index + 7, width: 2 });
  sketchLine(ctx, x - 10, base + 3, x + 10, base + 3, { seed: p.index + 8, width: 1.3 });
  for (let a = 0; a < p.arms; a++) {
    const ay = top + 17 + a * 17, ax = x + lean * .4;
    sketchLine(ctx, ax - 23, ay, ax + 23, ay, { seed: p.index + a, width: 2.5 });
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(ax - 15 + k * 15, ay - 4, 3, Math.PI, 0); ctx.strokeStyle = '#171717'; ctx.lineWidth = 1.4; ctx.stroke(); }
  }
  for (let ln = 0; ln < 3; ln++) { const y = yLevel(ln, top, base); sketchLine(ctx, x + 3, y, x + 21, y, { seed: p.index + ln, width: 2.4 }); }
}
function drawObstacle(x, y, type, index) {
  ctx.save(); ctx.strokeStyle = '#171717'; ctx.lineWidth = 1.7;
  if (type === '변압기') { ctx.strokeRect(x - 17, y - 24, 24, 20); hatchRect(ctx, x - 16, y - 23, 22, 18, 5, '#666'); }
  else if (type === '표지판') { ctx.strokeRect(x - 18, y - 25, 26, 18); ctx.beginPath(); ctx.moveTo(x - 13, y - 19); ctx.lineTo(x + 3, y - 19); ctx.moveTo(x - 13, y - 14); ctx.lineTo(x, y - 14); ctx.stroke(); }
  else if (type === '까치집') { for (let k = 0; k < 5; k++) sketchLine(ctx, x - 16 + k * 5, y - 13 - Math.sin(k) * 4, x + 3 - k * 2, y - 22 + Math.cos(k) * 6, { seed: index + k, width: 1.5 }); }
  else if (type === '전단지' || type === '다람쥐') { ctx.beginPath(); ctx.arc(x - 6, y - 16, 9, Math.PI * 1.2, Math.PI * .4); ctx.stroke(); sketchLine(ctx, x - 6, y - 8, x + 5, y - 8, { seed: index, width: 2 }); }
  else if (type === '새둥지') { for (let k = 0; k < 4; k++) sketchLine(ctx, x - 12 + k * 3, y - 13, x + 7 - k * 3, y - 17 + k * 2, { seed: index + k, width: 1.4 }); }
  else { ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3, xx = x - 5 + Math.cos(a) * 8, yy = y - 16 + Math.sin(a) * 8; k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); } ctx.closePath(); ctx.stroke(); }
  ctx.restore();
}
function draw(now) {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  const horizon = h * .57, top = h * .15, base = h * .78, direction = getSeat() === 'right' ? -1 : 1;
  const drift = (worldM * pxPerMeter() * .08 * direction) % w;
  ctx.fillStyle = '#fafaf7'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, horizon * .38); ctx.quadraticCurveTo(w * .62, horizon * .07, 0, horizon * .14); ctx.closePath(); ctx.fill();
  hatchRect(ctx, 0, 0, w, horizon * .16, 11, '#aaa');
  sketchLine(ctx, 0, horizon * .14, w * .72, horizon * .23, { seed: 1, width: 3 }); sketchLine(ctx, w * .72, horizon * .23, w, horizon * .38, { seed: 2, width: 4 });
  // Distant mountain ridges drift independently of the poles.
  if (Math.sin(worldM / 115) > .55) { sketchLine(ctx, w * .05, horizon * .44, w * .2, horizon * .28, { seed: 91, width: 1.3, color: '#777' }); sketchLine(ctx, w * .2, horizon * .28, w * .34, horizon * .44, { seed: 92, width: 1.3, color: '#777' }); }
  const terrain = Math.sin(worldM / 18) * 3 + Math.sin(worldM / 7) * 1.5;
  sketchLine(ctx, 0, horizon + terrain, w, horizon + terrain + Math.sin(worldM / 29) * 2, { seed: 3, width: 1.5 });
  for (let i = 0, x = ((drift % 53) + 53) % 53; x < w + 20; i++, x += 33 + ((i * 37) % 28)) { sketchLine(ctx, x, horizon + 3, x - 4, horizon - 5, { seed: i, width: 1 }); sketchLine(ctx, x, horizon + 3, x + 5, horizon - 3, { seed: i + 17, width: 1 }); }
  sketchLine(ctx, 0, h * .79, w, h * .79, { seed: 4, width: 3 }); sketchLine(ctx, 0, h * .82, w, h * .82, { seed: 5, width: 1.5 }); sketchLine(ctx, 0, h * .87, w, h * .87, { seed: 6, width: 1.5 });
  // Screen edge warning zone is on the trailing side of travel.
  const dangerW = w * .15, dangerX = direction > 0 ? 0 : w - dangerW;
  ctx.fillStyle = 'rgba(30,30,30,.08)'; ctx.fillRect(dangerX, top, dangerW, base - top); hatchRect(ctx, dangerX, top, dangerW, base - top, 9, '#777');
  sketchLine(ctx, direction > 0 ? dangerW : w - dangerW, top, direction > 0 ? dangerW : w - dangerW, base, { seed: 77, width: 2.2 });
  // Wires connect only neighboring poles, and sag varies by span.
  for (let i = 0; i < poles.length - 1; i++) { const a = poles[i], b = poles[i + 1]; if (a.tree || b.tree) continue; const x1 = screenX(a), x2 = screenX(b), y = top + 23;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.quadraticCurveTo((x1 + x2) / 2, y + 8 + ((a.index * 13) % 13), x2, y); ctx.strokeStyle = '#555'; ctx.lineWidth = 1.2; ctx.stroke(); }
  poles.forEach((p, i) => {
    const x = screenX(p); if (x < -60 || x > w + 60) return;
    const pTop = base - (base - top) * .8 * p.height, pBase = base + p.ground * .25;
    if (p.tree) drawTree(x, pBase, pTop, p); else drawPole(x, pTop, pBase, p);
    for (const obstacle of p.obstacles) drawObstacle(x, yLevel(obstacle.lane, pTop, pBase), obstacle.type, p.index);
  });
  let nx = playerX(), ny = yLevel(lane, top, base);
  if (jump) { const t = clamp((now - jump.at) / 250, 0, 1); ny -= Math.sin(t * Math.PI) * 48; }
  drawFinger(ctx, nx, ny + Math.sin(now / 85), 1.1);
  if (speedLimit != null && speed > speedLimit) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, 32); ctx.fillStyle = '#fff'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center'; ctx.fillText('과속 — STOP', w / 2, 21); ctx.strokeStyle = '#111'; ctx.lineWidth = 5; ctx.strokeRect(3, 3, w - 6, h - 6); }
  drawLowerHud();
}
function drawLowerHud() {
  const top = h * .9, third = w / 3; ctx.strokeStyle = '#171717'; ctx.lineWidth = 1.2; ctx.textAlign = 'left'; ctx.font = '10px system-ui'; ctx.fillStyle = '#171717';
  for (let i = 0; i < 3; i++) ctx.strokeRect(i * third + 4, top, third - 8, h * .085);
  ctx.fillText('획득 아이템', 10, top + 12); for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(22 + i * 22, top + 29, 7, 0, Math.PI * 2); ctx.stroke(); if (i < Math.min(3, parts)) { ctx.beginPath(); ctx.arc(22 + i * 22, top + 29, 2.5, 0, Math.PI * 2); ctx.fill(); } }
  ctx.fillText('이벤트', third + 10, top + 12); ctx.font = '9px system-ui'; const target = poles[1]; const event = target?.tree ? '나무' : target?.obstacles?.[0]?.type || '-'; ctx.fillText(event, third + 10, top + 31);
  ctx.fillText('시속', third * 2 + 10, top + 12); ctx.font = 'bold 17px ui-monospace'; ctx.fillText(Math.round(speed) + '', third * 2 + 10, top + 35); ctx.font = '8px system-ui'; ctx.fillText(speedLimit == null ? '제한 —' : '제한 ' + Math.round(speedLimit), third * 2 + 10, top + 47);
}
function onFeed(v) { speed = v.speedKmh; speedLimit = v.speedLimitKmh; feedDistance += Number(v.distanceDeltaM) || 0; updateHud(); }
function ensureSeat() { if (getSeat()) return; setSeat(confirm('오른쪽 좌석인가요?\n확인: 오른쪽 / 취소: 왼쪽') ? 'right' : 'left'); }
document.querySelector('#start-button').addEventListener('click', async () => { if (!await ensurePassenger()) return; ensureSeat(); if (!feed) { feed = createVehicleFeed({ dev }); feed.on('update', onFeed); } audio?.resume(); reset(); });
$('again').addEventListener('click', reset); $('jump').addEventListener('click', doJump); $('up').addEventListener('click', () => laneMove(1)); $('down').addEventListener('click', () => laneMove(-1));
$('mute').addEventListener('click', e => { muted = !muted; e.currentTarget.textContent = muted ? 'OFF' : 'ON'; });
window.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); doJump(); } if (e.code === 'ArrowUp') { e.preventDefault(); laneMove(1); } if (e.code === 'ArrowDown') { e.preventDefault(); laneMove(-1); } });
let touchY = null; canvas.addEventListener('touchstart', e => touchY = e.touches[0].clientY, { passive: true });
canvas.addEventListener('touchend', e => { if (touchY == null) return; const d = e.changedTouches[0].clientY - touchY; if (Math.abs(d) > 24) laneMove(d < 0 ? 1 : -1); else doJump(); touchY = null; }, { passive: true });
// Pleos integration point: forward NaviHelper onCurrentRoadSpeedLimit() and onDrivingInfo() to the server, which relays them over /vehicle WebSocket.
