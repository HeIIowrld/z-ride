// Stable, lightweight hand-drawn strokes shared by both canvas games.
export function sketchLine(ctx, x1, y1, x2, y2, { jitter = 1, seed = 1, color = '#171717', width = 1.6 } = {}) {
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
export function drawFinger(ctx, x, y, scale = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.strokeStyle = '#171717'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-10, 5); ctx.quadraticCurveTo(-17, -1, -12, -5); ctx.lineTo(-7, -2); ctx.lineTo(-6, -22); ctx.quadraticCurveTo(-5, -28, -1, -26); ctx.quadraticCurveTo(2, -25, 2, -4); ctx.quadraticCurveTo(5, -16, 9, -13); ctx.lineTo(13, -7); ctx.quadraticCurveTo(19, -6, 17, 3); ctx.lineTo(12, 10); ctx.lineTo(-3, 10); ctx.closePath(); ctx.stroke();
  sketchLine(ctx, -6, -17, 2, -17, { jitter: .3, seed: 8, width: 2 }); ctx.restore();
}
