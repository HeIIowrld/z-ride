import { itemBadge, itemScope, scopeLabel } from './item-icons.js';

const categories = {
  weapon: '무기', part: '부품', gear: '장비', consumable: '소모품', souvenir: '기념품',
};
const rarities = { common: '일반', uncommon: '고급', rare: '희귀', regional: '지역 한정' };
const scopes = ['common', 'specialized'];

export async function createBag(tabs, cards, crewBag = false) {
  const items = await fetch(new URL('../data/items.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error('Item catalog unavailable');
    return response.json();
  }).catch(() => null);
  let scope = 'common';
  let counts;
  const buttons = scopes.map(value => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = scopeLabel(value);
    button.onclick = () => render(value);
    return button;
  });
  tabs.replaceChildren(...buttons);

  function render(activeScope) {
    scope = activeScope;
    buttons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(scopes[index] === scope));
    });
    const owned = (items ?? []).filter(item => itemScope(item) === scope && counts?.[item.id] > 0);
    const groups = Object.entries(categories).flatMap(([category, name]) => {
      const matching = owned.filter(item => item.category === category);
      if (!matching.length) return [];
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = name;
      const grid = document.createElement('div');
      grid.className = 'loot-card-grid';
      grid.append(...matching.map(item => {
        const card = document.createElement('article');
        card.className = 'loot-card';
        const content = document.createElement('div');
        const title = document.createElement('h4');
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
    const collection = crewBag ? '크루가 획득한 ' : '획득한 ';
    empty.textContent = !items ? '아이템을 불러오지 못했어요. 가방을 다시 열어 주세요.'
      : !counts ? '크루 가방을 여는 중…'
      : collection + (scope === 'common' ? '공통 아이템이 없어요.' : '게임 특화 아이템이 없어요.');
    cards.replaceChildren(...(groups.length ? groups : [empty]));
  }

  render(scope);
  return next => {
    if (counts && Object.keys(next).length === Object.keys(counts).length &&
        Object.entries(next).every(([id, count]) => counts[id] === count)) return;
    counts = next;
    render(scope);
  };
}

const standalone = document.querySelector('body.ply-bag');
if (standalone) {
  const { getInventory } = await import('./inventory.js');
  const update = await createBag(document.querySelector('#tabs'), document.querySelector('#cards'));
  update(getInventory());
}
