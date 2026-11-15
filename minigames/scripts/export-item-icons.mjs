import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemIcon } from '../shared/item-icons.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(resolve(root, 'data/items.json'), 'utf8'));
const directory = resolve(root, 'shared/assets/items');
await mkdir(directory, { recursive: true });
for (const item of data) {
  const icon = itemIcon(item).replace('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" ', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ');
  const color = item.scope === 'specialized' ? '#ffd094' : '#52f1d0';
  await writeFile(resolve(directory, `${item.id}.svg`), icon.replace('stroke="currentColor"', `stroke="${color}"`) + '\n', 'utf8');
}
console.log(`Exported ${data.length} item icons to shared/assets/items/`);
