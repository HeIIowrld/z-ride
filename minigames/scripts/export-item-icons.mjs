import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemIcon } from '../shared/item-icons.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(resolve(root, 'data/items.json'), 'utf8'));
const directory = resolve(root, 'shared/assets/items');
await mkdir(directory, { recursive: true });
for (const item of data) {
  const icon = itemIcon(item).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  await writeFile(resolve(directory, `${item.id}.svg`), icon + '\n', 'utf8');
}
console.log(`Exported ${data.length} item icons to shared/assets/items/`);
