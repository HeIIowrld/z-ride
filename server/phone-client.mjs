import { readFileSync } from 'node:fs';

const FILES = new Map([
  ['/play', ['index.html', 'text/html; charset=utf-8']],
  ['/play/', ['index.html', 'text/html; charset=utf-8']],
  ['/play/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/play/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

/** Same-origin reference PHONE client. Credentials stay in browser memory. */
export function createPhoneClientService() {
  const assets = new Map([...FILES].map(([path, [file, type]]) => [path, {
    bytes: readFileSync(new URL('./phone-client/' + file, import.meta.url)), type,
  }]));
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
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" + socketSources + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      });
      res.end(req.method === 'HEAD' ? undefined : file.bytes); return true;
    },
  };
}
