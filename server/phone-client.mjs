import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkedOrigin } from './request-policy.mjs';

const FILES = new Map([
  ['/play', ['index.html', 'text/html; charset=utf-8']],
  ['/play/', ['index.html', 'text/html; charset=utf-8']],
  ['/play/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/play/account.js', ['account.js', 'text/javascript; charset=utf-8']],
  ['/play/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/play/vehicle', ['vehicle.html', 'text/html; charset=utf-8']],
  ['/play/vehicle/', ['vehicle.html', 'text/html; charset=utf-8']],
  ['/play/vehicle.js', ['vehicle.js', 'text/javascript; charset=utf-8']],
  ['/play/demo', ['demo.html', 'text/html; charset=utf-8']],
  ['/play/demo/', ['demo.html', 'text/html; charset=utf-8']],
  ['/play/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['/play/arena.js', ['arena.js', 'text/javascript; charset=utf-8']],
  ['/play/arena.css', ['arena.css', 'text/css; charset=utf-8']],
  ['/play/car', ['car.html', 'text/html; charset=utf-8']],
  ['/play/car.js', ['car.js', 'text/javascript; charset=utf-8']],
  ['/play/car.css', ['car.css', 'text/css; charset=utf-8']],
  ['/play/qr.js', ['qr.js', 'text/javascript; charset=utf-8']],
]);

const DRIVE_GAMES = {
  'license-quiz': ['questions.json', 'signs.js'],
  'pole-jump': [],
  raindrop: [],
};
const DRIVE_FILES = [
  'style.css',
  ...Object.entries(DRIVE_GAMES).flatMap(([game, extra]) =>
    ['index.html', 'game.js', 'game.css', ...extra].map(file => 'games/' + game + '/' + file)),
  ...['config', 'inventory', 'loot-client', 'loot-engine', 'loot-tracker', 'passenger', 'quiz-engine',
    'journey', 'records', 'seat', 'sketch', 'vehicle'].map(file => 'shared/' + file + '.js'),
  ...['items', 'loot_tables', 'points'].map(file => 'data/' + file + '.json'),
];
const DRIVE_TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };

/** PHONE client: account tokens in tab sessionStorage, play tokens in memory. */
export function createPhoneClientService({apiOrigin='',displayName='Z-RIDE'}={}) {
  if(apiOrigin)apiOrigin=checkedOrigin(apiOrigin);
  const assets = new Map([...FILES].map(([path, [file, type]]) => [path, {
    bytes: file.endsWith('.html')?Buffer.from(readFileSync(new URL('./phone-client/' + file, import.meta.url),'utf8').replaceAll('Z-RIDE',displayName.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll("'",'&#39;'))):readFileSync(new URL('./phone-client/' + file, import.meta.url)), type,
  }]));
  const bundledDrive = new URL('./drive-assets/', import.meta.url);
  const driveRoot = existsSync(bundledDrive) ? bundledDrive : new URL('../minigames/', import.meta.url);
  for (const file of DRIVE_FILES) {
    const type = DRIVE_TYPES[file.split('.').at(-1)] + '; charset=utf-8';
    assets.set('/play/drive/' + file, { bytes: readFileSync(new URL(file, driveRoot)), type });
  }
  assets.set('/play/qrcode.js',{bytes:readFileSync(createRequire(import.meta.url).resolve('qrcode-generator')),type:'text/javascript; charset=utf-8'});
  assets.set('/play/config.js',{bytes:Buffer.from('window.GAME_CONFIG=window.ZRIDE_CONFIG=Object.freeze('+JSON.stringify({apiOrigin,displayName})+');\n'),type:'text/javascript; charset=utf-8'});
  return {
    handleHttp(req, res, path) {
      if (path !== '/play' && !path.startsWith('/play/')) return false;
      const file = assets.get(path);
      if (!file || !['GET', 'HEAD'].includes(req.method)) {
        req.resume();
        res.writeHead(file ? 405 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not available'); return true;
      }
      // Explicit same-host WS schemes also work in browsers where CSP 'self'
      // does not match the ws/wss scheme. Never interpolate an unchecked Host.
      let socketSources = '';
      const hostHeader = req.headers.host ?? '';
      if (/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(hostHeader)) {
        try { const host = new URL('http://' + hostHeader).host; socketSources = ' ws://' + host + ' wss://' + host; } catch {}
      }
      res.writeHead(200, {
        'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src data:; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src 'self' https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/" + socketSources + (apiOrigin?' '+apiOrigin+' '+apiOrigin.replace(/^http/,'ws'):'') + "; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
        'cross-origin-opener-policy': 'same-origin-allow-popups',
        'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      });
      res.end(req.method === 'HEAD' ? undefined : file.bytes); return true;
    },
  };
}
