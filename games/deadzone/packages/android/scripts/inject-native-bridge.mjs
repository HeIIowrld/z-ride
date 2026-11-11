/*  Post-sync step.

    `npx cap sync android` replaces app/src/main/assets/public wholesale with a
    copy of packages/client/dist. This runs straight afterwards and does two
    things to that copy — never to the web build itself:

      1. drops in web/native-online.js, with the deployment hostname baked in
      2. adds one classic <script> tag at the top of <head> so it runs before
         the game's module bundle

    It also refuses to continue if the web assets look wrong, because an APK
    built from an empty assets/public installs, launches and shows a white
    screen, which is the most expensive failure mode in this pipeline.        */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const publicDir = resolve(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const shimSource = resolve(root, 'web', 'native-online.js');
const configPath = resolve(root, 'capacitor.config.json');

const SHIM_NAME = 'native-online.js';
const TAG = `<script src="/${SHIM_NAME}"></script>`;
const MIN_BYTES = 900 * 1024;

function die(message) {
  console.error(`\n[overrun] FATAL: ${message}\n`);
  process.exit(1);
}

function bytesIn(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? bytesIn(full) : statSync(full).size;
  }
  return total;
}

/* ------------------------------------------------------- sanity checks */

if (!existsSync(publicDir)) {
  die(`${publicDir} does not exist. Run \`npm run build\` at the repo root, then \`npm run sync\` here.`);
}

for (const required of ['index.html', 'assets', 'icons', 'manifest.webmanifest']) {
  if (!existsSync(join(publicDir, required))) {
    die(`${required} is missing from the copied web assets. The client build is incomplete.`);
  }
}

const total = bytesIn(publicDir);
if (total < MIN_BYTES) {
  die(`copied web assets are only ${(total / 1024).toFixed(0)} kB, expected more than ${MIN_BYTES / 1024} kB. The build did not land.`);
}

/* ----------------------------------------------------------- injection */

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const host = (config.server && config.server.hostname) || '';
if (!host) die('capacitor.config.json has no server.hostname.');

const shim = readFileSync(shimSource, 'utf8').replaceAll('__OVERRUN_HOST__', host);
writeFileSync(join(publicDir, SHIM_NAME), shim);

const indexPath = join(publicDir, 'index.html');
let html = readFileSync(indexPath, 'utf8');

if (!html.includes(TAG)) {
  if (!/<head[^>]*>/i.test(html)) die('index.html has no <head> to inject into.');
  html = html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${TAG}`);
  writeFileSync(indexPath, html);
}

console.log(`[overrun] web assets: ${(total / 1024).toFixed(0)} kB in ${publicDir}`);
console.log(`[overrun] injected ${SHIM_NAME} (online host: ${host})`);
