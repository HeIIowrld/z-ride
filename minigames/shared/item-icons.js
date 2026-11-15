const ink = '#12283c', cream = '#f4efe6', black = '#0b0f14';
const silhouettes = {
  blade:'M12 5 42 9 25 43 17 45 20 36 9 33Z M18 39 26 47 22 52 14 44Z',
  'neon-shield':'M32 5 52 13 49 36 32 53 15 36 12 13Z M33 15 25 31 33 31 29 43 41 25 34 25Z',
  'rail-spear':'M32 4 43 20 36 23 36 51 28 51 28 23 21 20Z',
  'arc-bow':'M15 8 Q48 32 15 56 M17 9 17 55 M19 32 49 32 42 26 M49 32 42 38',
  'signal-dart':'M49 9 27 37 23 28 14 25 23 21Z M27 37 35 43 29 45 M23 28 18 38 27 37 M23 28 13 31 16 23',
  'coil-launcher':'M10 22 39 22 47 27 47 37 39 42 10 42Z M18 20 Q12 32 18 44 M26 20 Q20 32 26 44 M34 20 Q28 32 34 44 M8 27 4 27 4 37 8 37',
  'harbor-hook':'M17 10 39 10 39 34 Q39 51 25 51 Q14 51 14 41 Q14 35 21 33 L26 40 Q22 41 23 44 Q24 47 29 44 Q32 42 32 34 L32 18 17 18Z',
  'ridge-staff':'M15 51 38 17 49 17 49 51 M38 17 44 7 51 17 58 7 64 17 51 25 38 25',
  'battery-cell':'M21 9 43 9 43 15 48 15 48 52 16 52 16 15 21 15Z M35 19 25 35 32 35 28 46 41 29 34 29Z',
  cable:'M12 26 C5 10 34 8 39 22 C45 39 17 36 20 49 C22 57 37 55 38 47 M38 47 47 47 47 55 38 55Z M44 47 44 42',
  'circuit-board':'M12 12 52 12 52 52 12 52Z M24 24 40 24 40 40 24 40Z M32 24 32 17 M40 32 48 32 M24 32 16 32 M32 40 32 48',
  'coolant-cell':'M17 13 47 13 47 51 17 51Z M23 8 41 8 41 14 M32 22 C28 29 23 33 23 39 A9 9 0 0 0 41 39 C41 33 36 28 32 22Z',
  'fuel-can':'M19 15 42 15 49 23 49 51 14 51 14 23 19 23Z M24 15 24 9 37 9 37 15 M25 29 39 29 39 41 25 41Z',
  supply:'M11 21 32 11 53 21 53 46 32 55 11 46Z M11 21 32 31 53 21 M32 31 32 55 M25 18 32 22 39 18',
  part:'M19 22 24 14 31 18 37 14 42 22 49 24 46 32 49 39 41 43 39 51 31 48 23 51 22 43 14 39 18 32 14 25Z M31 26 A6 6 0 1 0 32 26Z M40 39 53 52',
  ammo:'M14 19 50 19 50 51 14 51Z M20 19 20 13 Q20 8 25 8 Q30 8 30 19 M29 19 29 11 Q29 6 34 6 Q39 6 39 19 M38 19 38 13 Q38 8 43 8 Q48 8 48 19',
  medkit:'M12 21 52 21 52 50 12 50Z M25 21 25 14 39 14 39 21 M32 27 32 44 M23 35 41 35',
  turret:'M13 49 32 26 51 49 M21 49 32 29 43 49 M24 20 42 20 42 29 24 29Z M40 22 54 17 54 24 42 28Z',
  'gear-bumper-a':'M9 25 Q12 17 21 17 L43 17 Q52 17 55 25 L52 43 Q50 48 43 48 L21 48 Q14 48 12 43Z M17 33 47 33',
  'gear-bumper-b':'M8 24 17 16 47 16 56 24 53 42 45 48 19 48 11 42Z M12 24 52 24 M12 39 52 39',
  'gear-armor-a':'M13 15 51 15 47 50 17 50Z M19 21 23 21 M41 21 45 21 M20 44 24 44 M40 44 44 44',
  'gear-armor-b':'M12 14 52 14 52 50 12 50Z M17 14 17 50 M24 14 24 50 M32 14 32 50 M40 14 40 50 M47 14 47 50',
  'gear-tires-a':'M32 8 A24 24 0 1 0 32 56 A24 24 0 1 0 32 8Z M32 19 A13 13 0 1 0 32 45 A13 13 0 1 0 32 19Z M20 11 16 16 M44 11 48 16 M20 53 16 48 M44 53 48 48',
  'gear-tires-b':'M32 8 A24 24 0 1 0 32 56 A24 24 0 1 0 32 8Z M32 19 A13 13 0 1 0 32 45 A13 13 0 1 0 32 19Z M15 17 49 47 M49 17 15 47',
  'gear-lights-a':'M32 8 A16 16 0 1 0 32 40 A16 16 0 1 0 32 8Z M32 12 32 36 M13 12 6 5 M51 12 58 5 M32 45 32 55 M17 43 11 51 M47 43 53 51',
  'gear-lights-b':'M13 43 A19 19 0 0 1 51 43Z M32 8 32 26 M24 26 32 14 40 26',
  'gear-roof-a':'M10 20 54 20 M14 40 50 40 M17 20 17 40 M47 20 47 40 M11 47 53 47',
  'gear-roof-b':'M12 43 A20 20 0 0 1 52 43Z M8 48 56 48 M20 41 20 48 M44 41 44 48',
  'gear-paint-a':'M13 16 38 16 38 33 13 33Z M20 33 20 47 31 47 31 33 M42 15 C37 22 37 26 42 28 C47 26 47 22 42 15Z M16 51 39 51',
  'gear-paint-b':'M15 10 39 10 45 16 45 45 15 45Z M22 17 38 17 38 25 22 25Z M47 11 50 6 53 11 59 12 53 16 51 22 48 16 43 14',
  smoke:'M18 18 43 18 46 48 16 48Z M23 18 23 12 38 12 38 18 M20 11 Q12 7 19 2 M33 11 Q26 5 33 1 M44 13 Q53 8 47 3',
  'repair-kit':'M10 24 54 24 54 50 10 50Z M22 24 22 17 42 17 42 24 M21 37 33 31 37 35 27 44 23 42Z M39 38 49 48',
  'med-pack':'M16 14 48 14 52 21 52 50 12 50 12 21Z M23 14 23 9 41 9 41 14 M32 23 32 42 M23 32 41 32',
  flare:'M23 31 41 31 41 51 23 51Z M24 26 40 26 38 32 26 32Z M32 23 26 16 31 17 32 8 37 18 43 13 39 24Z M16 22 10 18 M48 22 54 18',
  'ammo-crate':'M10 19 54 19 54 50 10 50Z M10 19 32 29 54 19 M32 29 32 50 M19 25 19 43 M45 25 45 43 M24 14 Q24 8 29 8 Q34 8 34 19 M35 14 Q35 8 40 8 Q45 8 45 19',
  coolant:'M19 14 45 14 49 51 15 51Z M25 14 25 8 39 8 39 14 M32 21 C25 30 23 34 23 39 A9 9 0 0 0 41 39 C41 34 39 30 32 21Z',
  'badge-seoul':'M32 7 A25 25 0 1 0 32 57 A25 25 0 1 0 32 7Z M24 48 24 27 32 16 40 27 40 48 M20 32 44 32 M28 27 28 48 M36 27 36 48',
  'postcard-incheon':'M9 14 55 14 55 49 9 49Z M14 43 23 34 29 40 39 27 51 43 M18 24 18 19 46 19 M20 19 20 39 M44 19 44 39 M18 39 46 39',
  'badge-gyeonggi':'M32 7 A25 25 0 1 0 32 57 A25 25 0 1 0 32 7Z M32 46 32 20 M26 24 32 18 38 24 M25 31 32 25 39 31 M23 38 32 32 41 38 M21 46 32 39 43 46',
  'postcard-gangwon':'M9 14 55 14 55 49 9 49Z M13 42 25 25 34 38 42 28 52 42 M17 19 46 19 M16 44 49 44',
  'quiz-time-card':'M12 14 52 14 52 50 12 50Z M32 14 32 50 M39 33 A8 8 0 1 0 39 49 A8 8 0 1 0 39 33Z M39 37 39 41 43 43',
  'jump-grip':'M23 11 Q14 11 14 22 L14 43 Q14 52 22 52 Q29 52 30 44 L31 32 32 44 Q33 52 41 52 Q50 52 50 43 L50 22 Q50 11 41 11 Q35 11 32 22 Q29 11 23 11Z M21 26 24 26 M39 26 42 26 M21 35 24 35 M39 35 42 35 M23 44 25 44 M39 44 41 44',
  'wide-catcher':'M7 26 57 26 57 42 7 42Z M7 34 17 26 17 42 M57 34 47 26 47 42 M18 34 46 34',
  'voltage-coil':'M12 24 50 24 50 40 12 40Z M19 20 Q12 32 19 44 M28 20 Q21 32 28 44 M37 20 Q30 32 37 44 M45 20 Q38 32 45 44 M32 6 25 19 32 19 28 29 39 15 33 15Z',
  'insulated-gloves':'M20 50 Q14 49 14 42 L14 27 Q14 21 18 21 Q22 21 22 27 L22 16 Q22 10 26 10 Q30 10 30 16 L30 14 Q30 8 34 8 Q38 8 38 14 L38 17 Q38 11 42 11 Q46 11 46 17 L46 37 Q46 51 35 53Z M35 16 29 29 35 29 32 41 42 26 36 26Z',
};

function sticker(paths, { accent = '#52f1d0', details = '' } = {}) {
  const group = `<g stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
  const interior = details || '<path d="M46 49a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm7 4a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z"/>';
  return `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="${ink}" stroke="${black}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">${paths}</g><g fill="${ink}" stroke="${cream}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${paths}</g><g fill="${ink}" stroke="none">${paths}</g><g fill="${accent}" stroke="none">${interior}</g></svg>`;
}
function genericShape(id) {
  let hash = 0; for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const x = 12 + hash % 8, y = 12 + (hash >>> 4) % 8;
  return `M${x} ${y} Q32 4 ${52-x+12} ${y} L50 43 Q32 60 14 43Z M25 24 39 24 39 39 25 39Z`;
}
export function itemIcon(item = {}) {
  const id = item.id || item.icon || item.category || 'part';
  const shape = silhouettes[id] || genericShape(id);
  const accent = item.scope === 'specialized' ? '#ffd094' : '#52f1d0';
  return sticker(shape, { accent });
}
export function itemScope(item) { return item?.scope ?? (item?.region || Object.keys(item?.deadzone ?? {}).length ? 'specialized' : 'common'); }
export const scopeLabel = scope => scope === 'specialized' ? '특화 아이템' : '공통 아이템';
export function itemBadge(item, { size = 'md' } = {}) {
  const badge = document.createElement('span'); badge.className = `item-badge item-badge-${size}`; badge.dataset.scope = itemScope(item); badge.dataset.rarity = item?.rarity || 'common';
  badge.innerHTML = itemIcon(item); if (item?.region) { const chip = document.createElement('small'); chip.className = 'item-region'; chip.textContent = ({ seoul: '서울', incheon: '인천', gyeonggi: '경기', gangwon: '강원' })[item.region] || ''; badge.append(chip); }
  return badge;
}
if (typeof customElements !== 'undefined' && !customElements.get('ply-supply-icon')) customElements.define('ply-supply-icon', class extends HTMLElement { connectedCallback() { this.classList.add('item-badge'); this.dataset.scope = 'common'; this.setAttribute('aria-hidden', 'true'); this.innerHTML = itemIcon({ id: 'supply' }); } });
