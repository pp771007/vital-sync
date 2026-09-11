// 先抓網路、失敗才用快取：有網路時永遠拿到剛部署的版本，不必每次改版都記得換快取名稱；
// 快取只在離線時派上用場，讓安裝到桌面的 App 還打得開
const CACHE_NAME = 'vital-sync';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Google 登入、試算表 API、字型都是別的網域，交給瀏覽器照常處理，不經過快取
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
