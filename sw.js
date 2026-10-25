// オフラインでも開けるようにするサービスワーカー。
// アプリのファイルは「ネット優先・だめならキャッシュ」なので、更新はすぐ反映される。
const CACHE = 'yozora-v8';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'app.js', 'db.js', 'ai.js', 'voice.js', 'map.js', 'sync.js',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // Worker へのAIリクエスト（POST）は素通し
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // ブラウザのキャッシュ（GitHub Pages は10分）を使わず、毎回サーバーに新しい版があるか確かめる
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }

  // マップ用の d3（CDN）は一度取れたらキャッシュを使う
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
  }
});
