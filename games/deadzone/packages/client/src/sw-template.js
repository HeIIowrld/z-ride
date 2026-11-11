/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* ============================ SERVICE WORKER ============================

   OVERRUN has to work with the network cut. That is not a nice-to-have here:
   a meaningful share of the audience is on a connection that drops, and the
   whole single-player game is local anyway — there is no reason for a tunnel
   or a lift to end a run.

   Strategy:
     • precache    every build artefact, at install, atomically
     • navigation  network-first with a fast timeout, falling back to the
                   cached shell — so a deep link like /j/ABC123 still opens
                   the game when offline
     • api / ws    never cached, never intercepted
     • everything  cache-first, because Vite filenames are content-hashed and
                   a hit is always correct

   The cache name carries the build hash, so activating a new worker drops
   every previous version in one sweep instead of leaving orphans behind. */

const VERSION = '__BUILD_HASH__';
const CACHE = 'overrun-' + VERSION;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic: one 404 and the whole install fails, which is what we
    // want. A half-cached game is worse than an uncached one.
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('overrun-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // 2.5s is long enough for a slow connection to win and short enough
        // that a dead one does not hold the splash screen hostage.
        const net = await withTimeout(fetch(req), 2500);
        if (net && net.ok) {
          const cache = await caches.open(CACHE);
          cache.put('/index.html', net.clone());
          return net;
        }
      } catch (err) { void err; }
      const cached = await caches.match('/index.html');
      return cached || new Response('Offline', { status: 503 });
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const net = await fetch(req);
      if (net && net.ok && net.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, net.clone());
      }
      return net;
    } catch (err) {
      void err;
      return new Response('', { status: 504 });
    }
  })());
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}
