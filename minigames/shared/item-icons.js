const legacy = {
  box: '<path d="M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4m-8 4v8"/>',
  battery: '<rect x="5" y="7" width="13" height="10" rx="2"/><path d="M20 10v4m-12-2h6m-3-3v6"/>',
  cross: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  can: '<path d="M7 8h10v12H7zM10 8V4h4v4m-3 4 2 4m0-4-2 4"/>',
  cell: '<path d="M12 4c3 4 6 7 6 10a6 6 0 0 1-12 0c0-3 3-6 6-10z"/>',
};

function uniqueShape(id) {
  let hash = 2166136261;
  for (const ch of String(id || 'item')) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const x = n => 3 + ((hash >>> (n % 24)) % 18);
  const y = n => 3 + ((hash >>> ((n + 7) % 24)) % 18);
  const kind = hash % 5;
  if (kind === 0) return `<path d="M${x(0)} ${y(1)} Q${x(2)} ${y(3)} ${x(4)} ${y(5)} L${x(6)} ${y(7)} Q${x(8)} ${y(9)} ${x(10)} ${y(11)} Z M${x(12)} ${y(13)} L${x(14)} ${y(15)}"/>`;
  if (kind === 1) return `<path d="M${x(0)} ${y(1)} L${x(2)} ${y(3)} L${x(4)} ${y(5)} L${x(6)} ${y(7)} Z M${x(8)} ${y(9)} Q${x(10)} ${y(11)} ${x(12)} ${y(13)}"/>`;
  if (kind === 2) return `<path d="M${x(0)} ${y(1)} C${x(2)} ${y(3)} ${x(4)} ${y(5)} ${x(6)} ${y(7)} S${x(8)} ${y(9)} ${x(10)} ${y(11)} M${x(12)} ${y(13)} L${x(14)} ${y(15)}"/>`;
  if (kind === 3) return `<path d="M${x(0)} ${y(1)} A${x(2)} ${y(3)} 0 1 0 ${x(4)} ${y(5)} A${x(6)} ${y(7)} 0 1 0 ${x(0)} ${y(1)} M${x(8)} ${y(9)} L${x(10)} ${y(11)}"/>`;
  return `<path d="M${x(0)} ${y(1)} L${x(2)} ${y(3)} Q${x(4)} ${y(5)} ${x(6)} ${y(7)} L${x(8)} ${y(9)} M${x(10)} ${y(11)} L${x(12)} ${y(13)}"/>`;
}

export function itemIcon(item = {}) {
  const shape = item.id ? uniqueShape(item.id) : legacy[item.icon] || uniqueShape(item.icon || item.category);
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
}
export function itemScope(item) { return item?.scope ?? (item?.region || Object.keys(item?.deadzone ?? {}).length ? 'specialized' : 'common'); }
export const scopeLabel = scope => scope === 'specialized' ? '특화 아이템' : '공통 아이템';
export function itemBadge(item, { size = 'md' } = {}) {
  const badge = document.createElement('span'); badge.className = `item-badge item-badge-${size}`; badge.dataset.scope = itemScope(item); badge.dataset.rarity = item?.rarity || 'common';
  badge.innerHTML = itemIcon(item); if (item?.region) { const chip = document.createElement('small'); chip.className = 'item-region'; chip.textContent = ({ seoul: '서', incheon: '인', gyeonggi: '경', gangwon: '강' })[item.region] || ''; badge.append(chip); }
  return badge;
}
if (typeof customElements !== 'undefined' && !customElements.get('ply-supply-icon')) customElements.define('ply-supply-icon', class extends HTMLElement { connectedCallback() { this.classList.add('item-badge'); this.dataset.scope = 'common'; this.setAttribute('aria-hidden', 'true'); this.innerHTML = itemIcon({ id: 'supply', icon: 'box' }); } });
