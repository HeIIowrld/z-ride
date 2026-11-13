import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'shared/item-icons.js'), 'utf8');
const data = JSON.parse(await readFile(resolve(root, 'data/items.json'), 'utf8'));
const shapeDefs = source.match(/const categoryShapes = \{([\s\S]*?)\n\};\nconst itemShapes = \{([\s\S]*?)\n\};/);
if (!shapeDefs) throw new Error('Could not read item icon definitions');
const parseShapes = text => Object.fromEntries([...text.matchAll(/([\w]+):\s*'([^']*)'/g)].map(([, key, value]) => [key, value]));
const shapes = { ...parseShapes(shapeDefs[1]), ...parseShapes(shapeDefs[2]) };
const directory = resolve(root, 'shared/assets/items');
await mkdir(directory, { recursive: true });
for (const item of data) {
  const shape = shapes[item.icon] ?? shapes[item.category] ?? shapes.part;
  const color = item.scope === 'specialized' ? '#ffd094' : '#52f1d0';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>\n`;
  await writeFile(resolve(directory, `${item.id}.svg`), svg, { encoding: 'utf8' });
}
console.log(`Exported ${data.length} item icons to shared/assets/items/`);
