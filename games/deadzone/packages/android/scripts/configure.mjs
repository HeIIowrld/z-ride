/*  Pre-sync step.

    The packaged app's origin is the production hostname — that is what makes
    `wss://<host>/ws` reach the real Cloudflare Worker while every asset still
    comes off the disk inside the APK. That hostname therefore has to be right,
    and it is different for every deployment, so it can be overridden from the
    environment instead of being edited by hand in CI:

        OVERRUN_HOST=overrun.mysubdomain.workers.dev npm run sync

    With no environment variable set this only prints what is already in
    capacitor.config.json.                                                    */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '..', 'capacitor.config.json');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const override = (process.env.OVERRUN_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

if (override) {
  config.server = config.server || {};
  config.server.hostname = override;
  config.server.allowNavigation = [override];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`[overrun] server.hostname set from OVERRUN_HOST: ${override}`);
} else {
  console.log(`[overrun] server.hostname: ${config.server?.hostname}`);
}

if (/(^|\.)example\./.test(config.server?.hostname || '') || config.server?.hostname === 'overrun.workers.dev') {
  console.warn(
    '[overrun] WARNING: server.hostname is still the placeholder. Offline play will\n' +
    '          work, but online matchmaking will not. Set it to the deployed Worker\n' +
    '          host (e.g. overrun.<your-subdomain>.workers.dev) in\n' +
    '          packages/android/capacitor.config.json, or export OVERRUN_HOST.'
  );
}
