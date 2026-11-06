// Service worker: giữ bộ khung app để mở được ngay cả khi mạng chập chờn.
//
// Luôn hỏi mạng trước (app hay đổi, và trạm luôn có bản mới nhất); chỉ khi không với tới
// trạm mới lấy bản đã lưu. Không bao giờ lưu API hay luồng sự kiện: đó là dữ liệu sống.

const CACHE = 'orbit-remote-shell-v34';
const SHELL = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-180.png', '/icons/icon-192.png',
  '/lib/api.js', '/lib/dom.js', '/lib/icons.js', '/lib/md.js', '/lib/store.js', '/lib/custom.js', '/lib/render.js', '/lib/qr.js',
  '/lib/screen-client.js', '/lib/clip-sync.js', '/lib/drag.js', '/lib/models.js', '/lib/mention-core.js',
  '/views/home.js', '/views/session.js', '/views/sheets.js', '/views/settings.js', '/views/channel.js', '/views/machines.js', '/views/pair.js',
  '/views/screen.js', '/views/viewer.js', '/views/group.js', '/views/tree.js', '/views/move.js', '/views/claude-login.js', '/views/mention.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/node/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/'))),
  );
});
