import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(await readFile(resolve(root, 'data/items.json'), 'utf8'));
const ids = new Set(items.map(item => item.id));
const files = await readdir(resolve(root, 'shared/assets/items'));
const shapes = [];
for (const item of items) {
  if (!files.includes(`${item.id}.svg`)) throw new Error(`Missing icon SVG: ${item.id}`);
  const svg = await readFile(resolve(root, 'shared/assets/items', `${item.id}.svg`), 'utf8');
  shapes.push(svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')));
}
if (new Set(shapes).size !== 40 || items.length !== 40) throw new Error('Expected 40 distinct catalog icon shapes');
const rewardSources = [
  await readFile(resolve(root, 'data/loot_tables.json'), 'utf8'),
  await readFile(resolve(root, 'games/raindrop/game.js'), 'utf8'),
  await readFile(resolve(root, 'games/pole-jump/game.js'), 'utf8'),
  await readFile(resolve(root, 'games/license-quiz/game.js'), 'utf8'),
];
const known = new Set(['part', 'turret', 'supply', 'coolant', 'ammo', 'medkit']);
for (const source of rewardSources) for (const match of source.matchAll(/["']([a-z][a-z0-9-]{1,40})["']/g)) if (ids.has(match[1])) known.add(match[1]);
if (!known.size) throw new Error('No catalog reward IDs found');
const inventory = await readFile(resolve(root, 'shared/inventory.js'), 'utf8');
if (/export const ITEMS\s*=\s*Object\.freeze\(\{/.test(inventory)) throw new Error('Inventory contains hardcoded item names');
console.log(`PASS item assets: ${items.length} unique shapes, ${files.filter(name => name.endsWith('.svg')).length} SVGs, reward IDs checked`);
