/* Generates dist/sw.js with a precache list derived from what Vite actually
   emitted. Hand-maintaining that list is how offline support silently rots. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../dist');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(dist)
  .map(p => '/' + relative(dist, p).split('\\').join('/'))
  .filter(p => !p.endsWith('/sw.js') && !p.endsWith('.map'));

// The shell has to be reachable by path as well as by hashed asset name.
const precache = Array.from(new Set(['/', '/index.html', ...files]));

const hash = createHash('sha1').update(precache.join('|')).digest('hex').slice(0, 12);

const tpl = readFileSync(join(here, '../src/sw-template.js'), 'utf8')
  .replace('__BUILD_HASH__', hash)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));

writeFileSync(join(dist, 'sw.js'), tpl);

const bytes = walk(dist).reduce((a, p) => a + statSync(p).size, 0);
console.log(`sw.js: ${precache.length} entries, build ${hash}`);
console.log(`dist total: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
