export const inJourney = typeof window !== 'undefined' && window.parent !== window
  && location.pathname.startsWith('/play/drive/');

let latest;
if (inJourney) {
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.source !== window.parent || event.origin !== location.origin || value?.type !== 'zride:drive-state'
        || !Number.isFinite(value.speedKmh)) return;
    latest = value;
  });
  window.parent.postMessage({ type: 'zride:drive-ready' }, location.origin);
  document.querySelectorAll('a[href="../../index.html"]').forEach(link => {
    if (link.closest('header')) link.hidden = true;
    else link.textContent = '여정으로 돌아가기';
    link.addEventListener('click', event => {
      event.preventDefault();
      returnToJourney();
    });
  });
}

export function returnToJourney() {
  window.parent.postMessage({ type: 'zride:drive-back' }, location.origin);
}

export function journeySeat() {
  if (!latest) return null;
  return latest.seat === 'REAR_LEFT' ? 'left' : 'right';
}

export function journeyVehicleFeed() {
  const callbacks = { update: new Set(), trigger: new Set() };
  let previous = performance.now();
  let previousTurn = null, previousLimit = null;
  const current = () => ({
    speedKmh: latest?.speedKmh ?? 0,
    speedLimitKmh: Number.isFinite(latest?.speedLimitKmh) ? latest.speedLimitKmh : null,
    wiper: null, windKmh: 0,
  });
  const timer = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.min((now - previous) / 1000, 1);
    previous = now;
    if (!latest) return;
    const state = current();
    const turn = latest.nextTurn;
    if (turn !== previousTurn && ['left', 'right'].includes(turn)) {
      for (const callback of callbacks.trigger) callback({ type: 'tbt', detail: { turn } });
    } else if (state.speedLimitKmh !== previousLimit && state.speedLimitKmh !== null) {
      for (const callback of callbacks.trigger) callback({ type: 'speedLimit', detail: { kmh: state.speedLimitKmh } });
    }
    previousTurn = turn;
    previousLimit = state.speedLimitKmh;
    for (const callback of callbacks.update) callback({
      ...state, distanceDeltaM: state.speedKmh / 3.6 * elapsed, source: 'vehicle',
    });
  }, 100);
  return {
    on(event, callback) {
      callbacks[event]?.add(callback);
      return () => callbacks[event]?.delete(callback);
    },
    stop() { clearInterval(timer); },
    get current() { return current(); },
  };
}
