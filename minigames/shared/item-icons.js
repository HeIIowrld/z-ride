const categoryShapes = {
  weapon: '<path d="M5 19 18 6m-3-1 4 4M4 15l5 5"/>',
  part: '<rect x="5" y="5" width="14" height="14"/><path d="M9 9h6v6H9z"/>',
  gear: '<path d="M4 8h16l-2 9H6zM4 8l2-3h12l2 3"/>',
  consumable: '<path d="M8 4h8v3l2 2v11H6V9l2-2zM8 7h8"/>',
  souvenir: '<path d="M5 5h14v14H5zM8 8h8v5H8zM8 16h8"/>',
};
const itemShapes = {
  box: '<path d="M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4m-8 4v8M8 6l8 4"/>',
  battery: '<rect x="5" y="7" width="13" height="10" rx="2"/><path d="M20 10v4m-12-2h6m-3-3v6"/>',
  cross: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  can: '<path d="M7 8h10v12H7zM10 8V4h4v4m-3 4 2 4m0-4-2 4"/>',
  cell: '<path d="M12 4c3 4 6 7 6 10a6 6 0 0 1-12 0c0-3 3-6 6-10z"/>',
  shield: '<path d="m12 4 7 3v5c0 4-3 6-7 8-4-2-7-4-7-8V7z"/>',
  tool: '<path d="m14 8 3-3a5 5 0 0 0-6 6l-6 6 2 2 6-6a5 5 0 0 0 6-6l-3 3z"/>',
};

export function itemIcon(item) {
  const shape = Object.hasOwn(itemShapes, item?.icon) ? itemShapes[item.icon]
    : Object.hasOwn(categoryShapes, item?.category) ? categoryShapes[item.category] : categoryShapes.part;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
}

export function itemScope(item) {
  // Old loot logs store the full item as it was at the time of collection.
  return item?.scope ?? (item?.region || Object.keys(item?.deadzone ?? {}).length ? 'specialized' : 'common');
}

export const scopeLabel = scope => scope === 'specialized' ? '특화 아이템' : '공통 아이템';

export function itemBadge(item) {
  const badge = document.createElement('span');
  badge.className = 'item-badge';
  badge.dataset.scope = itemScope(item);
  badge.innerHTML = itemIcon(item);
  return badge;
}

if (typeof customElements !== 'undefined') {
  customElements.define('ply-supply-icon', class extends HTMLElement {
    connectedCallback() {
      this.classList.add('item-badge');
      this.dataset.scope = 'common';
      this.setAttribute('aria-hidden', 'true');
      this.innerHTML = itemIcon({ icon: 'box' });
    }
  });
}
