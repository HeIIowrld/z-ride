import { existsSync } from 'node:fs';

const release = new URL('./drive-assets/shared/deadzone-loadout.js', import.meta.url);
const source = new URL('../minigames/shared/deadzone-loadout.js', import.meta.url);
const engine = existsSync(release) ? release : source;
const build = existsSync(engine) ? (await import(engine.href)).buildDeadzoneLoadout : null;

export function crewGameItems(catalog, game, room, players) {
  const inventory = { ...room.collection.inventory, supply: room.collection.inventory.supplies };
  const items = catalog.filter(item => inventory[item.id] > 0);
  if (game === 'volt-rush') {
    return { items: items.filter(item => item.voltRush).map(item =>
      ({ id: item.id, name: item.name, kind: item.voltRush, count: inventory[item.id] })) };
  }
  const gear = new Map();
  const rarity = ['common', 'uncommon', 'rare', 'regional'];
  for (const item of items) {
    if (!item.slot) continue;
    const equipped = gear.get(item.slot);
    if (!equipped || rarity.indexOf(item.rarity) > rarity.indexOf(equipped.rarity)) gear.set(item.slot, item);
  }
  const hour = (new Date().getUTCHours() + 9) % 24;
  const loadout = build?.({
    inventory, players, equipment: [...gear.values()].map(item => item.id),
  }, { night: hour < 6 || hour >= 19 });
  return { loadout, items: items.filter(item => item.deadzone?.kind).map(item =>
    ({ id: item.id, name: item.name, kind: item.deadzone.kind, count: inventory[item.id] })) };
}

export function routeBonusCatalog(items) {
  const starting = ['coil-launcher', 'voltage-coil', 'repair-kit', 'insulated-gloves', 'neon-shield', 'signal-dart', 'battery-cell'];
  const available = items.filter(item => !item.driveGame && item.id !== 'supply');
  return [...starting.map(id => available.find(item => item.id === id)).filter(Boolean),
    ...available.filter(item => !starting.includes(item.id))];
}
