import { readFileSync } from 'node:fs';
import { checkedOrigin } from './request-policy.mjs';

const FILES = new Map([
  ['/play', ['index.html', 'text/html; charset=utf-8']],
  ['/play/', ['index.html', 'text/html; charset=utf-8']],
  ['/play/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/play/account.js', ['account.js', 'text/javascript; charset=utf-8']],
  ['/play/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

/** PHONE client: account tokens in tab sessionStorage, play tokens in memory. */
export function createPhoneClientService({apiOrigin='',displayName='Z-RIDE'}={}) {
  if(apiOrigin)apiOrigin=checkedOrigin(apiOrigin);
  const assets = new Map([...FILES].map(([path, [file, type]]) => [path, {
    bytes: file==='index.html'?Buffer.from(readFileSync(new URL('./phone-client/' + file, import.meta.url),'utf8').replaceAll('Z-RIDE',displayName.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll("'",'&#39;'))):readFileSync(new URL('./phone-client/' + file, import.meta.url)), type,
  }]));
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
        'content-security-policy': "default-src 'none'; img-src data:; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/" + socketSources + (apiOrigin?' '+apiOrigin+' '+apiOrigin.replace(/^http/,'ws'):'') + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'cross-origin-opener-policy': 'same-origin-allow-popups',
        'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      });
      res.end(req.method === 'HEAD' ? undefined : file.bytes); return true;
    },
  };
}
