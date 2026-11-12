import { inJourney, journeySeat } from './journey.js';

const KEY = 'zride.seat';
export function getSeat() {
  if (inJourney) return journeySeat();
  try { const value = localStorage.getItem(KEY); return value === 'left' || value === 'right' ? value : null; }
  catch { return null; }
}
export function setSeat(value) {
  if (value !== 'left' && value !== 'right') throw new TypeError("seat must be 'left' or 'right'");
  try { localStorage.setItem(KEY, value); } catch { /* Storage may be unavailable. */ }
  return value;
}
