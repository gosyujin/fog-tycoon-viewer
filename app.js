// fog-tycoon の外出先ビューア。コード・鍵・データは含まない。
// Dropbox(App Folder) の /points.json を読み、/checkins.json を読み書きする。端末で認可する (PKCE・files.content.read / write)。
// points.json: { generated, points: [[epochSec, lat, lon], ...] } (時刻昇順)
// recent.json: { generated, since, points } 直近の点だけ (points.json の since 以降をこれで置き換える)。Mac が60秒ごとに書き、表示中は60秒ごとに読む
const SCOPE = 'files.content.read files.content.write';   // write: チェックインを /checkins.json に書く
const DATA_PATH = '/points.json', RECENT_PATH = '/recent.json';
const REDIR = location.origin + location.pathname;
const GAP_SEC = 30 * 60;   // この時間以上空いたら軌跡を分割
const GAP_M = 2000;        // この距離以上飛んだら軌跡を分割

const $ = (id) => document.getElementById(id);
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ---------- Dropbox 認可 (PKCE) ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function startLogin(key) {
  const ver = rand(32), state = rand(16);
  const ch = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ver)));
  LS.set('fog_key', key); LS.set('fog_ver', ver); LS.set('fog_state', state);
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id: key, response_type: 'code', code_challenge: ch, code_challenge_method: 'S256',
    token_access_type: 'offline', scope: SCOPE, redirect_uri: REDIR, state,
  });
}

// Dropbox への通信。電波が弱い (アンテナ1本・SOS のみ) と、機内モードのように即失敗せず、つながらないまま待ち続けることがある。
// 待ち続けると「読み込み中」のまま・同期が詰まる・チェックインが送られない (ciBusy が戻らない) ので、本文を読み終えるまでを時間で打ち切り、
// 通信できないとき (TypeError) と同じ失敗として扱う。呼び出し側は fetch の代わりに使い、Response と同じに読める。
const DBX_MS = { token: 10000, points: 30000, recent: 12000, ci: 15000 };   // points は約1MB
async function dbx(url, opt, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    return new Response(await r.text(), { status: r.status, headers: r.headers });
  } catch (e) {
    throw e.name === 'AbortError' ? new TypeError('通信がタイムアウトしました') : e;
  } finally { clearTimeout(t); }
}

async function tokenReq(params) {
  const r = await dbx('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams(params) }, DBX_MS.token);
  if (!r.ok) throw new Error('token ' + r.status);
  return r.json();
}

let access = null, expires = 0;
async function token() {
  if (access && Date.now() < expires - 60000) return access;
  const j = await tokenReq({ grant_type: 'refresh_token', refresh_token: LS.get('fog_refresh'), client_id: LS.get('fog_key') });
  access = j.access_token; expires = Date.now() + j.expires_in * 1000;
  return access;
}

// 認可から戻ってきたとき (?code= / ?error=) の処理
async function finishLogin() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', REDIR);
  if (q.has('error')) throw new Error('認可エラー: ' + (q.get('error_description') || q.get('error')));
  if (q.get('state') !== LS.get('fog_state')) throw new Error('state が一致しません。もう一度認可してください');
  const j = await tokenReq({
    grant_type: 'authorization_code', code: q.get('code'), code_verifier: LS.get('fog_ver'),
    client_id: LS.get('fog_key'), redirect_uri: REDIR,
  });
  LS.set('fog_refresh', j.refresh_token); LS.set('fog_ver', null); LS.set('fog_state', null);
}

// 通信できないとき (機内モードなど) 用の控え。Cache Storage に置く (localStorage は iOS で約5MB と小さく、点が増えると溢れて控えが黙って消える)。
// Cache Storage が使えないときだけ、従来どおり localStorage に置く (points.json のみ)。
const DATA_CACHE = 'fog-data';
async function saveCopy(name, text) {
  try { await (await caches.open(DATA_CACHE)).put('data/' + name, new Response(text)); if (name === 'points.json') LS.set('fog_cache', null); }   // 入ったら旧い localStorage の控えは消す
  catch { if (name === 'points.json') LS.set('fog_cache', text); }
}
async function loadCopy(name) {
  try { const r = await (await caches.open(DATA_CACHE)).match('data/' + name); if (r) return await r.text(); } catch {}
  return name === 'points.json' ? LS.get('fog_cache') : null;
}

async function fetchPoints() {
  const r = await dbx('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify({ path: DATA_PATH }) },
  }, DBX_MS.points);
  if (!r.ok) throw new Error('download ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const text = await r.text();
  saveCopy('points.json', text);
  return JSON.parse(text);
}

// 直近の点 (recent.json)。まだ書かれていなければ null
async function fetchRecent() {
  const r = await dbx('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify({ path: RECENT_PATH }) },
  }, DBX_MS.recent);
  if (r.status === 409 && (await r.text()).includes('not_found')) return null;
  if (!r.ok) throw new Error('download ' + r.status);
  const text = await r.text();
  saveCopy('recent.json', text);
  return JSON.parse(text);
}

// ---------- 地図 ----------
// rotate: leaflet-rotate。コンパスモード (◎ 長押し) で地図を端末の向きに回すためだけに使う (指での回転・回転コントロールは無効)
const map = L.map('map', { zoomSnap: 0.5, preferCanvas: true, fadeAnimation: false, rotate: true, touchRotate: false, shiftKeyRotate: false, rotateControl: false });   // fadeAnimation: タイルをフェードインさせず、読めた瞬間に出す
// 動かしている間も、表示領域の外側 EDGE_TILES 枚ぶんまで先に読む (Leaflet の既定は、モバイルでは動かし終わってから表示領域だけを読むので、
// 隣の地区に動かすと一度空白になる。保存済み (sw.js) なら、端に入る前にもう描かれている)。
const EDGE_TILES = 1;
const BufferedTileLayer = L.TileLayer.extend({
  _getTiledPixelBounds(center) {
    const b = L.TileLayer.prototype._getTiledPixelBounds.call(this, center), pad = EDGE_TILES * this.getTileSize().x;
    return L.bounds(b.min.subtract([pad, pad]), b.max.add([pad, pad]));
  },
});
// crossOrigin: Service Worker (sw.js) がタイルを CORS の応答として保存するため。keepBuffer: 動かした後に戻っても再読み込みしない。
// updateWhenIdle: false + updateInterval: 動かしている最中も読み込む。updateWhenZooming: ピンチ中は読み込まず、止まってから読む (途中のズームの無駄な読み込みを避ける)
// 地図の種類 (⚙ で選ぶ)。どれも API キー不要 (CARTO は無料でもキーが要るので入れていない)。タイルの保存 (sw.js) は URL ごとなので、別の地図に替えても前の地図の保存分は残る。
// 表示するときは各社のクレジット (attribution) を画面下に出す。
const BASEMAPS = {
  osm: { name: 'OpenStreetMap (標準)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 },
  gsi: { name: '地理院 淡色 (日本のみ)', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>', maxZoom: 18 },
  esri: { name: 'Esri ストリート (カラー)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri', maxZoom: 19 },
  esriGray: { name: 'Esri グレー (淡い)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri', maxNativeZoom: 16, maxZoom: 19 },
};
let baseLayer = null;
function setBasemap(id) {
  const def = BASEMAPS[id] || BASEMAPS.osm;
  if (baseLayer) map.removeLayer(baseLayer);   // 画面下のクレジットも、外した地図のぶんが消えて新しい地図のぶんになる
  const { name, url, ...opts } = def;
  baseLayer = new BufferedTileLayer(url, {
    ...opts, crossOrigin: true, keepBuffer: 4,
    updateWhenIdle: false, updateInterval: 50, updateWhenZooming: false,
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',   // 読めなかったタイルは透明 (壊れた画像のアイコンを出さない)
  }).addTo(map);
  if (map.getZoom() > def.maxZoom) map.setZoom(def.maxZoom);
}
for (const [id, d] of Object.entries(BASEMAPS)) $('basemap').add(new Option(d.name, id));
try { var savedBase = (JSON.parse(LS.get('fog_settings') || '{}') || {}).basemap; } catch {}
setBasemap(savedBase);

// オフラインの背景: 陸地 (海岸線) だけの粗い地図 (base-map.json。tools/build-base-map.mjs で作る)。タイルより下に敷くので、タイルが出ている所では見えず、
// 機内モードなどでタイルが読めない所だけ、陸と海の形が出る (どこまで動かす・ズームしても真っ白にならない)。海の色は #map の背景。
map.createPane('offlineBase', map.getPane('rotatePane')).style.zIndex = 150;   // タイル (200) より下
fetch('base-map.json').then((r) => r.json()).then((g) => {
  L.geoJSON(g, { pane: 'offlineBase', renderer: L.canvas({ pane: 'offlineBase' }), interactive: false, style: { color: '#9aa4ad', weight: 1, fillColor: '#f1efe9', fillOpacity: 1 } }).addTo(map);
}).catch(() => {});   // 無ければ背景なし (従来どおり)

let all = [], points = [];
let baseGenerated = 0, recentGen = 0;   // 読み込んだ points.json の generated (ms) / 取り込んだ recent.json の generated
let cellsStale = false, tracksStale = false;   // 直近の取り込みで作り直しを省いた (ヒートマップ・軌跡に切り替えたときに作り直す)
const live = [];   // リアルタイム追跡で取った点 [epochSec, lat, lon] (メモリのみ。霧・軌跡には即反映)
const tracksLayer = L.layerGroup();   // 軌跡は既定でオフ
const recentLayer = L.layerGroup().addTo(map);   // 最後の全件読み込み以降に Dawarich に届いた点の軌跡 (橙)
let mode = 'fog';   // 'fog' (通った所は全部晴れ) | 'heat' (訪問日数のヒートマップ)
let cells = [];   // 濃淡モード用: [lat, lon, 訪問日数] (CELL_M 四方のセル単位で集計)
const CELL_M = 20;
const INTERP_SEC = 10 * 60, INTERP_M = 120;   // この範囲を超えて離れた点どうしは補間しない (街区を突っ切る直線を作らない。霧で丸が離れて見える間隔と揃える)
const mask = document.createElement('canvas'), mctx = mask.getContext('2d', { willReadFrequently: true });

// ヒートマップの色: 訪問日数ごとの基準色 [この日数以上, 色]。凡例 (#legend) と揃える。間の輝度は色を補間してなめらかにつなぐ
const HEAT_STEPS = [[1, [59, 130, 246]], [2, [34, 197, 94]], [4, [250, 204, 21]], [10, [239, 68, 68]]];
const HEAT_ALPHA = 0.8, HEAT_FEATHER = [0.03, 0.6];   // 色が付く縁は 1日の輝度の 3%→60% で透明→不透明に立ち上げてぼかす
// 各セルの輝度の落ち方 [半径比, 中心比]。ガウス分布のように中心から外へゆるやかに減らす (縁を硬い円にしない)
const HEAT_PROFILE = [[0, 1], [0.15, 0.97], [0.3, 0.85], [0.5, 0.55], [0.7, 0.25], [0.85, 0.08], [1, 0]];
const heatAt = (t) => {   // 山の高さ: 中心からの距離 (半径比 t) → 0..1。HEAT_PROFILE を線形補間
  if (t >= 1) return 0;
  for (let i = 1; i < HEAT_PROFILE.length; i++) {
    const [t1, k1] = HEAT_PROFILE[i], [t0, k0] = HEAT_PROFILE[i - 1];
    if (t <= t1) return k0 + (k1 - k0) * (t - t0) / (t1 - t0);
  }
  return 0;
};
const HEAT_KN = 64, HEAT_KERNEL = new Float32Array(HEAT_KN + 1);   // 距離の2乗 (半径比) で引く表
for (let i = 0; i <= HEAT_KN; i++) HEAT_KERNEL[i] = heatAt(Math.sqrt(i / HEAT_KN));
let heatBuf = new Float32Array(0);
const heatT = (n) => Math.min(1, Math.log(1 + n) / Math.log(1 + HEAT_STEPS[HEAT_STEPS.length - 1][0]));   // 日数 → 0..1
const heatV = (n) => Math.round(255 * heatT(n));
// 輝度 0..255 → RGBA (little-endian の Uint32 に詰めて、ピクセルごとの変換を1回の参照で済ませる)
const HEAT_RGBA = new Uint32Array(256);
for (let v = 0; v < 256; v++) {
  let c = HEAT_STEPS[0][1];
  for (let k = 1; k < HEAT_STEPS.length; k++) {
    const v0 = heatV(HEAT_STEPS[k - 1][0]), v1 = heatV(HEAT_STEPS[k][0]), c0 = HEAT_STEPS[k - 1][1], c1 = HEAT_STEPS[k][1];
    if (v >= v1) { c = c1; continue; }
    if (v > v0) c = c0.map((x, i) => Math.round(x + (c1[i] - x) * (v - v0) / (v1 - v0)));
    break;
  }
  const lo = heatV(1) * HEAT_FEATHER[0], hi = heatV(1) * HEAT_FEATHER[1];
  const a = Math.round(255 * HEAT_ALPHA * Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
  HEAT_RGBA[v] = ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}

// 点を CELL_M のセルに丸め、セルごとに「訪問した日数」を数える (点数は 10m 間引きで移動距離比例になるため回数には使わない)。
// GPS の点は疎なので、近い点どうし (INTERP_SEC / INTERP_M 以内) は間も CELL_M/2 刻みで補間し、通った道を連続させる
function buildCells() {
  if (!points.length) { cells = []; return; }
  let sum = 0;
  for (const p of points) sum += p[1];
  const cosLat = Math.cos((sum / points.length) * Math.PI / 180);
  const dLat = CELL_M / 111000, dLon = dLat / cosLat;
  const tz = new Date().getTimezoneOffset() * 60, byCell = new Map();
  const add = (lat, lon, day) => {
    const key = Math.floor(lat / dLat) + ',' + Math.floor(lon / dLon);
    let c = byCell.get(key);
    if (!c) byCell.set(key, (c = { days: new Set(), la: 0, lo: 0, n: 0 }));
    c.days.add(day); c.la += lat; c.lo += lon; c.n++;   // 位置は格子の中心ではなく実際の点の平均 (斜めの道が階段状にずれない)
  };
  let prev = null;
  for (const p of points) {
    const [ts, lat, lon] = p, day = Math.floor((ts - tz) / 86400);
    if (prev && ts - prev[0] <= INTERP_SEC) {
      const d = Math.hypot((lat - prev[1]) * 111000, (lon - prev[2]) * 111000 * cosLat);
      if (d <= INTERP_M) {
        const n = Math.ceil(d / (CELL_M / 2));
        for (let k = 1; k < n; k++) add(prev[1] + (lat - prev[1]) * k / n, prev[2] + (lon - prev[2]) * k / n, day);
      }
    }
    add(lat, lon, day);
    prev = p;
  }
  cells = [];
  for (const c of byCell.values()) cells.push([c.la / c.n, c.lo / c.n, c.days.size]);
}

// 霧: 画面全体を覆い、各点の周りを destination-out でくり抜く
const Fog = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    this._c = L.DomUtil.create('canvas', 'leaflet-zoom-hide fog-canvas');
    m.getPanes().overlayPane.appendChild(this._c);
    m.on('move zoom resize viewreset rotate', this.redraw, this);
    this.redraw();
  },
  onRemove(m) {
    m.off('move zoom resize viewreset rotate', this.redraw, this);
    this._c.remove();
  },
  redraw() {
    const m = this._map, vs = m.getSize(), dpr = window.devicePixelRatio || 1, c = this._c;
    // 地図が回っているとき (leaflet-rotate) は、画面を覆う正方形を回転と逆向きに回して置く。霧は画面に対して傾かず、四隅も欠けない。
    // o: canvas の左上 (画面座標)。点は画面座標から o を引いて描く
    const bearing = m.getBearing ? m.getBearing() : 0, S = bearing ? Math.ceil(Math.hypot(vs.x, vs.y)) : 0;
    const size = S ? L.point(S, S) : vs, o = S ? L.point((vs.x - S) / 2, (vs.y - S) / 2) : L.point(0, 0);
    if (S) {
      const lc = m.containerPointToLayerPoint(vs.divideBy(2));
      c.style.transform = `translate3d(${lc.x - S / 2}px, ${lc.y - S / 2}px, 0) rotate(${-bearing}deg)`;
    } else L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
    c.width = size.x * dpr; c.height = size.y * dpr;
    c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = `rgba(8, 10, 16, ${+$('density').value / 100})`;
    g.fillRect(0, 0, size.x, size.y);
    g.globalCompositeOperation = 'destination-out';
    const mpp = 40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180) / (256 * 2 ** m.getZoom());
    const r = Math.max(3, +$('radius').value / mpp);
    const b = m.getBounds().pad(r * mpp / 111000 + 0.01);
    const step = Math.max(1, r / 3), seen = new Set();   // 近接点は同じピクセルセルに丸めて描画を減らす
    for (const [, lat, lon] of points.concat(live)) {
      if (!b.contains([lat, lon])) continue;
      const p = m.latLngToContainerPoint([lat, lon]).subtract(o);
      const key = Math.round(p.x / step) + ',' + Math.round(p.y / step);
      if (seen.has(key)) continue;
      seen.add(key);
      const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.6, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
    }
    if (mode === 'heat') this._heat(g, m, size, r, b, o);   // 晴れた所の上に、訪問日数の色を重ねる
  },
  // ヒートマップ: 低解像度の格子に、各セルの訪問日数を重みにした山 (HEAT_PROFILE) を足し合わせて密度を作り、色に変換して重ねる。
  // セルごとの最大値ではなく足し合わせなので、日数の違うセルが隣り合っても色がなめらかにつながる。
  // 1日だけ通った道の中心が「1日」になるよう、道に沿ってセルが並んだときの合計 (HEAT_LINE_SUM) で割る。霧 (晴れた所) の上に重ねるので、霧の濃さ・晴れ半径は霧モードと共通。
  // リアルタイム追跡の点は「今日1日分」として扱う
  _heat(g, m, size, r, b, o) {
    const w = Math.ceil(size.x), h = Math.ceil(size.y);
    if (!w || !h) return;
    const step = Math.max(1, r / 8), rg = r / step;   // 格子の1マス (CSS px)。山の半径は常に約8マス (荒いので拡大時に補間して滑らかにする)
    const gw = Math.ceil(w / step) + 2, gh = Math.ceil(h / step) + 2;
    if (heatBuf.length < gw * gh) heatBuf = new Float32Array(gw * gh);
    const F = heatBuf; F.fill(0, 0, gw * gh);
    const add = (lat, lon, n) => {
      if (!b.contains([lat, lon])) return;
      const p = m.latLngToContainerPoint([lat, lon]).subtract(o), cx = p.x / step, cy = p.y / step;
      const x0 = Math.max(0, Math.ceil(cx - rg)), x1 = Math.min(gw - 1, Math.floor(cx + rg));
      const y0 = Math.max(0, Math.ceil(cy - rg)), y1 = Math.min(gh - 1, Math.floor(cy + rg));
      for (let y = y0; y <= y1; y++) {
        const dy = (y - cy) / rg, row = y * gw;
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / rg, d2 = dx * dx + dy * dy;
          if (d2 < 1) F[row + x] += n * HEAT_KERNEL[(d2 * HEAT_KN) | 0];
        }
      }
    };
    for (const [lat, lon, n] of cells) add(lat, lon, n);
    const served = all.length ? all[all.length - 1][0] : 0;   // Dawarich から届いた最後の点。それ以前の追跡の点は、すでに cells に入っている
    for (const [ts, lat, lon] of live) if (ts > served) add(lat, lon, 1);
    // セルが道に沿って CELL_M おきに並んだときの、中心での合計 (= 1日分の道の中心の値)
    let line = 0;
    for (let k = -50; k <= 50; k++) line += heatAt(Math.abs(k) * CELL_M / +$('radius').value);
    if (mask.width !== gw || mask.height !== gh) { mask.width = gw; mask.height = gh; }
    const img = mctx.createImageData(gw, gh), d32 = new Uint32Array(img.data.buffer);
    for (let i = 0, n = gw * gh; i < n; i++) d32[i] = HEAT_RGBA[Math.round(255 * heatT(F[i] / line))];
    mctx.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(mask, 0, 0, gw * step, gh * step);
  },
});
const fog = new Fog();

// 点列を、時間か距離が空いたところで分けた線分 (緯度経度の配列) のリストにする
function trackSegments(pts) {
  const segs = [];
  let seg = [], prev = null;
  for (const [ts, lat, lon] of pts) {
    if (prev && (ts - prev[0] > GAP_SEC || map.distance([prev[1], prev[2]], [lat, lon]) > GAP_M)) {
      if (seg.length > 1) segs.push(seg);
      seg = [];
    }
    seg.push([lat, lon]); prev = [ts, lat, lon];
  }
  if (seg.length > 1) segs.push(seg);
  return segs;
}

function drawTracks() {
  tracksLayer.clearLayers();
  for (const seg of trackSegments(points)) L.polyline(seg, { color: '#4fc3f7', weight: 2, opacity: 0.7, interactive: false }).addTo(tracksLayer);
}

let note = '', fitted = false;
// light: 直近の取り込みから呼ぶとき。見えていないもの (ヒートマップのセル・軌跡) の作り直しを省く
function applyRange(light) {
  const v = $('range').value;
  const since = v === 'all' ? 0 : Date.now() / 1000 - Number(v) * 86400;
  points = all.filter((p) => p[0] >= since);
  const km = points.reduce((s, p, i) => (i && p[0] - points[i - 1][0] <= GAP_SEC ? s + map.distance([points[i - 1][1], points[i - 1][2]], [p[1], p[2]]) : s), 0) / 1000;
  $('stats').textContent = `${points.length.toLocaleString()} 点 / 約 ${km.toFixed(1)} km${note}`;
  if (light && mode !== 'heat') cellsStale = true; else { buildCells(); cellsStale = false; }
  if (light && !map.hasLayer(tracksLayer)) tracksStale = true; else { drawTracks(); tracksStale = false; }
  if ($('fog').checked && map.hasLayer(fog)) fog.redraw();
}

function showData(d, offline) {
  all = d.points || [];
  baseGenerated = d.generated || 0; recentGen = 0; recentLayer.clearLayers();
  const when = d.generated ? new Date(d.generated).toLocaleString('ja-JP') : '';
  note = (when ? ` · 更新 ${when}` : '') + (offline ? ' · オフライン(控え)' : '');
  if (!all.length) { $('stats').textContent = '点がありません'; return; }
  let s = 90, w = 180, n = -90, e = -180;   // spread だと大量点でスタックが溢れるのでループで求める
  for (const [, lat, lon] of all) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
  if (!fitted) { map.fitBounds([[s, w], [n, e]]); fitted = true; }   // 再読み込みで表示位置を飛ばさない
  if (!map.hasLayer(fog) && $('fog').checked) fog.addTo(map);
  applyRange();
}

// 端末の控えで描く。控えが無い・読めないときは false
async function showCopy() {
  const cached = await loadCopy('points.json');
  if (!cached) return false;
  try {
    showData(JSON.parse(cached), true);
    const rc = await loadCopy('recent.json');   // 最後に読めた直近の点も重ねる (全件との間に隙間があれば使わない)
    if (rc) { const r = JSON.parse(rc); if (Array.isArray(r.points) && r.since * 1000 <= baseGenerated) applyRecent(r, true); }
    return true;
  } catch { return false; }
}

// 最新 (Dropbox) を取りに行く。COPY_FIRST_MS 待っても返らないときは、先に控えで描いて見られるようにする
// (電波が弱いと、失敗せずに待たされる。タイムアウト (DBX_MS.points) までの間、霧が出ないのを避ける)。取れたら最新に置き換える。
const COPY_FIRST_MS = 1200;
async function load() {
  const had = all.length > 0;   // 再読み込み: すでに描いてある (描き直さず、取れたときだけ置き換える)
  if (!had) $('stats').textContent = '読み込み中…';
  let settled = false, copied = had;
  const p = fetchPoints().finally(() => { settled = true; });
  p.catch(() => {});   // 下の await で拾う。先に失敗しても未処理にしない
  if (!copied) {
    await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, COPY_FIRST_MS))]);
    if (!settled) copied = await showCopy();
  }
  try {
    showData(await p, false);
  } catch (err) {
    const authLost = / 40[019]\b/.test(err.message);   // 認可切れ(400/401/409)は控えに逃げない
    if (!copied && !authLost) copied = await showCopy();
    if (copied && !authLost) { if (had) toast('通信できないので、今の表示のままにします', 4000); return; }   // 通信できない: 描いてある控えのまま
    $('stats').textContent = '読み込めません: ' + err.message;
  }
}

// ---------- 直近の点 (recent.json) を60秒ごとに取り込む ----------
// 画面が見えている間だけ読む。points.json の since 以降を recent.json の点で置き換え、霧・統計に反映する (GPS は使わない)。
// 最後の全件読み込み以降の分は、橙の線でも描く。recent.json の since が読み込み済みの points.json より新しいとき (全件が書き直された) は、全件を読み直す。
const RECENT_POLL_MS = 60000;
let recentRun = null, recentTimer = 0;
// 同時に呼ばれたら実行中のものを待つ。取り込んだら true、変化なし・まだ無いなら false。通信の失敗は投げる (定期の取り込みは握りつぶし、同期ボタンは表示する)
const pollRecent = () => recentRun || (recentRun = pollRecentOnce().finally(() => { recentRun = null; }));
async function pollRecentOnce() {
  if (!all.length) return false;   // 全件が読めていないうちは重ねない
  const r = await fetchRecent();
  if (!r || !Array.isArray(r.points) || r.generated === recentGen) return false;
  if (r.since * 1000 > baseGenerated) showData(await fetchPoints(), false);   // 隙間があるので全件を読み直す
  return applyRecent(r, false);
}
// recent.json の点を取り込む (全件より古いときは使わない)。offline: 保存してあった控えを使うとき (表示に出す)
function applyRecent(r, offline) {
  if (r.generated < baseGenerated) return false;   // 全件より古い recent.json は使わない
  recentGen = r.generated;
  all = all.filter((p) => p[0] < r.since).concat(r.points);
  note = ` · 更新 ${new Date(r.generated).toLocaleString('ja-JP')}` + (offline ? ' · オフライン(控え)' : '');
  applyRange(true);
  recentLayer.clearLayers();
  for (const seg of trackSegments(r.points.filter((p) => p[0] * 1000 > baseGenerated))) L.polyline(seg, { color: '#f59e0b', weight: 4, opacity: 0.9, interactive: false }).addTo(recentLayer);
  return true;
}
const pollRecentQuiet = () => pollRecent().catch(() => {});   // 圏外・認可切れ・まだ書かれていないときは、次の回に任せる
function startRecentPoll() {
  clearInterval(recentTimer); recentTimer = 0;
  if (document.visibilityState !== 'visible') return;
  pollRecentQuiet();
  recentTimer = setInterval(pollRecentQuiet, RECENT_POLL_MS);
}
document.addEventListener('visibilitychange', startRecentPoll);   // 裏に回ったら止め、戻ったらすぐ読む

// ---------- 1本指ズーム: ダブルタップの2回目で指を離さず上下にドラッグ (他の地図アプリと同じ操作) ----------
// ONE_FINGER_DIR: 1 = 下にドラッグで拡大 / -1 = 上にドラッグで拡大
const ONE_FINGER_DIR = 1, ONE_FINGER_PX_PER_ZOOM = 90, DOUBLE_TAP_MS = 300, DOUBLE_TAP_PX = 30, DRAG_START_PX = 6;
(() => {
  const el = map.getContainer();
  let last = { t: 0, x: 0, y: 0 }, z = null;
  const opt = { capture: true, passive: false };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { z = null; return; }   // 2本指は Leaflet のピンチに任せる
    const t = e.touches[0], now = Date.now();
    if (now - last.t < DOUBLE_TAP_MS && Math.hypot(t.clientX - last.x, t.clientY - last.y) < DOUBLE_TAP_PX) {
      z = { y: t.clientY, zoom: map.getZoom(), moved: false, at: follow ? map.getSize().divideBy(2) : map.mouseEventToContainerPoint(t), snap: map.options.zoomSnap };
      last.t = 0;
      e.preventDefault(); e.stopPropagation();   // 2回目のタップは Leaflet のドラッグ・クリックに渡さない
    } else {
      last = { t: now, x: t.clientX, y: t.clientY };
    }
  }, opt);
  el.addEventListener('touchmove', (e) => {
    if (!z) return;
    e.preventDefault(); e.stopPropagation();
    const dy = (e.touches[0].clientY - z.y) * ONE_FINGER_DIR;
    if (!z.moved && Math.abs(dy) < DRAG_START_PX) return;
    // 指の下の地点を動かさないため、操作中は zoomSnap を切る
    // (setZoomAround は丸め前のズームで中心を計算するので、0.5 刻みに丸められると指の位置からずれて地図が上下に揺れる)
    if (!z.moved) { z.moved = true; map.options.zoomSnap = 0; }
    map.setZoomAround(z.at, Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z.zoom + dy / ONE_FINGER_PX_PER_ZOOM)), { animate: false });
  }, opt);
  const end = (e) => {
    if (!z) return;
    const s = z; z = null;
    e.preventDefault(); e.stopPropagation();
    if (s.moved) {
      map.options.zoomSnap = s.snap;   // 離したら元の刻みに揃える (揃えた値で中心を計算し直すので位置はずれない)
      const snapped = s.snap ? Math.round(map.getZoom() / s.snap) * s.snap : map.getZoom();
      if (snapped !== map.getZoom()) map.setZoomAround(s.at, snapped);
    } else if (e.type === 'touchend') {
      map.setZoomAround(s.at, Math.min(map.getMaxZoom(), map.getZoom() + 1));   // 動かさなければ通常のダブルタップ拡大
    }
  };
  el.addEventListener('touchend', end, opt);
  el.addEventListener('touchcancel', end, opt);
})();

// ---------- 設定の保存・復元 (この端末の localStorage) ----------
const SETTING_IDS = ['fog', 'tracks', 'radius', 'density', 'range', 'basemap'];
function saveSettings() {
  const v = {};
  for (const id of SETTING_IDS) v[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  LS.set('fog_settings', JSON.stringify(v));
}
function restoreSettings() {
  let v = {};
  try { v = JSON.parse(LS.get('fog_settings') || '{}') || {}; } catch {}
  for (const id of SETTING_IDS) {
    if (!(id in v)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!v[id];
    else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === v[id])) el.value = v[id];
  }
  $('rv').textContent = $('radius').value;
  $('dv').textContent = $('density').value;
}

// ---------- UI ----------
const setPanel = (open) => { $('panel').hidden = !open; $('gear').setAttribute('aria-expanded', open); };
$('gear').onclick = () => setPanel($('panel').hidden);
map.on('click', () => setPanel(false));
$('fog').onchange = (e) => { saveSettings(); e.target.checked ? fog.addTo(map) : map.removeLayer(fog); syncLegend(); };
$('tracks').onchange = (e) => { saveSettings(); if (e.target.checked) { if (tracksStale) { drawTracks(); tracksStale = false; } tracksLayer.addTo(map); } else map.removeLayer(tracksLayer); };
$('radius').oninput = (e) => { $('rv').textContent = e.target.value; saveSettings(); if ($('fog').checked) fog.redraw(); };
$('density').oninput = (e) => { $('dv').textContent = e.target.value; saveSettings(); if ($('fog').checked) fog.redraw(); };
$('range').onchange = () => { saveSettings(); applyRange(); };
$('basemap').onchange = (e) => { saveSettings(); setBasemap(e.target.value); };
const syncLegend = () => { $('legend').hidden = !(mode === 'heat' && $('fog').checked); };
function setMode(m) {
  mode = m;
  const heat = m === 'heat';
  $('mode').textContent = heat ? '🔥' : '🌫';
  $('mode').classList.toggle('on', heat);
  $('mode').setAttribute('aria-pressed', heat);
  $('mode').setAttribute('aria-label', heat ? 'ヒートマップ (押すと霧)' : '霧 (押すとヒートマップ)');
  syncLegend();
  if (heat && cellsStale) { buildCells(); cellsStale = false; }
  if (map.hasLayer(fog)) fog.redraw();   // 起動時はまだ地図に載っていない
}
$('mode').onclick = () => { setMode(mode === 'heat' ? 'fog' : 'heat'); LS.set('fog_mode', mode); };

const recallSource = () => all.concat(live);   // 履歴の元になる点

// ---- この辺りの履歴: 🕘 を押してから地図をタップすると、その周り (半径 recallR) に来た日を新しい順に出す ----
// 半径内の点の連なりを1回の「訪問」とし、日ごとにまとめる (日をまたぐ連なりは日で分ける)。
// 点は 10m 未満の移動を間引いてあるので、滞在中は点が少ない。時刻は「最初の点〜最後の点」の目安
const RECALL_MAX_DAYS = 60;   // 一覧に出す日数の上限 (新しい順)
const RECALL_MERGE_SEC = 15 * 60;   // 半径の外に出て、この時間以内に戻った分は同じ訪問にまとめる
let recallOn = false, recallR = 100, recallAt = null, recallDay = null;
// 回転する層 (leaflet-rotate の rotatePane。本体はプラグインが無く mapPane) の中に置く。mapPane の直下だと、回らない層 (ポップアップ・ラベル) の上に重なってしまう
map.createPane('recall', map.getPane('rotatePane')).style.zIndex = 450;   // 霧 (overlayPane=400) より上
const recallRenderer = L.canvas({ pane: 'recall' });
const recallLayer = L.layerGroup().addTo(map), dayLayer = L.layerGroup().addTo(map);
const tzSec = () => new Date().getTimezoneOffset() * 60;
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const mins = (s) => { const m = Math.floor(s / 60); return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`; };

function recallVisits(c, r) {
  const tz = tzSec(), cosLat = Math.cos(c.lat * Math.PI / 180), r2 = r * r, days = new Map();
  let outside = false;   // 直前の半径内の点から、半径の外の点を挟んだか
  for (const [ts, lat, lon] of recallSource()) {
    const dy = (lat - c.lat) * 111000, dx = (lon - c.lng) * 111000 * cosLat;
    if (dx * dx + dy * dy > r2) { outside = true; continue; }
    const day = Math.floor((ts - tz) / 86400);
    if (!days.has(day)) days.set(day, []);
    const v = days.get(day), last = v[v.length - 1];
    // 外を挟まない連なりは、間が空いていても同じ訪問 (滞在中は点が間引かれる)。外を挟んでも RECALL_MERGE_SEC 以内なら同じ訪問 (半径の縁での GPS のゆらぎ)
    if (last && (!outside || ts - last.end <= RECALL_MERGE_SEC)) last.end = ts;
    else v.push({ start: ts, end: ts });
    outside = false;
  }
  return [...days.entries()].sort((a, b) => b[0] - a[0]);   // [[日番号, [訪問…]], …] 新しい日が先
}

function clearDay() { recallDay = null; dayLayer.clearLayers(); for (const b of document.querySelectorAll('#rcList .sel')) b.classList.remove('sel'); }

// その日の軌跡を橙で重ねて、全体が見えるように寄せる。同じ行をもう一度押すと消える
function showDay(day, btn) {
  const wasSel = recallDay === day;
  clearDay();
  if (wasSel) return;
  recallDay = day; btn.classList.add('sel');
  const tz = tzSec(), pts = recallSource().filter((p) => Math.floor((p[0] - tz) / 86400) === day);
  if (!pts.length) return;
  const o = { pane: 'recall', renderer: recallRenderer, interactive: false };
  for (const s of trackSegments(pts)) L.polyline(s, { ...o, color: '#f97316', weight: 4, opacity: 0.9 }).addTo(dayLayer);
  const dot = (p, color) => L.circleMarker([p[1], p[2]], { ...o, radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(dayLayer);
  dot(pts[0], '#16a34a'); dot(pts[pts.length - 1], '#dc2626');   // 緑=その日の最初の点 / 赤=最後の点
  map.fitBounds(L.latLngBounds(pts.map((p) => [p[1], p[2]])), { maxZoom: 17, paddingTopLeft: [24, 60], paddingBottomRight: [24, $('recall').offsetHeight + 154] });
}

function recallShow(latlng) {
  recallAt = latlng; clearDay(); recallLayer.clearLayers();
  L.circle(latlng, { radius: recallR, color: '#f97316', weight: 2, fillOpacity: 0.08, interactive: false, pane: 'recall', renderer: recallRenderer }).addTo(recallLayer);
  // 点の訪問がある日に、半径内のチェックインがある日 (点が無い日も) を加える
  const days = new Map(recallVisits(latlng, recallR)), cis = recallCheckins(latlng, recallR), list = $('rcList');
  for (const day of cis.keys()) if (!days.has(day)) days.set(day, []);
  const rows = [...days.entries()].sort((a, b) => b[0] - a[0]);
  const n = rows.reduce((s, [, v]) => s + v.length, 0), nc = [...cis.values()].reduce((s, v) => s + v.length, 0);
  $('rcTitle').textContent = rows.length ? `半径${recallR}m 以内: ${rows.length}日 / ${n}回${nc ? ` / 📍${nc}件` : ''}` : `半径${recallR}m 以内に来た記録はありません`;
  list.replaceChildren();
  for (const [day, visits] of rows.slice(0, RECALL_MAX_DAYS)) {
    const li = document.createElement('li'), btn = document.createElement('button'), d = document.createElement('b'), names = cis.get(day) || [];
    btn.type = 'button';
    d.textContent = dayText(visits.length ? visits[0].start : names[0].t);
    btn.append(d);
    if (visits.length) {
      const t = document.createElement('span');
      t.textContent = visits.map((v) => (v.end - v.start < 60 ? hm(v.start) : `${hm(v.start)}〜${hm(v.end)}${v.end - v.start >= 300 ? ` (${mins(v.end - v.start)})` : ''}`)).join('、');
      btn.append(t);
    }
    if (names.length) {
      const c = document.createElement('span');
      c.className = 'rc-ci';
      c.textContent = names.map((k) => `📍${placeOf(k.place)?.name ?? ''}${k.note ? `「${k.note}」` : ''}`).join(' ');
      btn.append(c);
    }
    btn.onclick = () => showDay(day, btn);
    li.append(btn); list.append(li);
  }
  map.panInside(latlng, { paddingTopLeft: [24, 60], paddingBottomRight: [24, $('recall').offsetHeight + 154] });   // タップした所が一覧に隠れないように寄せる
  if (rows.length > RECALL_MAX_DAYS) { const li = document.createElement('li'); li.className = 'more'; li.textContent = `ほか ${rows.length - RECALL_MAX_DAYS} 日 (古い順)`; list.append(li); }
}

function setRecall(on) {
  recallOn = on;
  $('recallBtn').classList.toggle('on', on);
  $('recallBtn').setAttribute('aria-pressed', on);
  $('recall').hidden = !on;
  recallLayer.clearLayers(); clearDay(); recallAt = null;
  $('rcList').replaceChildren();
  $('rcTitle').textContent = '地図をタップすると、その周りに来た日を出します';
}
$('recallBtn').onclick = () => setRecall(!recallOn);
$('rcClose').onclick = () => setRecall(false);
for (const b of $('rcRadii').children) {
  b.setAttribute('aria-pressed', +b.dataset.r === recallR);
  b.onclick = () => {
    recallR = +b.dataset.r;
    for (const x of $('rcRadii').children) x.setAttribute('aria-pressed', x === b);
    if (recallAt) recallShow(recallAt);
  };
}
map.on('click', (e) => { if (recallOn) recallShow(e.latlng); });

// ---- チェックイン (表示): { places: [{id, name, lat, lon}], checkins: [{id, t, place, lat, lon, note}] } ----
// 場所 (places) は名前と代表座標。チェックインは「いつ、どの場所に」。viewer が Dropbox の /checkins.json に書き、本体は data/checkins.json を読むだけ。
let ci = { places: [], checkins: [] }, ciRemove = null, ciEdit = null;   // ciRemove・ciEdit: 削除・編集できる viewer だけが関数を入れる
const placeOf = (id) => ci.places.find((p) => p.id === id);
const pinPref = {
  get() { try { return localStorage.getItem('fog_pins'); } catch { return null; } },
  set(v) { try { localStorage.setItem('fog_pins', v); } catch {} },
};
map.createPane('pins', map.getPane('rotatePane')).style.zIndex = 460;   // 履歴の円・軌跡 (450) より上
const pinRenderer = L.canvas({ pane: 'pins', tolerance: 10 });   // 指で押しやすいよう当たりを広げる
const pinLayer = L.layerGroup();
const dayText = (ts) => new Date(ts * 1000).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });

const ICONS = {
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
};
// ボタンの click は地図まで伝えない: 押した拍子にポップアップの中身を差し替えるので、ボタンが外れたあとの click を Leaflet が「地図のクリック」と見て、ポップアップを閉じてしまう
function iconBtn(kind, label, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'ic ' + kind; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = ICONS[kind]; b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}
function textBtn(label, cls, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}
// 編集欄 (場所名 / 1件の日時とメモ) の共通部分: 入力欄と「保存」「取消」を並べる
function editForm(cls, inputs, onSave, onCancel) {
  const f = document.createElement('div'), row = document.createElement('div');
  f.className = cls; row.className = 'btns';
  row.append(textBtn('保存', 'save', onSave), textBtn('取消', 'cancel', onCancel));
  f.append(...inputs, row);
  return f;
}

// ポップアップ。通常は「日付 メモ」、「編集」を押すと各行に鉛筆 (日時・メモを直す) とゴミ箱が出て、見出しの鉛筆で場所名を直せる。
// 日付の列とメモの列を分けるので、メモが長いときは日付の下にもぐらず、メモの列の中で折り返す
function pinPopup(p, list, editing) {
  const box = document.createElement('div'), head = document.createElement('div'), title = document.createElement('strong'), ul = document.createElement('ul');
  box.className = 'pin-pop'; head.className = 'pin-head'; ul.className = editing ? 'editing' : '';
  const again = () => openPin(p.id, editing);
  title.textContent = editing ? p.name : `${p.name} (${list.length}回)`;   // 編集中は削除で回数が変わるので出さない
  head.append(title);
  if (editing) {
    head.append(iconBtn('pen', '場所名を編集', () => {
      const inp = document.createElement('input');
      inp.value = p.name; inp.setAttribute('aria-label', '場所名'); inp.enterKeyHint = 'done';
      const save = () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        if (name !== p.name) ciEdit({ op: 'rename', id: p.id, name });
        openPin(p.id, true);
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') save(); };
      head.replaceChildren(editForm('pin-form name', [inp], save, again));
      inp.focus();
    }));
  }
  for (const k of list.slice(0, 12)) {
    const li = document.createElement('li'), when = document.createElement('span'), memo = document.createElement('span');
    when.className = 'when'; when.textContent = `${dayText(k.t)} ${hm(k.t)}`;
    memo.className = 'memo'; memo.textContent = k.note || '';
    li.append(when, memo);
    if (editing) {
      const acts = document.createElement('span');
      acts.className = 'acts';
      acts.append(
        iconBtn('pen', '日時・メモを編集', () => {
          const t = document.createElement('input'), n = document.createElement('input');
          t.type = 'datetime-local'; t.value = localInput(k.t); t.setAttribute('aria-label', 'チェックイン日時');
          n.value = k.note || ''; n.placeholder = 'メモ (任意)'; n.setAttribute('aria-label', 'メモ'); n.enterKeyHint = 'done';
          const save = () => {
            const nt = t.value && t.value !== localInput(k.t) ? Math.floor(new Date(t.value).getTime() / 1000) : k.t;   // 日時欄を触っていなければ元の秒を残す
            if (!isFinite(nt)) { toast('日時を確認してください'); return; }
            const note = n.value.trim();
            if (nt !== k.t || note !== (k.note || '')) ciEdit({ op: 'edit', id: k.id, t: nt, note });
            openPin(p.id, true);
          };
          n.onkeydown = (e) => { if (e.key === 'Enter') save(); };
          li.className = 'ed';
          li.replaceChildren(editForm('pin-form', [t, n], save, again));
        }),
        iconBtn('del', '削除', () => { if (ciRemove(k.id)) openPin(p.id, true); }),
      );
      li.append(acts);
    }
    ul.append(li);
  }
  if (list.length > 12) { const li = document.createElement('li'); li.className = 'more'; li.textContent = `ほか ${list.length - 12} 回`; ul.append(li); }
  box.append(head, ul);
  if (ciRemove) box.append(textBtn(editing ? '完了' : '編集', 'edit', () => openPin(p.id, !editing)));   // 編集・削除できる viewer だけ。うっかり押さないよう、既定では鉛筆もゴミ箱も出さない
  return box;
}

// 場所 pid のポップアップを開く (開いていれば中身だけ差し替える)。チェックインが無くなっていたら閉じる
let pinPop = null;
function openPin(pid, editing) {
  const p = placeOf(pid), list = ci.checkins.filter((k) => k.place === pid).sort((a, b) => b.t - a.t);
  if (!p || !list.length) { map.closePopup(); return; }
  const box = pinPopup(p, list, editing);
  if (pinPop && pinPop.isOpen() && pinPop._pid === pid) pinPop.setContent(box);
  else { pinPop = L.popup({ maxWidth: 320 }).setLatLng([p.lat, p.lon]).setContent(box).openOn(map); pinPop._pid = pid; }
}

function drawPins() {
  pinLayer.clearLayers();
  const byPlace = new Map();
  for (const k of ci.checkins) { if (!byPlace.has(k.place)) byPlace.set(k.place, []); byPlace.get(k.place).push(k); }
  for (const p of ci.places) {
    const list = byPlace.get(p.id);
    if (!list) continue;   // チェックインが全部消えた場所は出さない
    list.sort((a, b) => b.t - a.t);
    const m = L.circleMarker([p.lat, p.lon], { pane: 'pins', renderer: pinRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#7c3aed', fillOpacity: 1, bubblingMouseEvents: false });
    m.bindTooltip(p.name, { permanent: true, direction: 'right', offset: [8, 0], className: 'pin-label' });
    m.on('click', () => openPin(p.id, false));
    m.addTo(pinLayer);
  }
}
function setCheckins(d) { ci = { places: d.places || [], checkins: d.checkins || [] }; drawPins(); }

function setPins(on) {
  on ? pinLayer.addTo(map) : map.removeLayer(pinLayer);
  $('pinBtn').classList.toggle('on', on);
  $('pinBtn').setAttribute('aria-pressed', on);
  pinPref.set(on ? '1' : '0');
}
$('pinBtn').onclick = () => setPins(!map.hasLayer(pinLayer));
setPins(pinPref.get() !== '0');
const syncPinLabels = () => map.getContainer().classList.toggle('pin-labels', map.getZoom() >= 15);   // 名前は寄ったときだけ (引きだと重なる)
map.on('zoomend', syncPinLabels); syncPinLabels();

// 半径内のチェックイン: 日番号 → [チェックイン]
function recallCheckins(c, r) {
  const tz = tzSec(), m = new Map();
  for (const k of ci.checkins) {
    const p = placeOf(k.place);
    if (map.distance(p ? [p.lat, p.lon] : [k.lat, k.lon], c) > r) continue;
    const day = Math.floor((k.t - tz) / 86400);
    if (!m.has(day)) m.set(day, []);
    m.get(day).push(k);
  }
  return m;
}

// ---- チェックイン (記録): Dropbox の /checkins.json に書く (viewer だけ) ----
// 操作 (ops) をいったん端末のキューに積み、通信できるとき Dropbox の最新を読み直して適用し、rev つきで書き戻す。
// 圏外でも押せる。他の端末が先に書いていたら (競合) 読み直してやり直す。ops: { op: 'add', checkin, place|null } / { op: 'del', id } / { op: 'edit', id, t, note } / { op: 'rename', id, name }
const CI_PATH = '/checkins.json', CI_QUEUE = 'fog_ci_queue', CI_CACHE = 'fog_ci_cache', CI_NEAR_M = 100, CI_SAME_M = 300;
let ciBase = { places: [], checkins: [] }, ciQueue = [], ciBusy = false;   // ciBase: Dropbox にある最後に読めた内容
try { ciQueue = JSON.parse(LS.get(CI_QUEUE) || '[]') || []; } catch {}
const ciSaveQueue = () => LS.set(CI_QUEUE, ciQueue.length ? JSON.stringify(ciQueue) : null);

function ciApply(d, ops) {
  const places = d.places.slice(), checkins = d.checkins.slice();
  for (const o of ops) {
    if (o.op === 'add') {
      if (o.place && !places.some((p) => p.id === o.place.id)) places.push(o.place);
      if (!checkins.some((c) => c.id === o.checkin.id)) checkins.push(o.checkin);
    } else if (o.op === 'del') {
      const i = checkins.findIndex((c) => c.id === o.id);
      if (i >= 0) checkins.splice(i, 1);
    } else if (o.op === 'edit') {
      const i = checkins.findIndex((c) => c.id === o.id);
      if (i >= 0) { const c = { ...checkins[i], t: o.t }; if (o.note) c.note = o.note; else delete c.note; checkins[i] = c; }   // 読み込んだ配列の中身は書き換えず、差し替える
    } else if (o.op === 'rename') {
      const i = places.findIndex((p) => p.id === o.id);
      if (i >= 0) places[i] = { ...places[i], name: o.name };
    }
  }
  return { places, checkins };
}
const ciRefresh = () => setCheckins(ciApply(ciBase, ciQueue));

async function ciFetch() {
  const r = await dbx('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify({ path: CI_PATH }) },
  }, DBX_MS.ci);
  if (r.status === 409) {
    const t = await r.text();
    if (t.includes('not_found')) return { data: { places: [], checkins: [] }, rev: null, exists: false };
    throw new Error('download 409 ' + t.slice(0, 120));
  }
  if (!r.ok) throw new Error('download ' + r.status + ' ' + (await r.text()).slice(0, 120));
  let rev = null;
  try { rev = JSON.parse(r.headers.get('dropbox-api-result')).rev; } catch {}
  const d = JSON.parse(await r.text());
  return { data: { places: d.places || [], checkins: d.checkins || [] }, rev, exists: true };
}

async function ciUpload(data, { rev, exists }) {
  const mode = !exists ? { '.tag': 'add' } : rev ? { '.tag': 'update', update: rev } : { '.tag': 'overwrite' };   // rev を読めなかったときだけ上書き
  // 途中で打ち切っても、サーバ側では書けていることがある。次の回は最新を読み直し、チェックインは id で重複を除くので、二重にはならない
  const r = await dbx('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: CI_PATH, mode, autorename: false, mute: true }) },
    body: JSON.stringify({ updated: Date.now(), ...data }),
  }, DBX_MS.ci);
  if (r.ok) return;
  const t = await r.text(), e = new Error('upload ' + r.status + ' ' + t.slice(0, 120));
  e.conflict = /path\/conflict|"conflict"/.test(t);
  e.scope = t.includes('missing_scope');
  throw e;
}

async function ciReload() {
  try {
    const { data } = await ciFetch();
    ciBase = data; LS.set(CI_CACHE, JSON.stringify(data)); ciRefresh();
  } catch {}   // 圏外など。端末の控えを出したまま
}

async function ciFlush(loud) {
  if (ciBusy || !ciQueue.length) return;
  ciBusy = true;
  try {
    for (let i = 0; i < 4; i++) {
      const sent = ciQueue.length, cur = await ciFetch(), merged = ciApply(cur.data, ciQueue.slice(0, sent));
      try { await ciUpload(merged, cur); } catch (e) { if (e.conflict) continue; throw e; }
      ciBase = merged; ciQueue = ciQueue.slice(sent); ciSaveQueue(); LS.set(CI_CACHE, JSON.stringify(ciBase)); ciRefresh();
      if (loud) toast('チェックインを Dropbox に保存しました');
      if (ciQueue.length) { ciBusy = false; return await ciFlush(loud); }   // 送っている間に積まれた分 (続けて直したとき)
      return;
    }
    throw new Error('他の端末の書き込みと競合が続きました');
  } catch (e) {
    if (/missing_scope/.test(e.message) || e.scope) toast('チェックインの保存には書き込み権限が要ります。⚙ の「Dropbox の認可を解除」から、認可し直してください (保存済みの分は端末に残ります)', 9000);
    else if (loud) toast(e instanceof TypeError ? 'チェックインを端末に保存しました。通信できたときに送ります' : 'チェックインを端末に保存しました。送信に失敗: ' + e.message.slice(0, 80), 6000);
  } finally { ciBusy = false; }
}
const ciSync = (loud) => (ciQueue.length ? ciFlush(loud) : ciReload());

function ciStart() {
  try { const c = JSON.parse(LS.get(CI_CACHE) || 'null'); if (c) ciBase = { places: c.places || [], checkins: c.checkins || [] }; } catch {}
  ciRefresh();
  ciSync(false);
}
addEventListener('online', () => ciSync(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ciSync(false); });

ciRemove = (id) => {   // 削除したら true (ポップアップを描き直す目印)
  if (!confirm('このチェックインを削除しますか?')) return false;
  ciQueue.push({ op: 'del', id }); ciSaveQueue(); ciRefresh(); ciFlush(true);
  return true;
};
ciEdit = (op) => { ciQueue.push(op); ciSaveQueue(); ciRefresh(); ciFlush(true); };

// ---- チェックインのシート: 位置 (現在地 / 地図をタップ) と名前・時刻・メモ ----
let ciPos = null, ciPicking = false;
const ciMark = L.layerGroup().addTo(map);
const localInput = (ts) => new Date(ts * 1000 - tzSec() * 1000).toISOString().slice(0, 16);   // <input type=datetime-local> 用 (端末のローカル時刻)
const placesAt = (lat, lon) => ci.places.map((p) => ({ p, d: map.distance([p.lat, p.lon], [lat, lon]) })).filter((x) => x.d <= CI_NEAR_M).sort((a, b) => a.d - b.d);   // 近い順 (CI_NEAR_M 以内)
const placesNear = () => ci.places.map((p) => ({ p, d: map.distance([p.lat, p.lon], ciPos) })).sort((a, b) => a.d - b.d);

// シートは画面の下端に置く。ソフトキーボードが出たら、見えている範囲 (visualViewport) の下端へ上げる。
// iOS はキーボードでレイアウトの高さが変わらず visualViewport だけ縮むので、その差を --kb (キーボードの高さ)、見える高さを --vvh に入れる
const vv = window.visualViewport;
function syncKeyboard() {
  if (!vv) return;
  const root = document.documentElement.style;
  root.setProperty('--kb', Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px');
  root.setProperty('--vvh', vv.height + 'px');
  ciReveal(true);
}
// 選んだ位置を、シートより上の「見えている範囲」の真ん中に置く。見えている範囲の上端は、iOS がキーボードでページをスクロールした分 (vv.offsetTop) も含める。
// force=false のときは、すでにその範囲に見えていれば動かさない (地図をタップして選んだ位置を勝手に動かさない)。キーボードの出入りなど画面が変わるときは force=true で、毎回真ん中へ置く (ふちに張り付かせない)
function ciReveal(force) {
  if (!ciPos || $('ciSheet').hidden) return;
  const top = (vv ? vv.offsetTop : 0) + 70, bottom = $('ciSheet').getBoundingClientRect().top - 20, size = map.getSize(), p = map.latLngToContainerPoint(ciPos);
  if (!force && p.y >= top && p.y <= bottom && p.x >= 24 && p.x <= size.x - 24) return;
  map.panBy(p.subtract([size.x / 2, (top + Math.max(top, bottom)) / 2]), { animate: false });
}
if (vv) { vv.addEventListener('resize', syncKeyboard); vv.addEventListener('scroll', syncKeyboard); syncKeyboard(); }
// キーボードで表示領域が縮むと、Leaflet が地図の中心を保ったまま大きさを取り直し (invalidateSize)、上に置いた位置が表示領域の外へずれる。取り直したあとにも置き直す
map.on('resize', () => ciReveal(true));
// 入力中 (キーボードが出ている間) は、時刻・滞在候補・位置のボタンを隠してシートを小さくする。
// キーボードで見える高さが 400px 台まで縮むので、フルのシートだと地図が見える余地が無くなる (位置が隠れる)
const isText = (el) => el === $('ciWhere') || el === $('ciNote');
$('ciSheet').addEventListener('focusin', (e) => {
  if (isText(e.target)) $('ciSheet').classList.add('typing');
  for (const ms of [0, 300, 700]) setTimeout(() => ciReveal(true), ms);
});
$('ciSheet').addEventListener('focusout', (e) => {
  if (isText(e.relatedTarget)) return;
  $('ciSheet').classList.remove('typing');
  setTimeout(() => ciReveal(true), 300);
});

function ciSetPos(lat, lon, label) {
  ciPos = L.latLng(lat, lon); ciPicking = false;
  $('ciPick').classList.remove('on');
  $('ciPos').textContent = `📍 ${label}`;
  ciMark.clearLayers();
  L.circleMarker(ciPos, { pane: 'recall', renderer: recallRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(ciMark);
  const near = placesNear(), chips = $('ciNear');
  chips.replaceChildren(); $('ciPlaces').replaceChildren();
  for (const { p, d } of near.filter((x) => x.d <= CI_NEAR_M).slice(0, 5)) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `${p.name} (${Math.round(d)}m)`; b.onclick = () => { $('ciWhere').value = p.name; };
    chips.append(b);
  }
  ciReveal();
}
// 名前の候補 (datalist): 欄に文字を打ち始めたときに、近い順に作る
function ciFillNames() {
  const names = $('ciPlaces');
  if (names.children.length) return;
  const list = ciPos ? placesNear().map((x) => x.p) : ci.places;
  for (const n of new Set(list.map((p) => p.name))) { const o = document.createElement('option'); o.value = n; names.append(o); }
}
$('ciWhere').addEventListener('input', ciFillNames);

function ciLocate() {
  $('ciPos').textContent = '現在地を取得中…';
  if (!navigator.geolocation) { $('ciPos').textContent = 'この端末では現在地が使えません。「地図で指定」を使ってください'; return; }
  navigator.geolocation.getCurrentPosition(
    (p) => ciSetPos(p.coords.latitude, p.coords.longitude, `現在地 (精度 ±${Math.round(p.coords.accuracy)}m)`),
    () => { $('ciPos').textContent = '現在地を取得できません。「地図で指定」を使ってください'; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 20000 },
  );
}

// ---- 滞在候補: 日を選ぶと、その日に「同じ所に STAY_MIN_SEC 以上いた」場所を点から探して並べる。入れ忘れの思い出し用 ----
// 点は 10m 未満の移動を間引いてあるので、滞在中は点が少ない。最初の点から半径 STAY_R 内に続く点を1つの連なりとし、
// 近くで STAY_MERGE_SEC 以内に戻った連なり (屋内の GPS のゆらぎ) はつなぐ。候補は保存せず、タップで位置・時刻を入れるだけ
const STAY_R = 60, STAY_MIN_SEC = 10 * 60, STAY_MERGE_SEC = 15 * 60, STAY_DONE_M = 150, STAY_PAD_SEC = 15 * 60, STAY_SNAP_M = 100;
const stayLayer = L.layerGroup().addTo(map);
const dayStart = () => { const d = $('ciTime').value ? new Date($('ciTime').value.slice(0, 10) + 'T00:00') : new Date(); if (!$('ciTime').value) d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };   // 時刻欄の日の0時 (端末の時刻)
const dayPoints = (t0) => recallSource().filter((p) => p[0] >= t0 && p[0] < t0 + 86400);

function stayCandidates(t0) {
  const pts = dayPoints(t0);
  if (!pts.length) return [];
  const cosLat = Math.cos(pts[0][1] * Math.PI / 180), m = (lat1, lon1, lat2, lon2) => Math.hypot((lat1 - lat2) * 111000, (lon1 - lon2) * 111000 * cosLat);
  const runs = [];
  for (let i = 0; i < pts.length;) {
    let j = i, sa = 0, so = 0;
    while (j < pts.length && m(pts[j][1], pts[j][2], pts[i][1], pts[i][2]) <= STAY_R) { sa += pts[j][1]; so += pts[j][2]; j++; }
    runs.push({ start: pts[i][0], end: pts[j - 1][0], lat: sa / (j - i), lon: so / (j - i) });
    i = j;
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= STAY_MERGE_SEC && m(r.lat, r.lon, last.lat, last.lon) <= STAY_R) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((s) => s.end - s.start >= STAY_MIN_SEC);
}

// 候補の前後 STAY_PAD_SEC 以内・STAY_DONE_M 以内にチェックインがあれば、その候補は済み
const stayDone = (s) => ci.checkins.find((k) => {
  const p = placeOf(k.place);
  return k.t >= s.start - STAY_PAD_SEC && k.t <= s.end + STAY_PAD_SEC && map.distance(p ? [p.lat, p.lon] : [k.lat, k.lon], [s.lat, s.lon]) <= STAY_DONE_M;
});

function ciStays() {
  const box = $('ciStayList');
  box.replaceChildren(); stayLayer.clearLayers();
  const cands = stayCandidates(dayStart());
  let open = 0;
  for (const s of cands) {
    const done = stayDone(s), near = placesAt(s.lat, s.lon)[0];
    const b = document.createElement('button'), a = document.createElement('b'), c = document.createElement('span');
    b.type = 'button';
    a.textContent = `${hm(s.start)}〜${hm(s.end)} (${mins(s.end - s.start)})`;
    c.textContent = done ? `✓ ${placeOf(done.place)?.name ?? 'チェックイン済み'}` : near ? `「${near.p.name}」?` : '';
    b.append(a); if (c.textContent) b.append(c);
    if (done) b.disabled = true; else open++;
    L.circleMarker([s.lat, s.lon], { pane: 'recall', renderer: recallRenderer, radius: 6, color: '#fff', weight: 2, fillColor: done ? '#94a3b8' : '#38bdf8', fillOpacity: 1, interactive: false }).addTo(stayLayer);
    b.onclick = () => {
      for (const x of box.children) x.classList.remove('sel');
      b.classList.add('sel');
      ciSetPos(s.lat, s.lon, `滞在候補 ${hm(s.start)}〜${hm(s.end)}`);
      $('ciTime').value = localInput(s.start);
      if (near) $('ciWhere').value = near.p.name;
      $('ciStays').open = false;
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 17), { animate: false });   // アニメーション中は位置の計算が古い座標のままになり、寄せがずれる
      ciReveal(true);
      $(near ? 'ciSave' : 'ciWhere').focus({ preventScroll: true });
      for (const ms of [150, 400, 800]) setTimeout(() => ciReveal(true), ms);   // キーボードが出きって、シートの位置が落ち着いたあとにも確かめる
    };
    box.append(b);
  }
  $('ciStaySum').textContent = `この日の滞在から選ぶ (${cands.length ? `${open}件` : 'なし'})`;
}
$('ciTime').addEventListener('change', ciStays);

// 地図で指定したとき、その日の点が近く (STAY_SNAP_M 以内) にあれば、いちばん近い点の時刻を入れる (時刻を打たなくてよい)
function ciSnapTime(ll) {
  let best = null, bd = STAY_SNAP_M;
  for (const p of dayPoints(dayStart())) { const d = map.distance([p[1], p[2]], ll); if (d <= bd) { bd = d; best = p; } }
  if (!best) return;
  $('ciTime').value = localInput(best[0]);
  $('ciPos').textContent += ` — この日 ${hm(best[0])} 頃にいました (時刻を合わせました)`;
}

function ciOpen() {
  setRecall(false);
  $('ciSheet').hidden = false;
  $('ciWhere').value = ''; $('ciNote').value = ''; $('ciTime').value = localInput(Date.now() / 1000);
  $('ciNear').replaceChildren(); ciMark.clearLayers(); ciPos = null;
  $('ciStays').open = false;
  ciStays();
  ciLocate();
}
function ciClose() {
  $('ciSheet').hidden = true; $('ciSheet').classList.remove('typing'); stayLayer.clearLayers(); ciPicking = false; $('ciPick').classList.remove('on'); ciMark.clearLayers(); ciPos = null;
}
$('ciBtn').onclick = () => ($('ciSheet').hidden ? ciOpen() : ciClose());
$('ciClose').onclick = ciClose;
$('recallBtn').addEventListener('click', ciClose);
$('ciHere').onclick = ciLocate;
$('ciPick').onclick = () => {
  ciPicking = !ciPicking; $('ciPick').classList.toggle('on', ciPicking);
  if (ciPicking) $('ciPos').textContent = '地図をタップして位置を指定してください';
};
map.on('click', (e) => { if (ciPicking) { ciSetPos(e.latlng.lat, e.latlng.lng, '地図で指定'); ciSnapTime(e.latlng); } });

$('ciSheet').onsubmit = (e) => {
  e.preventDefault();
  const name = $('ciWhere').value.trim();
  if (!name) { $('ciWhere').focus(); return; }
  if (!ciPos) { toast('位置が決まっていません。現在地を取得するか、地図で指定してください'); return; }
  const t = $('ciTime').value ? Math.floor(new Date($('ciTime').value).getTime() / 1000) : Math.floor(Date.now() / 1000);
  if (!isFinite(t)) { toast('時刻を確認してください'); return; }
  // 同じ名前の場所が近く (CI_SAME_M 以内) にあればそれに付ける。無ければ新しい場所を作る (代表座標はこの位置)
  const same = placesNear().find((x) => x.p.name === name && x.d <= CI_SAME_M);
  const place = same ? null : { id: 'p' + Date.now().toString(36) + rand(3), name, lat: +ciPos.lat.toFixed(5), lon: +ciPos.lng.toFixed(5) };
  const checkin = { id: 'c' + Date.now().toString(36) + rand(3), t, place: same ? same.p.id : place.id, lat: +ciPos.lat.toFixed(5), lon: +ciPos.lng.toFixed(5) };
  const note = $('ciNote').value.trim();
  if (note) checkin.note = note;
  ciQueue.push({ op: 'add', checkin, place }); ciSaveQueue(); ciRefresh();
  ciClose();
  toast(`${name} にチェックインしました`);
  ciFlush(true);
};
// ---------- Dawarich との同期 ----------
// Tailscale につながった Mac の同期サーバ (fog-tycoon の scripts/sync-server.mjs を tailscale serve で HTTPS 公開したもの) に依頼し、
// Mac が Dawarich の最新データを Dropbox に書き出したら、読み直して最新の軌跡にする。URL はこの端末の localStorage だけに保存する。
const SYNC_TIMEOUT_MS = 60000;
$('syncurl').value = LS.get('fog_sync_url') || '';
$('syncurl').onchange = () => LS.set('fog_sync_url', $('syncurl').value.trim().replace(/\/+$/, '') || null);
// 結果は ⚙ を閉じていても見えるよう、画面下のトーストに出す (ms=0 なら出しっぱなし)
let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
// 🔄 は差分 (Mac が直近の分だけ Dawarich から取り直す。1秒前後) → recent.json を取り込む。
// ⚙ の「全件で同期」は全件 (約15秒) → points.json を読み直す。Dawarich 側で消した古い点を、すぐ反映したいとき用 (1時間ごとの全件でも正される)。
async function syncWith(path, apply, busyMsg) {
  const base = $('syncurl').value.trim().replace(/\/+$/, '');
  if (!base) { setPanel(true); $('syncurl').focus(); toast('同期先の URL を入力してください (Mac の tailscale serve の https://…ts.net)', 6000); return; }
  LS.set('fog_sync_url', base);
  const btns = [$('sync'), $('syncFull')], ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), SYNC_TIMEOUT_MS);
  for (const b of btns) b.disabled = true;
  $('sync').classList.add('busy'); toast(busyMsg, 0);
  try {
    const r = await fetch(base + path, { method: 'POST', headers: { 'x-fog-sync': '1' }, signal: ctl.signal });
    const d = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('拒否されました (この URL のページから開いていますか?)');
    if (r.status === 404) throw new Error('同期サーバが古いようです。Mac で sync-server を再起動してください');
    if (!r.ok || !d.ok) throw new Error('同期に失敗しました: ' + (d.detail ? d.detail.split('\n').pop() : d.error || r.status));
    const changed = await apply();
    toast(changed === false ? '同期しました (新しい点はありません)' : `同期しました${path === '/sync' && d.points ? ` (${d.points.toLocaleString()} 点)` : ''}`);
  } catch (err) {
    toast(err.name === 'AbortError' ? '同期がタイムアウトしました。もう一度試してください'
      : err instanceof TypeError ? '同期サーバに届きません。Tailscale に接続しているか、URL を確認してください'
      : err.message, 7000);
  } finally {
    clearTimeout(timer); for (const b of btns) b.disabled = false; $('sync').classList.remove('busy');
  }
}
$('sync').onclick = () => syncWith('/sync/recent', async () => (all.length ? pollRecent() : (await load(), true)), '最新の点を取り込んでいます…');   // まだ全件を読めていなければ全件から
$('syncFull').onclick = () => syncWith('/sync', async () => { await load(); return true; }, 'Dawarich と全件で同期しています…');
$('reload').onclick = load;
$('logout').onclick = () => {
  if (!confirm('この端末の Dropbox 認可と控えを削除しますか?')) return;
  for (const k of ['fog_key', 'fog_refresh', 'fog_ver', 'fog_state', 'fog_cache']) LS.set(k, null);
  Promise.resolve().then(() => caches.delete(DATA_CACHE)).catch(() => {}).finally(() => location.reload());   // 端末に置いた行動履歴の控えも消す
};

// 現在地 (Geolocation は HTTPS が必要。GitHub Pages なら可)
const me = L.layerGroup().addTo(map);
let quietLocate = false;   // 起動時の自動取得は失敗してもパネルを開かない
// 起動時の現在地合わせ: iOS は起動直後の1回取得が失敗しやすいので、連続測位 (watch) で最初の1点が取れるまで待つ。
// 取れたら現在地へ寄せて止める。地図を動かしたら諦める。INITIAL_LOCATE_MS 待っても取れなければ諦めて、理由を左下に出す。
const INITIAL_LOCATE_MS = 60000;
let initialLocating = false, initialTimer = 0;
const onInitialDrag = () => stopInitialLocate();   // dragstart のイベントを「理由」として渡さない
function stopInitialLocate(why) {
  if (!initialLocating) return;
  initialLocating = false; quietLocate = false;
  clearTimeout(initialTimer);
  map.off('dragstart', onInitialDrag);
  unwatchPos();
  if (why) $('bt').textContent += ` · 現在地を取得できませんでした (${why})`;
}
function startInitialLocate() {
  initialLocating = true; quietLocate = true;
  map.on('dragstart', onInitialDrag);
  initialTimer = setTimeout(() => stopInitialLocate('時間切れ'), INITIAL_LOCATE_MS);
  watchPos(60000);
}
// 連続測位 (watch) は1本だけ。リアルタイム追跡・コンパス・起動時の現在地合わせが共有し、全員が要らなくなったら止める
let posWatch = false;
function watchPos(maximumAge = 0) {
  if (posWatch) return;
  posWatch = true;
  map.locate({ watch: true, setView: false, enableHighAccuracy: true, maximumAge, timeout: 30000 });
}
function unwatchPos() {
  if (!posWatch || watching || compass || initialLocating) return;
  posWatch = false;
  map.stopLocate();
}
$('locate').onclick = () => {
  if (longPressed) { longPressed = false; setCompass(!compass); return; }   // 長押し (離した指の click) はコンパスの切り替え。通常の「現在地へ」にしない
  if (watching || compass) { setFollow(true); if (lastPos) map.setView(lastPos, map.getZoom()); return; }   // 測位中は取得し直さず、直近の位置へ戻る (縮尺はそのまま)
  if (!navigator.geolocation) { $('stats').textContent = 'この端末では現在地を取得できません'; return; }
  stopInitialLocate();
  quietLocate = false;
  map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 15000 });
};
map.on('locationfound', (e) => {
  lastPos = e.latlng;
  if (initialLocating) { map.setView(e.latlng, e.accuracy > 500 ? 15 : 17); stopInitialLocate(); }   // 最初の1点で現在地へ
  if (watching) onLive(e);
  followStep();   // 点を足さない測位 (精度が悪い・動いていない) でも、現在地を中心に保つ
  fitted = true;   // 現在地に合わせたので、データ読み込み時の全体表示で上書きしない
  me.clearLayers();
  L.circle(e.latlng, { radius: e.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(me);
  L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(me);
});
map.on('locationerror', async (e) => {
  if ((watching || compass) && e.code === 3) return;   // 追跡中のタイムアウトは次の測位を待つだけ
  if (e.code === 1) { if (watching) setLive(false); if (compass) setCompass(false); }   // 許可が取り消されたら止める
  if (initialLocating) { if (e.code === 1) stopInitialLocate('許可なし'); return; }   // 許可がなければ諦める。それ以外は次の測位を待つ
  if (quietLocate) { quietLocate = false; return; }
  setPanel(true);
  const why = { 1: '位置情報が許可されていません。ブラウザ(iOS は Safari の ぁあ → Webサイトの設定 → 位置情報)と、端末の位置情報サービスを許可してください',
    2: '位置を特定できません。電波の良い場所でもう一度試してください', 3: '位置の取得がタイムアウトしました。もう一度試してください' };
  // 切り分け用: ブラウザが持っている許可状態 (granted でも拒否されるなら端末の位置情報サービス側)
  let st = '';
  try { st = ` [ブラウザの状態: ${(await navigator.permissions.query({ name: 'geolocation' })).state}]`; } catch {}
  $('stats').textContent = '現在地を取得できません: ' + (why[e.code] || e.message) + st;
});

// ---------- リアルタイム追跡 (車の移動など) ----------
// watchPosition で位置を連続取得し、軌跡(橙)と霧の晴れ範囲に即反映する。点は保存しない(正式な記録は Dawarich → export 経由)。
// ブラウザはバックグラウンドだと測位が止まるので、追跡中は画面を点けたままにする (Wake Lock)。
const LIVE_MAX_ACC_M = 100, LIVE_MIN_STEP_M = 5;
let watching = false, lastPos = null, wake = null;
const liveLine = L.polyline([], { color: '#f59e0b', weight: 4, opacity: 0.9, interactive: false }).addTo(map);
// 軌跡の線は「途切れた所」で分ける。バックグラウンドや圏外の間に移動しても、前の点と次の点を直線で結ばない。
const LIVE_BREAK_M = 30;                            // バックグラウンドを挟んだとき、これ以上動いていたら線を切る
const LIVE_GAP_SEC = 90, LIVE_GAP_M = 150;          // 測位が途切れた (時間・距離とも超えた) ら線を切る
const LIVE_MAX_SPEED_MS = 80;                       // 前の点からの速さがこれを超える (=古い位置からの飛び) なら線を切る
const liveSegs = [];                                // 線分のリスト (各要素は [latlng, ...])
let liveBreak = true;                               // 次に取れた点から新しい線分を始める
async function lockScreen() { try { wake = await navigator.wakeLock.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => {
  if (!watching) return;
  if (document.visibilityState === 'visible') lockScreen(); else liveBreak = true;   // 裏に回ったら、戻って最初の点から新しい線分
});
// ---------- 追従 ----------
// 追従中は現在地を画面の中心に保つ。縮尺は触らない (ズームは画面中心基準にして、拡大縮小しても現在地が中心から外れない)。
// 地図を1本指でドラッグしたら追従をやめる (◎ で戻る)。ピンチは2本指なので外さない。
// 追従中は ◎ の文字が青い (外れると灰色。コンパス中は ◎ 全体が青)。
let follow = false, touching = 0, firstFollowZoom = false, dragCancel = 0;
function setFollow(on) {
  follow = on;
  const z = on ? 'center' : true;
  map.options.touchZoom = map.options.scrollWheelZoom = map.options.doubleClickZoom = z;
  $('locate').classList.toggle('follow', on);
}
(() => {
  const el = map.getContainer(), opt = { capture: true, passive: true };
  const count = (e) => {
    touching = e.touches.length;
    // 指が揃う前の1本目の動きで dragstart が出て追従が外れていたら、2本指になった時点でピンチだったとみなして戻す
    if (touching >= 2 && dragCancel && Date.now() - dragCancel < 1000) { setFollow(true); dragCancel = 0; }
    if (!touching) setTimeout(() => followStep(true), 400);   // 離した後のズームの動き (アニメーション) が終わってから、触っている間に動いた分を寄せる
  };
  for (const t of ['touchstart', 'touchend', 'touchcancel']) el.addEventListener(t, count, opt);
})();
map.on('dragstart', () => { if (touching < 2 && follow) { setFollow(false); dragCancel = Date.now(); } });
map.on('zoomend', () => followStep(true));   // ピンチ終了のズームは操作前の中心へ寄るので、終わったら現在地へ戻す
// 見張り: 測位は止まっていると来ない (iOS は動かないと更新しない) ので、何かの拍子に中心がずれたら1秒以内に戻す
setInterval(() => {
  if (follow && lastPos && !touching && map.latLngToContainerPoint(lastPos).distanceTo(map.getSize().divideBy(2)) > 4) followStep(true);
}, 1000);
function followStep(instant) {
  if (!follow || !lastPos || touching) return false;   // 触っている間は動かさない (ピンチ・ドラッグと喧嘩する)
  const z = firstFollowZoom ? Math.max(map.getZoom(), 16) : map.getZoom();   // 追跡を始めて最初の1回だけ寄る。以降は縮尺に触れない
  firstFollowZoom = false;
  // instant: アニメーションなしで寄せる (ズームのアニメーションと重ねない)。通常の測位ごとの追従はなめらかに動かす
  map.setView(lastPos, z, instant === true ? { animate: false } : undefined);   // move で霧も再描画される
  return true;
}
function onLive(e) {
  if (e.accuracy > LIVE_MAX_ACC_M) return;
  const last = live[live.length - 1];
  if (last && map.distance([last[1], last[2]], e.latlng) < LIVE_MIN_STEP_M) return;
  const now = Math.floor(Date.now() / 1000);
  const dist = last ? map.distance([last[1], last[2]], e.latlng) : 0, dt = last ? now - last[0] : 0;
  const cut = !liveSegs.length || (last && ((liveBreak && dist > LIVE_BREAK_M) || (dt > LIVE_GAP_SEC && dist > LIVE_GAP_M) || dist / Math.max(1, dt) > LIVE_MAX_SPEED_MS));
  if (cut) liveSegs.push([]);
  liveBreak = false;
  live.push([now, e.latlng.lat, e.latlng.lng]);
  liveSegs[liveSegs.length - 1].push(e.latlng);
  liveLine.setLatLngs(liveSegs);
  if (follow && !touching) return;   // 追従は locationfound の followStep が動かし、move で霧も再描画される
  if ($('fog').checked && map.hasLayer(fog)) fog.redraw();   // データ未読み込みで霧が載っていないときは何もしない
}
function setLive(on) {
  if (on && !navigator.geolocation) { $('stats').textContent = 'この端末では現在地を取得できません'; return; }
  watching = on;
  if (on) setFollow(true);
  else if (!compass) setFollow(false);
  if (on) liveBreak = true;   // 追跡を止めていた間の移動は結ばない
  $('live').classList.toggle('on', on);
  $('live').setAttribute('aria-pressed', on);
  if (on) {
    quietLocate = false;
    watchPos();
    if (lastPos) map.setView(lastPos, Math.max(map.getZoom(), 16));   // 追跡を始めたときだけ、街区が見える縮尺まで寄る (以降は縮尺に触れない)
    else firstFollowZoom = true;
    lockScreen();
  } else {
    unwatchPos();
    try { wake && wake.release(); } catch {}
    wake = null;
  }
}
$('live').onclick = () => setLive(!watching);

// ---------- コンパス (◎ を長押し) ----------
// 地図を端末の向きに回し、向いている方向を画面の上にする (地図アプリの「方位を追従」と同じ)。現在地への追従も一緒に入る。
// もう一度長押しで切る (北が上に戻る)。iOS は向きの取得に許可が要り、ユーザー操作の中で聞く必要があるので、長押しの確定時に聞く。
// 向きは端末のコンパス (iOS: webkitCompassHeading / Android: deviceorientationabsolute の alpha)。軽く均して、一定以上動いたときだけ回す。
const LONG_PRESS_MS = 500, COMPASS_SMOOTH = 0.3, COMPASS_MIN_DEG = 2, COMPASS_MIN_MS = 80, COMPASS_WAIT_MS = 3000;
let compass = false, longPressed = false, heading = null, appliedHeading = null, lastRotate = 0, compassWait = 0;
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;   // a - b を -180..180 に
function onOrientation(e) {
  let h = e.webkitCompassHeading;   // iOS: 北を0とする時計回り
  if (h == null) {
    if (e.alpha == null || (e.type !== 'deviceorientationabsolute' && !e.absolute)) return;   // 相対値の alpha は北を指さない
    h = 360 - e.alpha;   // alpha は反時計回り
  }
  h += (screen.orientation && screen.orientation.angle) || 0;   // 横向きなど、画面の上が端末の上とずれている分
  clearTimeout(compassWait);
  heading = heading == null ? h : (heading + angDiff(h, heading) * COMPASS_SMOOTH + 360) % 360;
  const now = performance.now();
  if (appliedHeading != null && (Math.abs(angDiff(heading, appliedHeading)) < COMPASS_MIN_DEG || now - lastRotate < COMPASS_MIN_MS)) return;
  appliedHeading = heading; lastRotate = now;
  map.setBearing(360 - heading);   // 向いている方向が上になるよう、逆向きに回す
}
async function setCompass(on) {
  if (on === compass) return;
  if (on) {
    if (!navigator.geolocation || !('DeviceOrientationEvent' in window)) { toast('この端末ではコンパスが使えません'); return; }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {   // iOS 13+
      let r = 'denied';
      let why = '';
      try { r = await DeviceOrientationEvent.requestPermission(); } catch (err) { why = ` (${err.name})`; }
      if (r !== 'granted') { toast(`「モーションと方向」が許可されていません${why}。アプリを完全に閉じて開き直し、もう一度長押しして「許可」を選んでください`, 7000); return; }
    }
    compass = true; heading = appliedHeading = null;
    $('locate').classList.add('on'); $('locate').setAttribute('aria-pressed', true);
    addEventListener('deviceorientation', onOrientation);
    addEventListener('deviceorientationabsolute', onOrientation);
    compassWait = setTimeout(() => { toast('端末の向きを取得できません'); setCompass(false); }, COMPASS_WAIT_MS);   // 向きが1度も来なければ諦める (PC など)
    setFollow(true);
    watchPos();
    if (lastPos) followStep();
    toast('コンパス: 向いている方向が上になります (もう一度長押しで解除)');
  } else {
    compass = false;
    clearTimeout(compassWait);
    removeEventListener('deviceorientation', onOrientation);
    removeEventListener('deviceorientationabsolute', onOrientation);
    $('locate').classList.remove('on'); $('locate').setAttribute('aria-pressed', false);
    map.setBearing(0);
    if (!watching) setFollow(false);
    unwatchPos();
  }
}
(() => {   // 長押し: LONG_PRESS_MS 押し続けたらコンパスを切り替える。離したときの click は通常の「現在地へ」にしない
  const b = $('locate');
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  b.addEventListener('pointerdown', () => {
    cancel(); longPressed = false;
    timer = setTimeout(() => { longPressed = true; navigator.vibrate && navigator.vibrate(30); }, LONG_PRESS_MS);   // 切り替えは離したときの click で (許可ダイアログはタイマーからは出せない)
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(t, cancel);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
})();

// ---------- 表示位置の保存 / 起動時の初期位置 ----------
// 起動 (新しいセッション) は現在地へ。同じセッションでの再表示 (タブの再読み込み・復帰) は最後に見ていた位置を維持。
// iOS がバックグラウンドのページを破棄して再読み込みした場合も sessionStorage は残る。
const SS = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};
// 前回の表示位置。起動直後の setView (既定の東京) の moveend で上書きされる前に読んでおく
let prevView = null;
try { prevView = JSON.parse(LS.get('fog_view')); } catch {}
const RESUME_MS = 10 * 60 * 1000;   // これ以上離れていたら「新規起動」とみなして現在地へ (タスクキル後の起動など)
const saveView = () => {
  const c = map.getCenter();
  LS.set('fog_view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom(), t: Date.now() }));
};
map.on('moveend', saveView);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveView(); });
addEventListener('pagehide', saveView);
function initialView() {
  const v = SS.get('fog_started') && prevView && Date.now() - prevView.t < RESUME_MS ? prevView : null;
  SS.set('fog_started', '1');
  if (v && isFinite(v.lat) && isFinite(v.lng) && isFinite(v.zoom)) { map.setView([v.lat, v.lng], v.zoom); fitted = true; return; }
  if (!navigator.geolocation) return;
  startInitialLocate();   // 失敗したらデータ全体表示のまま
}

// ---------- ビルド表示・更新確認 (gyazo-tycoon-viewer と同じ方式) ----------
// build-info.js は GitHub Actions のデプロイ時に sha/時刻で上書きされる。ローカルは 'dev'。
$('bt').textContent = window.BUILD_INFO ? `build ${BUILD_INFO.sha} (${BUILD_INFO.time})` : '';
// ホーム画面に追加した iOS の Web アプリは HTML を強くキャッシュするので、起動時に build-info.js を no-store で取り直し、
// デプロイ済みの sha が今のページと違えば ?v=<sha> 付き URL へ移動して読み直す
(async () => {
  const cur = window.BUILD_INFO && BUILD_INFO.sha;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname);   // ローカルの 'dev' は比べない。配信先で 'dev' なら古い版なので更新する
  if (!cur || (cur === 'dev' && local) || /[?&](code|error)=/.test(location.search)) return;   // 認可の戻り(code は1回しか使えない)では動かさない
  try {
    const t = await (await fetch('build-info.js?nc=' + Date.now(), { cache: 'no-store' })).text();
    const m = t.match(/sha:\s*'([0-9a-f]+)'/);
    if (!m || m[1] === cur) return;
    if (SS.get('fog_upd') === m[1]) return;   // 同じ版へ移動済み(デプロイ反映待ちなど)なら繰り返さない
    SS.set('fog_upd', m[1]);
    const u = new URL(location.href); u.searchParams.set('v', m[1]); location.replace(u);
  } catch {}
})();

// ---------- 起動 ----------
// 初期表示は前回の位置から (東京 → データ全体 → 現在地 と動くと、遠いタイルを何度も読んで待たされる)。
// 前回の位置がない・広域 (zoom<10) のときだけ、従来どおり東京 → データ全体の表示。
const resumable = (v) => v && isFinite(v.lat) && isFinite(v.lng) && isFinite(v.zoom) && v.zoom >= 10;
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));   // 地図タイルのキャッシュ
(async () => {
  if (resumable(prevView)) { map.setView([prevView.lat, prevView.lng], prevView.zoom); fitted = true; }   // fitted: データ読み込み時の全体表示で飛ばさない
  else map.setView([35.68, 139.76], 11);
  try { await finishLogin(); } catch (err) { $('loginErr').textContent = err.message; }
  if (!LS.get('fog_refresh')) {
    $('redir').textContent = REDIR;
    $('key').value = LS.get('fog_key') || '';
    $('login').hidden = false;
    $('loginBtn').onclick = () => {
      const k = $('key').value.trim();
      if (!k) { $('loginErr').textContent = 'App key を入力してください'; return; }
      startLogin(k).catch((e) => ($('loginErr').textContent = e.message));
    };
    return;
  }
  restoreSettings();
  if ($('tracks').checked) tracksLayer.addTo(map);
  $('ui').hidden = false;
  $('locate').hidden = false;
  $('live').hidden = false;
  $('mode').hidden = false;
  $('recallBtn').hidden = false;
  $('pinBtn').hidden = false;
  $('ciBtn').hidden = false;
  $('sync').hidden = false;
  setMode(LS.get('fog_mode') === 'heat' ? 'heat' : 'fog');
  initialView();
  load().then(startRecentPoll);
  ciStart();
})();
