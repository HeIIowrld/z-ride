/* ====================== LANDING → WORKER MODULE =========================

   The Worker has to hand back the page as a string, and the page has to stay
   editable as an ordinary HTML file. This script is the join between the two:
   it inlines index.html into src/worker.js as a template literal.

   Run it after any edit to index.html:

       node packages/landing/tools/build-worker.mjs

   It rewrites only the region between the two GENERATED markers, so the
   handwritten half of worker.js is never touched.                          */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const workerPath = join(here, '..', 'src', 'worker.js');
const worker = readFileSync(workerPath, 'utf8');

/* Backslash first, or the escapes we add get escaped again. */
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const START = '/* ---8<--- GENERATED: do not edit below, run tools/build-worker.mjs ---8<--- */';
const END = '/* ---8<--- END GENERATED ---8<--- */';

const block = START + '\nexport const LANDING_HTML = `' + escaped + '`;\n' + END;

const a = worker.indexOf(START), b = worker.indexOf(END);
if (a < 0 || b < 0) throw new Error('markers missing in src/worker.js');

writeFileSync(workerPath, worker.slice(0, a) + block + worker.slice(b + END.length));

const raw = Buffer.byteLength(html);
const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`index.html  ${raw} B raw  ${gz} B gzipped  ->  src/worker.js`);
