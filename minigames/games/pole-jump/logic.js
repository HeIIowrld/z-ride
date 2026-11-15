export const HOP_MS = 260;
export const SCROLL_MULTIPLIER = 2.5;
export const STANDING_ZONE_RATIO = 0.12;
export const LANDING_TOLERANCE_RATIO = 0.14;
export const HAND_X_RATIO = 0.62;
export const FOOTHOLD_LENGTH = 22;

export function poleGeometry(pole, x, top, base) {
  const poleTop = base - (base - top) * 0.8 * pole.height;
  const poleBase = base + pole.ground * 0.25;
  const lean = pole.lean || 0;
  const footholds = [0, 1, 2].map(lane => ({ x: x + 12, y: poleTop + (lane + 1) * (poleBase - poleTop) / 4, lane, length: FOOTHOLD_LENGTH }));
  const insulators = Array.from({ length: 3 }, (_, i) => ({ x: x + lean * 0.4 - 15 + i * 15, y: poleTop + 14 }));
  return { x, top: poleTop, base: poleBase, footholds, insulators };
}

export function wireCurves(a, b, sag = 12) {
  return a.insulators.map((from, i) => {
    const to = b.insulators[i];
    return { from, to, control: { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + sag } };
  });
}

export function landingWindowSeconds(gapM, speedKmh, scrollMultiplier = SCROLL_MULTIPLIER) {
  const toleranceM = Math.max(0, gapM * LANDING_TOLERANCE_RATIO * 2);
  return toleranceM / (speedKmh / 3.6 * scrollMultiplier);
}

export function landingOutcome({ oldX, nextX, handX, hopMs = HOP_MS, scrollPxPerMs, tolerancePx }) {
  const atLanding = nextX - scrollPxPerMs * hopMs;
  if (Math.abs(atLanding - handX) <= tolerancePx) return 'land';
  return 'fall';
}

export function standingOutcome(handX, poleX, zonePx) {
  return Math.abs(poleX - handX) <= zonePx ? 'standing' : 'pushed_out';
}

export function footholdFor(pole, lane, x, top, base) {
  return poleGeometry(pole, x, top, base).footholds[lane];
}

export function simulateDemo({ durationMs = 60000, speedKmh = 42, gapM = 38, toleranceM = 8 } = {}) {
  const stepMs = 20, hopMs = HOP_MS, rate = speedKmh / 3.6 * SCROLL_MULTIPLIER / 1000;
  let elapsed = 0, progress = 0, clears = 0, aliveMs = 0, hopping = 0;
  const maxSteps = Math.ceil(durationMs / stepMs);
  for (let step = 0; step < maxSteps; step++) {
    elapsed += stepMs; aliveMs = elapsed;
    if (hopping > 0) { hopping -= stepMs; if (hopping <= 0) { clears++; progress = 0; } }
    else {
      progress += rate * stepMs;
      const landingTime = (gapM - progress) / rate;
      if (landingTime >= 0 && landingTime <= hopMs && Math.abs(gapM - progress - rate * hopMs) <= toleranceM) hopping = hopMs;
      else if (progress >= gapM + toleranceM) { progress = 0; }
    }
  }
  return { elapsedMs: elapsed, aliveMs, clears };
}

