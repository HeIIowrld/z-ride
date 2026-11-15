import { itemBadge } from './item-icons.js';

const icon = (name) => ({ drop: '◉', up: '↑', down: '↓', jump: '↗', mute: '◖', settings: '⋯', rain: '⌁', road: '⌁' })[name] || '•';

export function mountDoorHud(stage, { game, controls = [], items = [] } = {}) {
  const panel = document.createElement('section');
  panel.className = 'door-hud'; panel.setAttribute('aria-label', '게임 계기판');
  panel.innerHTML = `<div class="door-instrument"><div class="door-score"><small>점수</small><strong id="door-score">0</strong><span class="door-combo hidden" id="door-combo">×0</span></div><div class="door-status"><b><i id="door-status-icon">⌁</i><span id="door-status">준비</span></b><small id="door-mode">연습</small></div><div class="door-speed"><strong><span id="door-speed">40</span><small>km/h</small></strong><small id="door-limit">제한 60</small></div></div><div class="door-items" aria-label="획득 아이템"></div><div class="door-handle" aria-hidden="true"><i></i></div><div class="door-controls"></div><div class="door-water" aria-label="물 게이지"><i></i></div>`;
  stage.append(panel);
  const tray = panel.querySelector('.door-items');
  for (const item of (items.length ? items.slice(0, 3) : [{ id: 'coolant', count: 0 }, { id: 'part', count: 0 }, { id: 'gear-tires-a', count: 0 }])) { const slot = document.createElement('span'); slot.className = 'door-item-slot'; slot.append(itemBadge(item, { size: 'sm' })); const count = document.createElement('b'); count.textContent = String(item.count || 0); slot.append(count); tray.append(slot); }
  const row = panel.querySelector('.door-controls');
  for (const control of controls) { const button = document.getElementById(control.id); if (!button) continue; button.classList.add('door-control'); if (control.primary) button.classList.add('is-primary'); button.innerHTML = `<span aria-hidden="true">${icon(control.icon)}</span><b>${control.label}</b>`; row.append(button); }
  const legacyHeight = stage.querySelector('.height-control');
  if (legacyHeight) { const label = legacyHeight.querySelector('#height-name'); if (label) { label.classList.add('hidden'); panel.append(label); } legacyHeight.remove(); }
  const mute = document.getElementById('mute'); if (mute) { mute.innerHTML = icon('mute'); mute.setAttribute('aria-label', '소리 켜기 또는 끄기'); }
  return { panel, update({ score, combo, status, mode, speed, limit, water, items: latest } = {}) {
    if (score != null) panel.querySelector('#door-score').textContent = Number(score).toLocaleString('ko-KR');
    const comboEl = panel.querySelector('#door-combo'); if (combo != null) { comboEl.textContent = `×${combo}`; comboEl.classList.toggle('hidden', combo <= 1); }
    for (const [id, value] of [['door-status', status], ['door-mode', mode], ['door-speed', speed == null ? null : Math.round(speed)], ['door-limit', limit == null ? '제한 —' : `제한 ${Math.round(limit)}`]]) if (value != null) panel.querySelector(`#${id}`).textContent = value;
    panel.querySelector('.door-speed').classList.toggle('is-over', Number.isFinite(speed) && Number.isFinite(limit) && speed > limit);
    if (water != null) panel.querySelector('.door-water i').style.width = `${Math.max(0, Math.min(100, water))}%`;
    if (latest) { const slots = [...tray.children]; slots.forEach((slot, i) => { slot.hidden = !latest[i]; if (latest[i]) slot.querySelector('b').textContent = String(latest[i].count || 0); }); }
  }};
}

export function findLayoutOverlaps(container, selector) {
  const elements = [...container.querySelectorAll(selector)].filter(element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const overlaps = [];
  for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
    const a = elements[i].getBoundingClientRect(), b = elements[j].getBoundingClientRect();
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
      overlaps.push([elements[i].id || elements[i].className, elements[j].id || elements[j].className]);
    }
  }
  return overlaps;
}
