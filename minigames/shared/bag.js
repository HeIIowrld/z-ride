import { getInventory } from './inventory.js';
import { itemBadge, itemScope, scopeLabel } from './item-icons.js';

const items = await fetch(new URL('../data/items.json', import.meta.url)).then(response => response.json());
const tabs = document.querySelector('#tabs');
const cards = document.querySelector('#cards');
const categories = {
  weapon: '무기', part: '부품', gear: '장비', consumable: '소모품', souvenir: '기념품',
};
const rarities = { common: '일반', uncommon: '고급', rare: '희귀', regional: '지역 한정' };
const scopes = ['common', 'specialized'];

if (new URLSearchParams(location.search).get('journey') === '1') {
  document.querySelector('#bag-back').hidden = true;
  document.querySelector('#bag-codex').hidden = true;
  document.querySelector('#bag-note').hidden = false;
}

const scopeButtons = scopes.map(scope => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = scopeLabel(scope);
  button.onclick = () => render(scope);
  return button;
});
tabs.append(...scopeButtons);

function render(scope) {
  scopeButtons.forEach((button, index) => {
    button.setAttribute('aria-pressed', String(scopes[index] === scope));
  });
  const counts = getInventory();
  const owned = items.filter(item => itemScope(item) === scope && counts[item.id] > 0);
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
  empty.textContent = '아직 획득한 아이템이 없어요.';
  cards.replaceChildren(...(groups.length ? groups : [empty]));
}
render('common');
