// 地図タイルの端末キャッシュ。見たタイルだけを保存して使い回す (一括取得はしない: OSM のタイル利用ポリシー)。
// - 保存済みで新しい (FRESH_MS 以内) ならネットワークに行かずそのまま返す → 表示の待ちをなくす
// - 古いタイルは取り直し、取れなければ古いものを返す (電波が悪くても地図が出る)
// - MAX_TILES を超えたら古い順に捨てる
// このファイル以外 (アプリ本体・Dropbox への通信) には触らない。更新確認の仕組み (build-info.js) を邪魔しないため。
const CACHE = 'fog-tiles-v1';
const MAX_TILES = 3000;           // 1枚 15〜25KB 程度なので数十MB
const FRESH_MS = 14 * 24 * 3600 * 1000;
const HOST = 'tile.openstreetmap.org';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('fog-tiles-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

let puts = 0;
async function trim(cache) {
  const keys = await cache.keys();   // 挿入順。先頭が古い
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

async function fetchAndStore(req, cache) {
  const res = await fetch(req);
  if (!res.ok) return res;
  // 保存時刻を持たせる (CORS の応答では Date ヘッダが読めないため)
  const headers = new Headers(res.headers);
  headers.set('x-cached-at', String(Date.now()));
  await cache.put(req, new Response(await res.clone().blob(), { status: 200, headers }));
  if (++puts % 100 === 0) trim(cache);
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).hostname !== HOST) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit && Date.now() - Number(hit.headers.get('x-cached-at') || 0) < FRESH_MS) return hit;
    try {
      return await fetchAndStore(req, cache);
    } catch (err) {
      if (hit) return hit;   // オフライン: 古くても返す
      throw err;
    }
  })());
});
