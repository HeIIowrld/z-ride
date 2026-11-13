import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../games/raindrop/game.js', import.meta.url), 'utf8')).replace(/^\uFEFF/, '')
  .replace(/^import .*;\r?\n/gm, '');
const runSeed = Number(process.argv[2] || 73129);
let now = 0, raf = null, seed = runSeed;
const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const noop = () => {};
const ctx = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 0 }) : key === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop, set: () => true });
const canvas = { width: 375, height: 812, getContext: () => ctx, getBoundingClientRect: () => ({ width: 375, height: 812, left: 0, top: 0 }), addEventListener: noop, setPointerCapture: noop };
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop });
  return elements.get(id);
};
const document = { querySelector: () => canvas, getElementById: element };
const sandbox = {
  document, window: { addEventListener: noop }, location: { search: '?dev=1' }, URLSearchParams, inJourney: false,
  devicePixelRatio: 1, ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
  requestAnimationFrame: fn => { raf = fn; }, performance: { now: () => now }, Math: Object.create(Math),
  setTimeout: () => 0, clearTimeout: noop, console,
  createVehicleFeed: () => ({ current: null, on: noop, addDevControl: noop }),
  getSeat: () => 'left', addItem: noop, getInventory: () => ({}), getBest: () => null, saveRecord: x => x,
  ensurePassenger: async () => true, startLootTracking: noop, awardMinigame: async () => ({ items: [] }),
  sketchLine: noop, hatchRect: noop, drawFinger: noop,
};
sandbox.Math.random = random;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'games/raindrop/game.js' });
sandbox.window.__raindrop.start();
const rows = [], windows = [];
let windowSum = 0, windowN = 0, eventFreeSum = 0, eventFreeN = 0;
for (let frame = 1; frame <= 180 * 60; frame++) {
  now = frame * 1000 / 60;
  const callback = raf; raf = null;
  callback?.(now);
  if (!raf) break;
  const s = sandbox.window.__raindrop.getState();
  windowSum += s.sliding; windowN++;
  if (!s.event) { eventFreeSum += s.sliding; eventFreeN++; }
  if (frame % 600 === 0) {
    const seconds = frame / 60;
    windows.push({ slidingAvg: windowSum / windowN, eventFreeAvg: eventFreeN ? eventFreeSum / eventFreeN : 0 });
    windowSum = windowN = eventFreeSum = eventFreeN = 0;
    rows.push({ seconds, stuck: s.stuck, sliding: s.sliding, missed: s.missed, gauge: s.gauge });
  }
}
console.log(`Seed ${runSeed}`);
console.log('seconds  stuck  sliding  missed  gauge%  10s avg sliding (all / event-free)');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i], a = windows[i];
  console.log(`${String(r.seconds).padStart(7)}  ${String(r.stuck).padStart(5)}  ${String(r.sliding).padStart(7)}  ${String(r.missed).padStart(6)}  ${String(r.gauge).padStart(6)}  ${a.slidingAvg.toFixed(2)} / ${a.eventFreeAvg.toFixed(2)}`);
}
