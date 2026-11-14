import { itemBadge, itemScope, scopeLabel } from './item-icons.js';

const tabs = document.querySelector('#tabs');
const cards = document.querySelector('#cards');
const items = await fetch(new URL('../data/items.json', import.meta.url)).then(response => {
  if (!response.ok) throw new Error('Item catalog unavailable');
  return response.json();
}).catch(() => null);
const categories = {
  weapon: '무기', part: '부품', gear: '장비', consumable: '소모품', souvenir: '기념품',
};
const rarities = { common: '일반', uncommon: '고급', rare: '희귀', regional: '지역 한정' };
const scopes = ['common', 'specialized'];
const crewBag = new URLSearchParams(location.search).get('journey') === '1';
let parentOrigin;
let scope = 'common';
let counts;

if (crewBag) {
  document.body.classList.add('crew-bag');
  document.querySelector('#bag-back').hidden = true;
  document.querySelector('#bag-codex').hidden = true;
  document.querySelector('#bag-note').hidden = false;
  if (window.parent !== window && document.referrer) {
    const origin = new URL(document.referrer).origin;
    parentOrigin = origin;
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.origin !== origin ||
          event.data?.type !== 'ply:crew-inventory') return;
      const { supplies, ...itemsById } = event.data.inventory ?? {};
      const next = { ...itemsById, supply: supplies };
      if (counts && Object.keys(next).length === Object.keys(counts).length &&
          Object.entries(next).every(([id, count]) => counts[id] === count)) return;
      counts = next;
      render(scope);
    });
  }
} else {
  const { getInventory } = await import('./inventory.js');
  counts = getInventory();
}

const scopeButtons = scopes.map(scope => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = scopeLabel(scope);
  button.onclick = () => render(scope);
  return button;
});
tabs.append(...scopeButtons);

function render(activeScope) {
  scope = activeScope;
  scopeButtons.forEach((button, index) => {
    button.setAttribute('aria-pressed', String(scopes[index] === scope));
  });
  const owned = (items ?? []).filter(item => itemScope(item) === scope && counts?.[item.id] > 0);
  const groups = Object.entries(categories).flatMap(([category, name]) => {
    const matching = owned.filter(item => item.category === category);
    if (!matching.length) return [];
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = name;
    const grid = document.createElement('div');
    grid.className = 'loot-cards';
    grid.append(...matching.map(item => {
      const card = document.createElement('article');
      card.className = 'loot-card';
      const content = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = item.name;
      const meta = document.createElement('small');
      meta.textContent = `${rarities[item.rarity]} · 수량 ${counts[item.id]}`;
      const description = document.createElement('p');
      description.textContent = item.description;
      const stats = document.createElement('p');
      stats.textContent = Object.entries({ defense: '방어', detection: '탐지', escape: '탈출', attack: '공격' })
        .filter(([stat]) => item.stats[stat])
        .map(([stat, label]) => `${label} +${item.stats[stat]}`).join(' · ');
      content.append(title, meta, description);
      if (stats.textContent) content.append(stats);
      card.append(itemBadge(item), content);
      return card;
    }));
    section.append(heading, grid);
    return [section];
  });
  const empty = document.createElement('p');
  empty.className = 'bag-empty';
  empty.setAttribute('role', 'status');
  empty.textContent = !items ? '아이템을 불러오지 못했어요. 가방을 다시 열어 주세요.'
    : !counts ? '크루 아이템을 불러오는 중이에요.'
    : scope === 'common' ? '크루가 획득한 공통 아이템이 없어요.' : '크루가 획득한 게임 특화 아이템이 없어요.';
  cards.replaceChildren(...(groups.length ? groups : [empty]));
}
render('common');
if (parentOrigin) window.parent.postMessage({ type: 'ply:crew-bag-ready' }, parentOrigin);
