import '../../shared/game-signs.js';
import { inJourney, inRouteSign, crewHasItem, notifyJourneyReady, returnToJourney } from '../../shared/journey.js';
import { createVehicleFeed } from '../../shared/vehicle.js';
import { getSeat, setSeat } from '../../shared/seat.js';
import { addItem } from '../../shared/inventory.js';
import { presentMinigameReward } from '../../shared/loot-client.js';
import { startLootTracking } from '../../shared/loot-tracker.js';
startLootTracking();
import { getBest, saveRecord } from '../../shared/records.js';
import { ensurePassenger } from '../../shared/passenger.js';
import { sketchLine, hatchRect, drawRunner, drawFingerWalker, poleJumpHandGeometry } from '../../shared/sketch.js';
import { HOP_MS, SCROLL_MULTIPLIER, STANDING_ZONE_RATIO, LANDING_TOLERANCE_RATIO, HAND_X_RATIO, FOOTHOLD_LENGTH, poleGeometry, wireCurves, landingOutcome, standingOutcome } from './logic.js';
import { travelDir, frontEdgeX, rearEdgeX } from '../../shared/motion.js';
import { createScenery } from '../../shared/scenery.js';
import { drawWindowFrame, traceWindow } from '../../shared/window-frame.js';
import { mountDoorHud, findLayoutOverlaps } from '../../shared/door-hud.js';

const canvas = document.querySelector('#game'), ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id), dev = new URLSearchParams(location.search).get('dev') === '1';
let w = 0, h = 0, dpr = 1, feed, running = false, ended = false, lastFrame = 0, endReason = null;
let speed = 40, speedLimit = null, feedDistance = 0, worldM = 0, score = 0, cleared = 0;
let perfects = 0, combo = 0, maxCombo = 0, parts = 0, startAt = 0, jump = null, lane = 1;
let stoppedAt = 0, speeding = 0, muted = false, audio, toastTimer = 0, seed = 7139, poles = [];
let cameraX = 0, playerScreenX = 0, warningBeepAt = 0, landedAt = 0;
let introRemaining = 0, tutorial = false, tutorialStep = 0, tutorialAttempts = 0;
const devAutostart = new URLSearchParams(location.search).get('dev') === '1' && new URLSearchParams(location.search).get('autostart') === '1';
const demoMode = devAutostart && new URLSearchParams(location.search).get('demo') === '1';
const devPose = devAutostart ? new URLSearchParams(location.search).get('pose') : null;
const character = new URLSearchParams(location.search).get('char') === 'runner' ? 'runner' : 'hand';
// World scale is intentionally modest: the standing pole must drift to the
// trailing danger edge in a few seconds, while adjacent poles remain reachable.
const REACH = 40, IDEAL = 31, PERFECT = 4.5, GAME_SPEED = 1.9 * SCROLL_MULTIPLIER;
const INTRO_SECONDS = 2.4, FIRST_JUMP_SPEED = 36;
const names = ['위쪽', '중간', '아래'];
const poleObstacles = ['표지판', '변압기', '까치집', '전단지'];
const treeObstacles = ['새둥지', '벌집', '다람쥐'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const scenery = createScenery({ seed: 7139 });
const sceneOverride = new URLSearchParams(location.search).get('scene');
if (['day', 'dusk', 'night'].includes(sceneOverride)) scenery.setTimeOfDay(sceneOverride);

const doorHud = mountDoorHud(document.querySelector('.stage'), { game: 'pole-jump', controls: [{ id: 'up', icon: 'up', label: '위' }, { id: 'down', icon: 'down', label: '아래' }, { id: 'jump', icon: 'jump', label: '점프', primary: true }], items: [{ id: 'part', count: 0 }, { id: 'gear-tires-a', count: 0 }, { id: 'medkit', count: 0 }] });
function resize() { const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2); w = r.width; h = r.height; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
new ResizeObserver(resize).observe(canvas); resize();
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function makePole(index, distance) {
  if (!Number.isFinite(index) || !Number.isFinite(distance)) throw new Error('Invalid pole geometry');
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
  doorHud.update({ score, combo, status: poles[1]?.tree ? '나무' : poles[1]?.obstacles?.[0]?.type || '다음 전봇대', mode: '주행', speed, limit: speedLimit, items: [{ count: parts }, { count: 0 }, { count: 0 }] });
}
function beep(f = 660, d = .1) { if (muted) return; try { audio ||= new AudioContext(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; g.gain.setValueAtTime(.055, audio.currentTime); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + d); o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + d); } catch {} }
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 850); }
// ---- Model (single source of truth) ----------------------------------------
// The hand rests at a fixed place on the window. Poles sweep past from the front
// edge to the rear edge. The hand rides the pole it stands on for at most ZONE_M
// metres; a tap makes it hop up in place and it comes down on the next pole when
// that pole arrives under the resting place.
const ZONE_M = 20, MAX_AIR_M = 26, PERFECT_RIDE_M = 11;
let passed = [];
function handBaseX() { return frontEdgeX(w, getSeat()) === 0 ? w * .34 : w * .66; }
function rideM() { return poles.length ? worldM - poles[0].distance : 0; }
function arrivalM() { return poles.length > 1 ? poles[1].distance - worldM : Infinity; }
function fillPoles() { let guard = 0; while (poles.length < 7 && guard++ < 20) { const last = poles.at(-1); poles.push(makePole(last.index + 1, last.distance + nextGap())); } }
function reset() {
  running = true; ended = false; endReason = null; score = cleared = perfects = combo = maxCombo = parts = feedDistance = worldM = speeding = stoppedAt = 0;
  $('finish-run').classList.add('hidden');
  startAt = performance.now(); lane = 1; jump = null; seed = 7139; landedAt = 0; passed = [];
  let played = 0; try { played = Number(localStorage.getItem('zride.polejump.games') || 0); } catch {}
  tutorial = !inRouteSign && !devAutostart && played < 3; tutorialStep = 0; tutorialAttempts = 0;
  if (tutorial) { try { localStorage.setItem('zride.polejump.games', String(played + 1)); } catch {} }
  introRemaining = devAutostart ? 0 : INTRO_SECONDS;
  poles = [makePole(1, 0)]; fillPoles();
  if (devPose) {
    lane = ({ stand1: 0, stand2: 1, stand3: 2 })[devPose] ?? 1; tutorial = false; introRemaining = 0; worldM = 5;
    if (devPose === 'hop') { const air0 = poles[1].distance - worldM; worldM += air0 * .5; jump = { air0, startRide: 5, lane, perfect: false }; }
  }
  $('jump').disabled = introRemaining > 0;
  showJumpHint(tutorial ? '연습 1/3 · 다음 전봇대가 가까워지면 탭해요' : '다음 전봇대가 가까워지면 점프');
  $('start').classList.add('hidden'); $('result').classList.add('hidden'); $('pause').classList.add('hidden'); updateHud(); lastFrame = performance.now();
  if (devPose) { draw(performance.now()); setInterval(() => draw(performance.now()), 250); } else requestAnimationFrame(frame);
}
function pxPerMeter() { return w / 60; }
function screenX(p) { return handBaseX() + travelDir(getSeat()) * (worldM - p.distance) * pxPerMeter(); }
function playerX() { return handBaseX(); }
function targetVisible() { return arrivalM() <= MAX_AIR_M; }
function showJumpHint(text) {
  const hint = $('jump-hint');
  hint.hidden = !text;
  if (text !== hint.textContent) hint.textContent = text;
}
window.__polejump = { getState() {
  const edge = handBaseX() + travelDir(getSeat()) * ZONE_M * pxPerMeter();
  const nextPoleDistanceM = poles.length > 1 ? arrivalM() : null;
  const nextPoleScreenX = poles.length > 1 ? screenX(poles[1]) : null;
  const nextPoleInWindow = nextPoleScreenX != null && targetVisible();
  const canJump = running && !introRemaining && !stoppedAt && !jump && performance.now() - landedAt >= 150 && nextPoleInWindow;
  const handX = playerX(), standingZone = w * STANDING_ZONE_RATIO, landingTolerance = w * LANDING_TOLERANCE_RATIO;
  const geo = poles[0] ? poleGeometry(poles[0], screenX(poles[0]), h*.11, h*.57) : null;
  const peg = geo?.footholds[lane];
  const standPose = devPose?.startsWith('stand');
  const onFoothold = !!(peg && !jump);
  const contactX = peg?.x ?? handX, contactY = peg?.y ?? null;
  const contacts = peg ? [{ x: peg.x - travelDir(getSeat()) * 4.5, y: peg.y }, { x: peg.x + travelDir(getSeat()) * 4.5, y: peg.y }] : [];
  const handGeometry = peg ? poleJumpHandGeometry(peg, { direction: travelDir(getSeat()) }) : null;
  return { running, rideM: rideM(), arrivalM: arrivalM(), poleCount: poles.length, jumping: !!jump, intro: introRemaining > 0, tutorial, tutorialStep, score, cleared, character, contacts, handX, standingZone, landingTolerance, onFoothold, contactX, contactY, pegX: peg?.x ?? null, pegY: peg?.y ?? null, wrist: handGeometry?.wrist ?? null, elbow: handGeometry?.elbow ?? null, forearm: handGeometry?.forearm ?? null, dangerEdgeX: edge,
    nextPoleDistanceM, nextPoleScreenX, nextPoleInWindow, canJump,
    reachM: poles.length > 1 ? (poles[1].distance - poles[0].distance > 70 ? REACH * 2.1 : cleared < 10 ? REACH * 1.3 : REACH) : REACH, endReason, sceneryOffsetM: scenery.distance };
} };
window.__layoutCheck=()=>findLayoutOverlaps(document.querySelector('.stage'),'.door-hud,#toast,#jump-hint');
function doJump() {
  if (!running || introRemaining || stoppedAt || jump || poles.length < 2) return;
  const air0 = arrivalM();
  if (air0 > MAX_AIR_M) {
    if (tutorial) { tutorialAttempts++; toast('조금만 더 기다렸다가 탭해요'); return; }
    if (cleared === 0) { toast('다음 전봇대가 더 가까워지면!'); return; }
    draw(performance.now()); finish('fall'); return;
  }
  jump = { air0: Math.max(air0, .5), startRide: rideM(), lane, perfect: rideM() >= PERFECT_RIDE_M - (crewHasItem('jump-grip') ? 2 : 0) };
  beep(520, .08);
}
function formatTime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function finish(reason) {
  if (ended) return; ended = true; running = false;
  showJumpHint('');
  $('finish-run').classList.add('hidden');
  endReason = reason;
  const prior = getBest('pole-jump'), durationMs = performance.now() - startAt;
  const record = saveRecord({ gameId: 'pole-jump', score, durationMs, distanceM: feedDistance, stats: { poles: cleared, perfects, maxCombo, parts }, endReason: reason });
  const isBest = !prior || record.score > prior.score;
  if (isBest) { try { const skins = JSON.parse(localStorage.getItem('zride.skins') || '[]'); if (!skins.includes('ninja_gold')) skins.push('ninja_gold'); localStorage.setItem('zride.skins', JSON.stringify(skins)); } catch {} }
  $('final-score').textContent = score.toLocaleString('ko-KR'); $('final-poles').textContent = cleared; $('final-combo').textContent = maxCombo; $('final-perfects').textContent = perfects;
  $('final-time').textContent = formatTime(durationMs); $('final-parts').textContent = parts;
  const again = $('again');
  again.disabled = true;
  again.dataset.return = '';
  again.textContent = '다시 도전';
  void presentMinigameReward($('run-reward'), 'pole-jump', { score, poles: cleared }).then(reward => {
    const returnToMap = inRouteSign && reward.error !== 'SIGN_GOAL_NOT_MET';
    again.dataset.return = String(returnToMap);
    again.textContent = returnToMap ? '여행 지도로 돌아가기' : '다시 도전';
    again.disabled = false;
  });
  $('reason').textContent = ({ completed: '표지판 도전을 마쳤어요.', fall: '다음 발판까지 닿지 못했어요.', pushed_out: '위험 구역 끝에 도달했어요.', obstacle: '착지한 발판에 장애물이 있었어요.', speeding: '과속 상태가 계속됐어요.' })[reason];
  $('result-title').textContent = reason === 'completed' ? '도전 완료!' : reason === 'speeding' ? '과속 감지!' : '도전 종료'; $('best-badge').classList.toggle('hidden', !isBest); $('result').classList.remove('hidden'); if (reason === 'speeding') beep(180, .3);
}
function laneMove(d) { if (!running || stoppedAt || jump) return; lane = clamp(lane - d, 0, 2); updateHud(); }
function completeJump() {
  if (!jump || poles.length < 2) return;
  const target = poles[1], obstacle = target.obstacles.find(o => o.lane === lane), wasPerfect = jump.perfect;
  passed.push(poles.shift()); if (passed.length > 6) passed.shift(); fillPoles();
  worldM = poles[0].distance; jump = null; landedAt = performance.now();
  if (obstacle) {
    if (tutorial) { toast('장애물! 위아래로 발판을 옮겨요'); }
    else { draw(performance.now()); finish('obstacle'); return; }
  }
  if (tutorial) {
    tutorialStep++;
    if (tutorialStep >= 3) { tutorial = false; score = cleared = perfects = combo = maxCombo = parts = feedDistance = 0; startAt = performance.now(); showJumpHint('시작! 이제 기록이 시작돼요'); toast('시작!'); }
    else showJumpHint(`연습 ${tutorialStep + 1}/3 · 다음 전봇대가 가까워지면 탭해요`);
    updateHud(); return;
  }
  cleared++; score += 10;
  if (inRouteSign) $('finish-run').classList.remove('hidden');
  if (!inRouteSign && cleared === 30) addItem('gear-tires-a', 1, { from: 'pole-jump', milestone: 30 });
  if (wasPerfect) { combo++; perfects++; maxCombo = Math.max(maxCombo, combo); score += 5 * Math.min(combo, 5); toast('완벽 착지!'); beep(880, .12); }
  else { combo = 0; toast('착지 +10'); beep(620, .08); }
  if (!inRouteSign && cleared % 10 === 0) { parts++; addItem('part', 1, { from: 'pole-jump' }); toast('+1 부품'); }
  updateHud();
}
let frameErrorLogged = false;
function frame(now) {
  if (!running) return;
  try { frameStep(now); } catch (error) {
    if (!frameErrorLogged) { frameErrorLogged = true; console.error('pole-jump frame failed', error); }
    finish('fall');
  }
}
function frameStep(now) {
  if (!running) return;
  const dt = Math.min((now - lastFrame) / 1000, .06); lastFrame = now;
  scenery.update(dt, speed, getSeat());
  if (speed < 3) { if (!stoppedAt) stoppedAt = now; $('pause').classList.remove('hidden'); } else { stoppedAt = 0; $('pause').classList.add('hidden'); }
  if (!introRemaining && speedLimit != null && speed > speedLimit) { speeding += dt; document.body.classList.add('speeding'); if (Math.floor(speeding * 3) !== Math.floor((speeding - dt) * 3)) beep(850, .05); if (speeding >= 2) { draw(now); finish('speeding'); return; } } else { speeding = 0; document.body.classList.remove('speeding'); }
  if (!stoppedAt) {
    const speedFactor = tutorial ? .6 : cleared < 5 ? .8 + .2 * (cleared / 5) : cleared >= 30 ? 1.15 : 1;
    if (introRemaining > 0) {
      introRemaining = Math.max(0, introRemaining - dt); worldM = 0;
      if (!introRemaining) { landedAt = now; $('jump').disabled = false; }
    } else {
      const scrollSpeed = cleared === 0 ? Math.min(speed, FIRST_JUMP_SPEED) : speed;
      worldM += scrollSpeed / 3.6 * GAME_SPEED * speedFactor * dt;
      fillPoles();
      if (jump) { if (arrivalM() <= 0) completeJump(); }
      else {
        const ride = rideM();
        if (ride > ZONE_M * .7 && now - warningBeepAt > 420) { warningBeepAt = now; beep(980, .07); }
        if (ride > ZONE_M) {
          if (tutorial) { worldM = poles[0].distance + 4; toast('괜찮아요. 다시 해봐요!'); }
          else { draw(now); finish('pushed_out'); return; }
        }
        showJumpHint(tutorial ? `연습 ${tutorialStep + 1}/3 · ${targetVisible() ? '지금! 탭해서 점프' : '다음 전봇대를 기다려요'}` : cleared < 3 ? (targetVisible() ? '지금 점프' : '다음 전봇대를 기다려요') : '');
        if (demoMode && arrivalM() <= MAX_AIR_M - 4 && ride >= 4) doJump();
      }
    }
  }
  updateHud(); draw(now); requestAnimationFrame(frame);
}
function yLevel(ln, top, bottom) { return top + (ln + 1) * (bottom - top) / 4; }
function rimPath(drawPath, night = scenery.timeOfDay === 'night') {
  ctx.save(); ctx.shadowColor = night ? '#ffbd70' : '#d6f0ff'; ctx.shadowBlur = night ? 9 : 3;
  ctx.fillStyle = night ? '#111725' : '#172432'; ctx.strokeStyle = night ? 'rgba(255,194,117,.82)' : 'rgba(221,240,255,.78)'; ctx.lineWidth = 1.4;
  drawPath(); ctx.fill(); ctx.stroke(); ctx.restore();
}
function drawTree(x, base, top, p) {
  const sx = x + p.lean;
  rimPath(() => { ctx.beginPath(); ctx.moveTo(sx-4,base); ctx.lineTo(sx-2,top+18); ctx.lineTo(sx+4,top+18); ctx.lineTo(sx+7,base); ctx.closePath(); });
  for (const [dx,dy,r] of [[-13,17,17],[6,11,20],[-3,-3,19],[20,18,14]]) rimPath(() => { ctx.beginPath(); ctx.arc(sx+dx,top+dy,r,0,Math.PI*2); });
  for (let ln=0;ln<3;ln++) { const y=yLevel(ln,top,base); ctx.fillStyle='#172432'; ctx.fillRect(sx+2,y-2,20,4); ctx.strokeStyle=scenery.timeOfDay==='night'?'#ffc77e':'#e4f3ff'; ctx.strokeRect(sx+2,y-2,20,4); }
}
function drawPole(x, top, base, p) {
  const lean=p.lean; rimPath(() => { ctx.beginPath(); ctx.moveTo(x-6,base); ctx.lineTo(x-3+lean,top); ctx.lineTo(x+3+lean,top); ctx.lineTo(x+6,base); ctx.closePath(); });
  for(let a=0;a<p.arms;a++){const ay=top+17+a*17,ax=x+lean*.4;ctx.fillStyle='#172432';ctx.fillRect(ax-25,ay-2,50,5);ctx.strokeStyle=scenery.timeOfDay==='night'?'#ffc77e':'#e4f3ff';ctx.strokeRect(ax-25,ay-2,50,5);for(let k=0;k<3;k++){ctx.beginPath();ctx.arc(ax-15+k*15,ay-3,3,Math.PI,0);ctx.fillStyle='#172432';ctx.fill();ctx.stroke();}}
  for(let ln=0;ln<3;ln++){const y=yLevel(ln,top,base);ctx.fillStyle='#172432';ctx.fillRect(x+1,y-2,FOOTHOLD_LENGTH,4);ctx.strokeStyle=scenery.timeOfDay==='night'?'#ffc77e':'#e4f3ff';ctx.strokeRect(x+1,y-2,FOOTHOLD_LENGTH,4);}
}
function drawObstacle(x,y,type,index) {
  ctx.save();ctx.shadowColor=scenery.timeOfDay==='night'?'#ffbd70':'#d6f0ff';ctx.shadowBlur=scenery.timeOfDay==='night'?8:2;ctx.fillStyle=scenery.timeOfDay==='night'?'#111725':'#172432';ctx.strokeStyle=scenery.timeOfDay==='night'?'#ffc77e':'#e4f3ff';ctx.lineWidth=1.3;
  if(type==='변압기'||type==='표지판'){ctx.fillRect(x-17,y-24,24,20);ctx.strokeRect(x-17,y-24,24,20);if(type==='변압기')hatchRect(ctx,x-16,y-23,22,18,5,'#667d96');else{ctx.beginPath();ctx.moveTo(x-13,y-18);ctx.lineTo(x+2,y-18);ctx.moveTo(x-13,y-13);ctx.lineTo(x,y-13);ctx.stroke();}}
  else{ctx.beginPath();ctx.ellipse(x-5,y-16,12,7,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillRect(x-10,y-11,17,5);ctx.strokeRect(x-10,y-11,17,5);}ctx.restore();
}
function draw(now) {
  const direction=travelDir(getSeat()), glassBottom=h*.60, top=h*.11, base=h*.57;
  scenery.draw(ctx,0,h*.07,w,glassBottom-h*.07,{sharp:true});
  const zoneEdge=handBaseX()+direction*ZONE_M*pxPerMeter(),dangerX=direction>0?zoneEdge:0,dangerW=direction>0?w-zoneEdge:zoneEdge;ctx.save();traceWindow(ctx,w,h,{glassBottom,seat:getSeat()});ctx.clip('evenodd');
  ctx.fillStyle='rgba(30,30,30,.08)';ctx.fillRect(dangerX,top,dangerW,base-top);hatchRect(ctx,dangerX,top,dangerW,base-top,9,'#8195ad');sketchLine(ctx,zoneEdge,top,zoneEdge,base,{seed:77,width:2.2});
  const allPoles = [...passed, ...poles]; const geometries = allPoles.map(p => poleGeometry(p, screenX(p), top, base));
  for(let i=0;i<allPoles.length-1;i++){const a=allPoles[i],b=allPoles[i+1];if(a.tree||b.tree)continue;for(const wire of wireCurves(geometries[i],geometries[i+1],10+((a.index*13)%10))){ctx.beginPath();ctx.moveTo(wire.from.x,wire.from.y);ctx.quadraticCurveTo(wire.control.x,wire.control.y,wire.to.x,wire.to.y);ctx.strokeStyle=scenery.timeOfDay==='night'?'#ffc77e':'#d8e8f3';ctx.lineWidth=1.4;ctx.stroke();}}
  allPoles.forEach(p=>{const x=screenX(p);if(x< -60||x>w+60)return;const pTop=base-(base-top)*.8*p.height,pBase=base+p.ground*.25;if(p.tree)drawTree(x,pBase,pTop,p);else drawPole(x,pTop,pBase,p);for(const obstacle of p.obstacles)drawObstacle(x,yLevel(obstacle.lane,pTop,pBase),obstacle.type,p.index);});
  const standFoot = poles[0] ? poleGeometry(poles[0], screenX(poles[0]), top, base).footholds[lane] : { x: handBaseX(), y: yLevel(lane, top, base) };
  let foot = standFoot, pose = 'stand';
  if (jump && poles[1]) {
    const t = clamp(1 - arrivalM() / jump.air0, 0, 1), target = poleGeometry(poles[1], handBaseX(), top, base).footholds[lane];
    const fromX = handBaseX() + direction * jump.startRide * pxPerMeter() + (standFoot.x - screenX(poles[0])), hopH = 34 + 34 * Math.min(1, jump.air0 / MAX_AIR_M);
    foot = { x: fromX + (target.x - fromX) * (t * t * (3 - 2 * t)), y: standFoot.y + (target.y - standFoot.y) * t - Math.sin(t * Math.PI) * hopH };
    pose = t < .12 ? 'crouch' : 'hop';
  } else if (landedAt && now - landedAt < 160) pose = 'land';
  else if (arrivalM() <= 9) pose = 'crouch';
  if (devPose === 'fall') { pose = 'fall'; foot = { x: standFoot.x + direction * 26, y: standFoot.y + 46 }; }
  if (new URLSearchParams(location.search).get('hitbox') === '1') { ctx.strokeStyle = '#ff5757'; ctx.strokeRect(Math.min(handBaseX(), zoneEdge), top, Math.abs(zoneEdge - handBaseX()), base - top); ctx.strokeStyle = '#ffb35c'; ctx.beginPath(); ctx.moveTo(handBaseX(), top); ctx.lineTo(handBaseX(), base); ctx.stroke(); }
  const night = scenery.timeOfDay === 'night', dusk = scenery.timeOfDay === 'dusk';
  if (character === 'runner') drawRunner(ctx, foot.x, foot.y, { night, dusk, pose, step: devPose ? 1 : now / 120, bob: pose === 'stand' ? Math.sin(now / 150) * 1.2 : 0, direction });
  else drawFingerWalker(ctx, foot, { night, dusk, pose, step: devPose ? .25 : now / 260, direction });
  ctx.restore();
  drawWindowFrame(ctx,w,h,{glassBottom});if(speeding){ctx.fillStyle='#101725';ctx.fillRect(0,0,w,32);ctx.fillStyle='#fff';ctx.font='bold 13px monospace';ctx.textAlign='center';ctx.fillText('과속 — 정지',w/2,21);ctx.strokeStyle='#ffc77e';ctx.lineWidth=5;ctx.strokeRect(3,3,w-6,h-6);}drawLowerHud();
}
function drawLowerHud() {}
function onFeed(v) { speed = v.speedKmh; speedLimit = v.speedLimitKmh; feedDistance += Number(v.distanceDeltaM) || 0; updateHud(); }
function ensureSeat() { if (inJourney || getSeat()) return; setSeat(confirm('오른쪽 좌석인가요?\n확인: 오른쪽 / 취소: 왼쪽') ? 'right' : 'left'); }
document.querySelector('#start-button').addEventListener('click', async () => { if (!await ensurePassenger()) return; ensureSeat(); if (!feed) { feed = createVehicleFeed({ dev }); feed.on('update', onFeed); } if (inJourney) speed = feed.current.speedKmh; audio?.resume(); reset(); });
$('finish-run').addEventListener('click', () => finish('completed'));
$('again').addEventListener('click', () => { if ($('again').dataset.return === 'true') returnToJourney(); else reset(); }); $('jump').addEventListener('click', doJump); $('up').addEventListener('click', () => laneMove(1)); $('down').addEventListener('click', () => laneMove(-1));
$('mute').addEventListener('click', e => { muted = !muted; e.currentTarget.textContent = muted ? '◖' : '◗'; });
if (devAutostart) { feed = createVehicleFeed({ dev }); feed.on('update', onFeed); reset(); }
window.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); doJump(); } if (e.code === 'ArrowUp') { e.preventDefault(); laneMove(1); } if (e.code === 'ArrowDown') { e.preventDefault(); laneMove(-1); } });
let touchY = null; canvas.addEventListener('touchstart', e => touchY = e.touches[0].clientY, { passive: true });
canvas.addEventListener('touchend', e => { if (touchY == null) return; const d = e.changedTouches[0].clientY - touchY; if (Math.abs(d) > 24) laneMove(d < 0 ? 1 : -1); else doJump(); touchY = null; }, { passive: true });
document.querySelector('#start-button').disabled = false;

// Pleos integration point: forward NaviHelper onCurrentRoadSpeedLimit() and onDrivingInfo() to the server, which relays them over /vehicle WebSocket.

notifyJourneyReady();
