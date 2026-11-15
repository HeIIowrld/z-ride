// Stable, lightweight hand-drawn strokes shared by both canvas games.
export function sketchLine(ctx, x1, y1, x2, y2, { jitter = 1, seed = 1, color = '#eef6ff', width = 1.6 } = {}) {
  const hash = n => { const v = Math.sin((n + seed) * 127.1) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
  const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy), steps = Math.max(2, Math.ceil(length / 15));
  ctx.beginPath(); ctx.moveTo(x1, y1);
  for (let i = 1; i < steps; i++) { const t = i / steps, wobble = hash(i) * jitter; ctx.lineTo(x1 + dx * t - dy / (length || 1) * wobble, y1 + dy * t + dx / (length || 1) * wobble); }
  ctx.lineTo(x2, y2); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}
export function hatchRect(ctx, x, y, width, height, spacing = 7, color = '#777') {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  for (let t = -height; t < width; t += spacing) sketchLine(ctx, x + t, y + height, x + t + height, y, { jitter: .4, seed: t, color, width: 1 });
  ctx.restore();
}
export function drawRunner(ctx, x, feetY, { night = false, dusk = false, pose = 'stand', step = 0, bob = 0, direction = 1 } = {}) {
  const fill = night ? '#f4f1df' : '#202b38', rim = night ? '#fff2ba' : dusk ? '#e8a47c' : '#d9efff';
  const tuck = pose === 'hop', fall = pose === 'fall', crouch = pose === 'crouch', squash = pose === 'land';
  const sy = bob + (squash ? 3 : fall ? 2 : 0), bodyY = feetY - (crouch ? 13 : tuck ? 18 : 17) + sy;
  const limb = (x1, y1, x2, y2, width = 3.3) => { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.strokeStyle=fill;ctx.lineWidth=width;ctx.lineCap='round';ctx.stroke();ctx.strokeStyle=rim;ctx.lineWidth=1;ctx.stroke(); };
  ctx.save(); ctx.translate(x, feetY); ctx.scale(1.38, 1.38); ctx.translate(-x, -feetY); ctx.shadowColor=rim;ctx.shadowBlur=night?7:2;
  const scarfX=x-direction*8;ctx.fillStyle=dusk?'#d76d50':'#d65e4c';ctx.beginPath();ctx.moveTo(x-direction*3,bodyY-1);ctx.lineTo(scarfX,bodyY+1);ctx.lineTo(scarfX-direction*(5+Math.sin(step)*1.5),bodyY+4);ctx.closePath();ctx.fill();
  limb(x-3,bodyY+2,x-5+(tuck?-3:0),feetY-(tuck?8:0),3.8);limb(x+3,bodyY+2,x+5+(tuck?3:0),feetY-(tuck?8:0),3.8);
  limb(x-5,feetY-(tuck?8:0),x-7,feetY-(tuck?8:0),3.2);limb(x+5,feetY-(tuck?8:0),x+7,feetY-(tuck?8:0),3.2);
  const armUp=tuck||fall, swing=Math.sin(step)*1.3;
  limb(x-4,bodyY-3,x-8-(armUp?2:0),bodyY+(armUp?-9:3)+swing,3.2);limb(x+4,bodyY-3,x+8+(armUp?2:0),bodyY+(armUp?-9:3)-swing,3.2);
  ctx.fillStyle=fill;ctx.strokeStyle=rim;ctx.lineWidth=1.3;ctx.beginPath();ctx.roundRect(x-5,bodyY-7,10,crouch?10:12,4);ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(x,bodyY-12,5.5,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();
}

// Two-bone limb solver and the childhood finger-person used by pole-jump.
export function solveLimb(root, end, upperLength, lowerLength, bend = 1) {
  const dx = end.x - root.x, dy = end.y - root.y, distance = Math.hypot(dx, dy) || 0.001;
  const d = Math.min(distance, upperLength + lowerLength - 0.001);
  const along = (upperLength * upperLength - lowerLength * lowerLength + d * d) / (2 * d);
  const across = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  const sign = bend < 0 ? -1 : 1;
  const ux = dx / distance, uy = dy / distance;
  return { x: root.x + ux * along - uy * across * sign, y: root.y + uy * along + ux * across * sign };
}

export function poleJumpHandGeometry(peg, { direction = 1, step = 0, pose = 'stand', bob = 0 } = {}) {
  const front = direction, hop = pose === 'hop', falling = pose === 'fall';
  const phase = step * Math.PI * 2.5, stride = pose === 'stand' ? Math.sin(phase) * 3 : 0;
  const squash = pose === 'land', crouch = pose === 'crouch';
  const baseX = peg.x - front * 36;
  const wrist = { x: baseX + front * 7, y: peg.y - 38 + bob + (crouch ? 4 : 0) - (hop ? 24 : 0) + (falling ? 8 : 0) + (squash ? 2 : 0) };
  const fingers = [-4.5, 4.5].map((offset, i) => {
    const lift = hop ? 12 : falling ? i * 2 : crouch ? 1 : stride * (i ? -1 : 1);
    return { x: peg.x + front * offset, y: peg.y - lift };
  });
  return { wrist, elbow: solveLimb({ x: baseX - front * 12, y: peg.y + 15 }, wrist, 35, 31, front), fingers, forearm: { x: baseX, y: peg.y + 15 } };
}

export function drawPoleJumpHand(ctx, peg, { night = false, dusk = false, pose = 'stand', step = 0, bob = 0, direction = 1, glassBottom = peg.y + 35 } = {}) {
  const g = poleJumpHandGeometry(peg, { direction, step, pose, bob });
  const fill = night ? '#697487' : dusk ? '#efd6bd' : '#f5e4ce';
  const ink = night ? '#e8d8bd' : '#27313b';
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (night) { ctx.shadowColor = '#ffc985'; ctx.shadowBlur = 9; }
  ctx.strokeStyle = ink; ctx.lineWidth = 2;
  // The cuff and tapered two-bone arm remain on the car-interior side of the shaft.
  ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(g.forearm.x - 10, glassBottom); ctx.lineTo(g.elbow.x - 8, g.elbow.y); ctx.quadraticCurveTo(g.elbow.x, g.elbow.y + 2, g.elbow.x + 7, g.elbow.y - 1); ctx.lineTo(g.wrist.x + 7, g.wrist.y); ctx.lineTo(g.wrist.x - 7, g.wrist.y); ctx.lineTo(g.elbow.x - 7, g.elbow.y + 2); ctx.lineTo(g.forearm.x + 10, glassBottom); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(g.forearm.x - 10, peg.y + 12); ctx.lineTo(g.elbow.x - 8, g.elbow.y); ctx.quadraticCurveTo(g.elbow.x, g.elbow.y + 2, g.elbow.x + 7, g.elbow.y - 1); ctx.lineTo(g.wrist.x + 7, g.wrist.y); ctx.stroke();
  ctx.fillStyle = dusk ? '#c87757' : '#43566b'; ctx.beginPath(); ctx.roundRect(g.forearm.x - 11, peg.y + 5, 22, 8, 3); ctx.fill(); ctx.stroke();
  // Back of the hand: bends over from the wrist toward the pole so the two finger-legs hang down onto the peg.
  const palmX0 = Math.min(g.wrist.x, peg.x + direction * 9) - 6, palmX1 = Math.max(g.wrist.x, peg.x + direction * 9) + 6, palmY = g.wrist.y - 9;
  ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(palmX0, palmY - 10, palmX1 - palmX0, 21, 10); ctx.fill(); ctx.stroke();
  // Back knuckles, curled fingers, thumb.
  // Curled ring and little fingers (rear side) and thumb (underside near the wrist).
  for (const [x, y, r] of [[peg.x + direction * 13, palmY + 6, 4.5], [peg.x + direction * 17, palmY + 1, 4], [g.wrist.x + direction * 6, palmY + 11, 4]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.stroke(); }
  // Draw peg after pole, then finger legs on top: each foot ends exactly at peg.y.
  for (const p of g.fingers) { const kneeY = pose === 'hop' ? p.y + 7 : (p.y + peg.y) / 2; ctx.beginPath(); ctx.moveTo(p.x, palmY + 8); ctx.quadraticCurveTo(p.x, kneeY - 3, p.x, kneeY); ctx.lineTo(p.x, peg.y - 2); ctx.strokeStyle = ink; ctx.lineWidth = 8.5; ctx.stroke(); ctx.strokeStyle = fill; ctx.lineWidth = 5; ctx.stroke(); ctx.beginPath(); ctx.arc(p.x, kneeY, 3.5, 0, Math.PI*2); ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=ink;ctx.lineWidth=1.5;ctx.stroke(); ctx.beginPath();ctx.ellipse(p.x,peg.y-1,3.5,2,0,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();ctx.stroke(); }
  ctx.restore();
  return g;
}

// Upside-down victory hand (the V-sign emoji flipped): palm on top, index and
// middle fingers pointing down as two legs. Sticker look: cream halo + dark
// outline + warm fill, so it reads on day, dusk and night scenes. No arm.
export function drawFingerWalker(ctx, foot, { night = false, dusk = false, pose = 'stand', step = 0, direction = 1 } = {}) {
  const fill = '#ffd166', shade = '#f2b23c', ink = '#12283c', halo = night ? '#fff4d6' : '#f4efe6';
  const cyc = step * Math.PI * 2, swing = Math.sin(cyc), d = direction;
  const air = pose === 'hop', fall = pose === 'fall', low = pose === 'crouch' || pose === 'land';
  const legLen = air ? 24 : pose === 'land' ? 20 : pose === 'crouch' ? 24 : 32;
  const hipY = -legLen - (pose === 'stand' ? Math.abs(swing) * 1.5 : 0);
  const tilt = fall ? d * (.6 + step * 2.2) : air ? -d * (.12 + Math.sin(cyc * 2) * .06) : pose === 'stand' ? swing * .05 : 0;
  // Feet: walking steps while standing, scissor kick in the air, wide brace when low.
  const legs = [-1, 1].map(side => {
    let fx, fy, bend;
    if (air) { const k = Math.sin(cyc * 2 + (side > 0 ? 0 : Math.PI)); fx = side * (12 + k * 5); fy = -4 - (k + 1) * 4; bend = side * 5; }
    else if (fall) { fx = side * 15; fy = -2; bend = side * 2; }
    else if (low) { fx = side * 12; fy = 0; bend = side * 7; }
    else { const k = swing * side; fx = side * 8 + k * 3; fy = -Math.max(0, k) * 5; bend = side * 1.5 + k * 1.5; }
    const hx = side * 4.5;
    return { hx, hy: hipY + 2, kx: (hx + fx) / 2 + bend, ky: (hipY + fy) / 2, fx, fy: fy - 4 };
  });
  const squash = pose === 'land' ? 1.12 : 1, palmW = 27 * squash, palmH = 23 / squash, palmTop = hipY - palmH + 3;
  const line = (x1, y1, cx, cy, x2, y2, width, color) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, x2, y2); ctx.stroke(); };
  const palm = (grow, color, asFill) => { ctx.beginPath(); ctx.roundRect(-palmW / 2 - grow, palmTop - grow, palmW + grow * 2, palmH + grow * 2, 10 + grow); if (asFill) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = .1; ctx.fillStyle = color; ctx.fill(); } };
  ctx.save(); ctx.translate(foot.x, foot.y); ctx.rotate(tilt); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (night) { ctx.shadowColor = '#ffd58a'; ctx.shadowBlur = 10; }
  // Pass 1: cream halo. Pass 2: dark outline. Pass 3: fill.
  for (const [grow, color] of [[5, halo], [2.4, ink]]) {
    for (const l of legs) line(l.hx, l.hy, l.kx, l.ky, l.fx, l.fy, 9 + grow * 2, color);
    palm(grow, color, false);
    ctx.shadowBlur = 0;
  }
  for (const l of legs) line(l.hx, l.hy, l.kx, l.ky, l.fx, l.fy, 9, fill);
  palm(0, fill, true);
  // Fingertip pads and knuckle creases on the two leg-fingers.
  ctx.fillStyle = shade; for (const l of legs) { ctx.beginPath(); ctx.ellipse(l.fx, l.fy + 1.5, 3.6, 2.4, 0, 0, Math.PI * 2); ctx.fill(); }
  for (const l of legs) line(l.kx - 2.5, l.ky, l.kx, l.ky + .8, l.kx + 2.5, l.ky, 1.4, ink);
  // Folded ring and little fingers on the rear side of the palm, thumb tucked across them.
  for (const [x, w] of [[d * 5.5, 7.5], [d * 11, 6.5]]) { line(x, hipY - 5, x, hipY - 2, x, hipY + 1, w + 3.4, ink); line(x, hipY - 5, x, hipY - 2, x, hipY + 1, w, fill); }
  line(-d * 10, hipY - 9, -d * 2, hipY - 3, d * 7, hipY - 6, 9.4, ink); line(-d * 10, hipY - 9, -d * 2, hipY - 3, d * 7, hipY - 6, 6, fill);
  // Small shine on the back of the hand.
  line(-palmW / 2 + 5, palmTop + 6, -palmW / 2 + 9, palmTop + 3.5, -palmW / 2 + 14, palmTop + 3.5, 2, 'rgba(255,255,255,.75)');
  ctx.restore();
}
