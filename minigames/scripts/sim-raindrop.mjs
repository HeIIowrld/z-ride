import { addDrop, addDust, addTrail, createWorld, getState, step, windShear } from '../games/raindrop/physics.js';
import { travelDir } from '../shared/motion.js';
import { performance } from 'node:perf_hooks';

const seeds = [73129, 27183, 99173];
const randomFor = seed => { let n = seed; return () => ((n = n * 16807 % 2147483647) - 1) / 2147483646; };
let failed = false;
function assert(label, condition, detail = '') { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); failed ||= !condition; }
function physicsChecks() {
  const rng = randomFor(33), w = createWorld({ width: 100, height: 200, rng });
  const tiny = addDrop(w, { x: 10, y: 10, r: .5 }), large = addDrop(w, { x: 80, y: 10, r: 3 });
  step(w, .05); assert('dry glass pins sub-threshold drop', tiny.state === 'stuck'); assert('dry glass releases above threshold', large.state === 'sliding');
  const mini = createWorld({ width: 100, height: 200, rng: randomFor(2) }), small = addDrop(mini, { x: 20, y: 10, r: 1.8, vy: 35 }); small.state = 'sliding'; small.path = [{ x: 20, y: 10 }];
  for (let i = 0; i < 800; i++) step(mini, .05); assert('small sliding drop loses mass and pins', small.state === 'stuck' && small.r < 1.8);
  const wet = createWorld({ width: 120, height: 300, rng: randomFor(7) }); addTrail(wet, [{ x: 20, y: 20 }, { x: 20, y: 250 }]); const follower = addDrop(wet, { x: 20, y: 30, r: 1 }); step(wet, .05); assert('wet trail induces and accelerates flow', follower.vy > 0 && Math.abs(follower.vx) < 1);
  const edge = createWorld({ width: 100, height: 200, rng: randomFor(71) }), drying = addTrail(edge, [{ x: 50, y: 10 }, { x: 50, y: 180 }], { lifetime: 8 }); drying.age = 7.99; drying.wetness = .001; const boundaryDrop = addDrop(edge, { x: 50, y: 30, r: 1, vy: 60 }); boundaryDrop.state = 'sliding'; const beforeBoundary = boundaryDrop.vy; step(edge, .05); assert('dry boundary decelerates a drop', boundaryDrop.vy < beforeBoundary);
  const dusty = createWorld({ width: 100, height: 200, rng: randomFor(5) }), d = addDrop(dusty, { x: 30, y: 30, r: 1 }); addDust(dusty, 30, 30, 8); step(dusty, .01); const stopped = d.state === 'stuck' && d.dirty; d.mass = 1000; d.r = Math.cbrt(d.mass); step(dusty, .05); assert('dust sticks, then mass releases with slip boost', stopped && d.state === 'sliding' && d.vy > 70);
  const t = createWorld({ width: 200, height: 1000, rng: randomFor(8) }); for (let i = 0; i < 400; i++) addDrop(t, { x: (i * 37) % 200, y: i % 50, r: 2 + i % 4 }); const start = performance.now(); for (let i = 0; i < 60; i++) step(t, 1 / 60); const per = (performance.now() - start) / 60; assert('400 drop physics average under 2ms', per < 2, `${per.toFixed(3)}ms`);
  const boundary = createWorld({ width: 100, height: 200, rng: randomFor(19) }); const falling = addDrop(boundary, { x: 50, y: 190, r: 2, vy: 100 }); falling.state = 'sliding';
  let belowGlass = false; for (let i = 0; i < 40; i++) { step(boundary, .05); belowGlass ||= boundary.drops.some(d => d.y >= boundary.height); }
  assert('no drop exists below glassBottom', !belowGlass && boundary.drops.every(d => d.y < boundary.height));
  const king = createWorld({ width: 100, height: 200, rng: randomFor(21) }); addTrail(king, [{ x: 50, y: 20 }, { x: 52, y: 80 }, { x: 55, y: 150 }], { king: true, lifetime: 15, width: 12 });
  for (let i = 0; i < 100; i++) step(king, .05);
  assert('king trail visible five seconds after pass', king.trails.filter(trail => trail.wetness > .15).length >= 1);
  const paths=createWorld({width:180,height:900,rng:randomFor(44)});paths.wind=2;const left=addDrop(paths,{x:70,y:10,r:3}),right=addDrop(paths,{x:74,y:10,r:3});
  for(let i=0;i<240;i++)step(paths,.05);assert('same-size neighboring drops meander onto different paths',Math.abs(left.x-70-(right.x-74))>.5,`${(left.x-70).toFixed(1)} vs ${(right.x-74).toFixed(1)}`);
  const tinyAmplitude=clampForTest(2.8/1.5),largeAmplitude=clampForTest(2.8/4);
  assert('small drops have larger meander amplitude than large drops',tinyAmplitude>largeAmplitude,`${tinyAmplitude.toFixed(2)} > ${largeAmplitude.toFixed(2)}`);
  for(const seat of ['right','left']){
    const dir=travelDir(seat), pulse=createWorld({width:500,height:10000,rng:randomFor(101),seat});
    assert(`seat ${seat} 60 km/h wind shear follows travel direction`,Math.sign(windShear(pulse,60))===dir);
    const slider=addDrop(pulse,{x:250,y:100,r:3,vx:0,vy:20});slider.state='sliding';slider.path=[{x:250,y:100}];
    for(let i=1;i<=24;i++)step(pulse,.05,{speedKmh:i*.54});const accelVx=slider.vx,velocityBeforeFrame=slider.vx;step(pulse,.05,{speedKmh:18});
    assert('lateral velocity change is bounded per frame',Math.abs(slider.vx-velocityBeforeFrame)<=1.5,`${Math.abs(slider.vx-velocityBeforeFrame).toFixed(2)} m/s`);
    assert(`seat ${seat} acceleration lurches slider rearward`,accelVx*dir>0,`${accelVx.toFixed(2)}`);
    for(let i=23;i>=0;i--)step(pulse,.05,{speedKmh:i*.54});
    assert(`seat ${seat} braking lurches slider forward`,(slider.vx-accelVx)*(-dir)>0,`${slider.vx.toFixed(2)}`);
    assert('drop lateral velocity has no frame snap',Math.abs(slider._lastVx)<=35);
  }
  const sizes=createWorld({width:500,height:10000,rng:randomFor(17)}),smallDrop=addDrop(sizes,{x:100,y:10,r:3,vx:0,vy:20}),largeDrop=addDrop(sizes,{x:300,y:10,r:5,vx:0,vy:20});for(const d of [smallDrop,largeDrop]){d.state='sliding';d.path=[{x:d.x,y:d.y}]};for(let i=1;i<=24;i++)step(sizes,.05,{speedKmh:i*.54});assert('larger drops respond more slowly',Math.abs(smallDrop.vx)>Math.abs(largeDrop.vx),`${smallDrop.vx.toFixed(2)} > ${largeDrop.vx.toFixed(2)}`);
}
function clampForTest(v){return Math.max(.65,Math.min(2.8,v));}
physicsChecks();
for (const seed of seeds) {
  const world = createWorld({ width: 375, height: 620, rng: randomFor(seed) }); world.barX = 188;
  const rows = []; let ten = { stuck: 0, sliding: 0, trails: 0, dust: 0, missed: 0, gauge: 0 }, count = 0;
  for (let frame = 1; frame <= 150 * 60; frame++) {
    step(world, 1 / 60); const s = getState(world); ten.stuck += s.stuck; ten.sliding += s.sliding; ten.trails += s.trails; ten.dust += s.dust; ten.missed = s.missed; count++;
    if (frame % 600 === 0) { rows.push({ seconds: frame / 60, stuck: +(ten.stuck / count).toFixed(1), sliding: +(ten.sliding / count).toFixed(1), trails: +(ten.trails / count).toFixed(1), dust: +(ten.dust / count).toFixed(1), missed: ten.missed, gauge: s.gauge.toFixed(1) }); ten = { stuck: 0, sliding: 0, trails: 0, dust: 0, missed: 0 }; count = 0; }
  }
  const gameOver = rows.find(r => Number(r.gauge) >= 100)?.seconds ?? 150;
  console.log(`Seed ${seed}`); console.log('seconds stuck sliding trails dust missed gauge%'); for (const r of rows) console.log(`${r.seconds} ${r.stuck} ${r.sliding} ${r.trails} ${r.dust} ${r.missed} ${r.gauge}`);
  assert(`seed ${seed} no-input game over in 70–100s`, gameOver >= 70 && gameOver <= 100, `${gameOver}s`);
}
if (failed) process.exitCode = 1;
