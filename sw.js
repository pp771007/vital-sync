// 先抓網路、失敗或太慢才用快取：網路正常時永遠拿到剛部署的版本，不必每次改版都記得換快取名稱；
// 快取在離線或網路卡住時派上用場，讓安裝到桌面的 App 還打得開
const CACHE_NAME = 'vital-sync';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Google 登入、試算表 API、字型都是別的網域，交給瀏覽器照常處理，不經過快取
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(request.mode === 'navigate' ? openPage(request) : loadAsset(request));
});

// 有訊號但傳不動時 fetch 不會失敗、會一直等，App 就一直打不開。重新驗證只回沒有內容的 304，
// 正常網路一秒內就回來；等超過這麼久代表網路是瓶頸，先用手機上的那份打開
const NETWORK_TIMEOUT_MS = 3000;
// 這次打開的頁面是不是手機上的那份。是的話它要的 JS、CSS 也用手機上的，新舊版混在一起畫面可能直接壞掉；
// 也因此這時不把網路晚到的新版寫進快取，不然下次打開會拿到一半新一半舊
let servingCached = false;

async function openPage(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (!cached) {
    servingCached = false;
    return networkFirst(request);
  }
  const network = fetch(revalidating(request)).catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  const response = await Promise.race([network, timeout]);
  servingCached = response === null;
  if (servingCached) return cached;
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function loadAsset(request) {
  if (servingCached) {
    const cached = await caches.match(request);
    if (cached) return cached;
  }
  return networkFirst(request);
}

// no-cache：每次都先問伺服器有沒有新版（沒變就只回 304）。GitHub Pages 給的 max-age=600 會讓瀏覽器
// 在部署後十分鐘內直接拿舊檔，畫面上的版本號也跟著停在舊的時間。
// 打開頁面的請求不能拿原本的 request 改設定（瀏覽器會丟錯），所以照網址另建一個；
// redirect 維持 manual，跟瀏覽器自己打開頁面時一樣
function revalidating(request) {
  return request.mode === 'navigate'
    ? new Request(request.url, { cache: 'no-cache', redirect: 'manual' })
    : new Request(request, { cache: 'no-cache' });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(revalidating(request));
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
