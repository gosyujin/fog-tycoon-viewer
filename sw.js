// 端末へのキャッシュ。機内モードや電波が弱いとき (アンテナ1本・SOS のみ) でも、アプリが開いて地図 (霧・軌跡・背景) が出るようにする。
// 機内モードは通信が即失敗するが、電波が弱いと失敗せずに待たされ続ける。そこで「待たない」作りにする: 保存済みのものはすぐ返し、取り直しは裏で、待つときは時間で打ち切る。
// 1. 地図タイル: 見たタイルだけを保存して使い回す (一括取得はしない: OSM のタイル利用ポリシー)。
//    - 保存済みで新しい (FRESH_MS 以内) ならネットワークに行かずそのまま返す → 表示の待ちをなくす
//    - 古いタイルは取り直すが、TILE_WAIT_MS 待っても返らない・失敗したら古いものを返す。失敗した直後の TILE_BAD_MS は、古いタイルは取り直さずすぐ返す
//    - 保存がないタイルは TILE_GIVEUP_MS で諦める (読み込み待ちの接続を溜めない。その下には陸地だけの背景 (base-map.json) が出る)
//    - MAX_TILES を超えたら古い順に捨てる
// 2. アプリ本体 (index.html・app.js・style.css・背景地図 base-map.json) と CDN の Leaflet
//    - CDN と ?v=<sha> 付きの URL は中身が変わらないので、保存済みならそのまま返す
//    - ?v なしの URL (index.html など) は、保存済みならすぐ返して、裏で取り直す (次の起動で新しくなる。最新への切り替えは app.js の更新確認が ?v=<sha> へ移動して行う)
//    - 保存がなければ通信を先に試し、SHELL_WAIT_MS 待っても返らない・失敗したら、?v 違いでも保存したものを返す
// Dropbox への通信 (api / content.dropboxapi.com) と同期先には触らない (app.js の dbx() が時間で打ち切る)。
const CACHE = 'fog-tiles-v1';
const SHELL = 'fog-shell-v1';
const MAX_TILES = 3000;           // 1枚 15〜25KB 程度なので数十MB
const FRESH_MS = 14 * 24 * 3600 * 1000;
const HOST = 'tile.openstreetmap.org';
const TILE_WAIT_MS = 3000, TILE_GIVEUP_MS = 10000, TILE_BAD_MS = 30000;
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

let puts = 0, tileBadUntil = 0;
async function trim(cache) {
  const keys = await cache.keys();   // 挿入順。先頭が古い
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

async function fetchAndStore(req, cache, signal) {
  const res = await fetch(req, { signal });
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
  if (hit && Date.now() < tileBadUntil) return hit;   // 通信が悪い間は、古くてもそのまま返す (待たない)
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), hit ? TILE_WAIT_MS : TILE_GIVEUP_MS);
  try {
    const res = await fetchAndStore(req, cache, ctl.signal);
    tileBadUntil = 0;
    return res;
  } catch (err) {
    tileBadUntil = Date.now() + TILE_BAD_MS;
    if (hit) return hit;   // オフライン・電波が弱い: 古くても返す
    throw err;
  } finally { clearTimeout(timer); }
}

// 取り直して保存する。?v=<sha> 違いの古い版は消して入れ替える (残すと増え続ける)。認可の戻り (?code=) は保存しない
async function store(req, res, cache, dropOthers) {
  if (!res.ok || res.redirected || /[?&](code|error)=/.test(new URL(req.url).search)) return;
  if (dropOthers) await cache.delete(req, { ignoreSearch: true });
  await cache.put(req, res);
}

async function shell(e) {
  const req = e.request, url = new URL(req.url), cache = await caches.open(SHELL);
  const hit = await cache.match(req);   // URL (?v=<sha> つき) が完全に一致するもの
  if (hit) {
    if (!url.searchParams.has('v')) {   // ?v なし (index.html など) は中身が変わるので、返したあと裏で取り直す
      e.waitUntil(fetch(req.url, { cache: 'reload' }).then((res) => store(req, res, cache, false)).catch(() => {}));
    }
    return hit;
  }
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), SHELL_WAIT_MS))]);
    e.waitUntil(store(req, res.clone(), cache, true).catch(() => {}));   // 応答は待たせない
    return res;
  } catch (err) {
    const old = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (old) return old;
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
  else if (url.origin === location.origin && !url.searchParams.has('nc')) e.respondWith(shell(e));   // nc: 更新確認 (build-info.js?nc=…) は毎回新しく取る
});
