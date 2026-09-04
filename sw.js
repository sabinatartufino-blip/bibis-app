/* ============================================================
   sw.js — service worker for Bibi's App.

   The app shell is cached so the app opens instantly and works with
   no signal. API calls (Open Food Facts, the vision model) are never
   cached: a stale nutrition lookup is worse than no lookup.

   Bump CACHE when you change any shell file, or phones keep the old one.
   ============================================================ */

const CACHE = 'bibis-app-v19';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/nutrients.js',
  'js/swiss.js',
  'data/swiss.json',
  'js/db.js',
  'js/calc.js',
  'js/vision.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/mark-128.png'
];

/* Deliberately NOT skipWaiting here. A new worker that seizes control while
   the old page is still running leaves the app half-updated: new worker,
   old JavaScript, and no sign to the user that anything happened. Instead
   it waits, the page notices and offers a reload, and the update happens
   at a moment the user chose. */
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

/* The page asks for the handover when the user taps Reload. */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let API calls go straight to the network

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        /* Refresh the cached copy in the background so a deploy lands on
           the next launch, without ever making the user wait for it. */
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});
