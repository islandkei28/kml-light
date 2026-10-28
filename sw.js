// オフラインでも開けるようにアプリ本体と見た地図タイルを保存する。
// Android の共有メニューから届いたファイルも受け取る。
const APP = 'app-v2';
const TILES = 'tiles-v1';
const TILE_MAX = 3000;
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/format.js', 'js/convert-worker.js', 'js/kml-parse.js', 'js/simplify.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/maplibre-gl-4.7.1/maplibre-gl-csp.js', 'vendor/maplibre-gl-4.7.1/maplibre-gl-csp-worker.js',
  'vendor/maplibre-gl-4.7.1/maplibre-gl.css',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => ![APP, TILES, 'share'].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    e.respondWith(tile(req));
  } else if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(req));
  }
});

async function receiveShare(req) {
  const form = await req.formData();
  const file = form.get('file');
  if (file && typeof file !== 'string') {
    const cache = await caches.open('share');
    await cache.put('shared-file', new Response(file, { headers: { 'X-Filename': encodeURIComponent(file.name) } }));
  }
  return Response.redirect('./?shared=1', 303);
}

// まずネットから新しいものを取りに行き、取れなければ保存してあるものを返す
async function staleWhileRevalidate(req) {
  const cache = await caches.open(APP);
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()));
  return hit || net;
}

let puts = 0;
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (++puts % 200 === 0) trim(cache);
  }
  return res;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await cache.delete(keys[i]);
}
