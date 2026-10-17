// 端末へのキャッシュ。機内モードなど通信できないときでも、アプリが開いて地図 (霧・軌跡・背景) が出るようにする。
// 1. 地図タイル: 見たタイルだけを保存して使い回す (一括取得はしない: OSM のタイル利用ポリシー)。
//    - 保存済みで新しい (FRESH_MS 以内) ならネットワークに行かずそのまま返す → 表示の待ちをなくす
//    - 古いタイルは取り直し、取れなければ古いものを返す (電波が悪くても地図が出る)
//    - MAX_TILES を超えたら古い順に捨てる
// 2. アプリ本体 (index.html・app.js・style.css・背景地図 base-map.json) と CDN の Leaflet: 通信を先に試し、取れなければ保存したものを返す。
//    通信を先にするのは、デプロイ後の更新 (build-info.js の更新確認) を邪魔しないため。電波が弱くて SHELL_WAIT_MS 待っても返らないときも保存したものを返す。
// Dropbox への通信 (api / content.dropboxapi.com) と同期先には触らない。
const CACHE = 'fog-tiles-v1';
const SHELL = 'fog-shell-v1';
const MAX_TILES = 3000;           // 1枚 15〜25KB 程度なので数十MB
const FRESH_MS = 14 * 24 * 3600 * 1000;
const HOST = 'tile.openstreetmap.org';
const SHELL_WAIT_MS = 4000;
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'build-info.js', 'base-map.json', 'icons/favicon-48.png', 'icons/apple-touch-icon.png'];
const CDN_FILES = [   // バージョン固定なので、保存したものをそのまま使う (index.html の URL と揃える)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js',
];

// 1つ取れなくても (404 や一時的な失敗) 残りは保存する
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all([...SHELL_FILES, ...CDN_FILES].map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => (k.startsWith('fog-tiles-') && k !== CACHE) || (k.startsWith('fog-shell-') && k !== SHELL)).map((k) => caches.delete(k))))
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

async function tile(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit && Date.now() - Number(hit.headers.get('x-cached-at') || 0) < FRESH_MS) return hit;
  try {
    return await fetchAndStore(req, cache);
  } catch (err) {
    if (hit) return hit;   // オフライン: 古くても返す
    throw err;
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL);
  const url = new URL(req.url);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), SHELL_WAIT_MS))]);
    // 認可の戻り (?code=) は保存しない。?v=<sha> 違いの古い版は消して入れ替える (残すと増え続ける)
    if (res.ok && !res.redirected && !/[?&](code|error)=/.test(url.search)) {
      const copy = res.clone();
      cache.delete(req, { ignoreSearch: true }).then(() => cache.put(req, copy)).catch(() => {});   // 応答は待たせない
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function cdn(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req.url, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === HOST) e.respondWith(tile(req));
  else if (CDN_FILES.includes(req.url)) e.respondWith(cdn(req));
  else if (url.origin === location.origin && !url.searchParams.has('nc')) e.respondWith(shell(req));   // nc: 更新確認 (build-info.js?nc=…) は毎回新しく取る
});
