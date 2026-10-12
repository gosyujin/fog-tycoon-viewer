// fog-tycoon の外出先ビューア。コード・鍵・データは含まない。
// Dropbox(App Folder) の /points.json を、端末で認可(PKCE・files.content.read のみ)して読む。
// points.json: { generated, points: [[epochSec, lat, lon], ...] } (時刻昇順)
const SCOPE = 'files.content.read';
const DATA_PATH = '/points.json';
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

async function tokenReq(params) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams(params) });
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

async function fetchPoints() {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify({ path: DATA_PATH }) },
  });
  if (!r.ok) throw new Error('download ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const text = await r.text();
  LS.set('fog_cache', text);   // 通信できないとき用の控え (入らなければ無視)
  return JSON.parse(text);
}

// ---------- 地図 ----------
const map = L.map('map', { zoomSnap: 0.5, preferCanvas: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 19,
}).addTo(map);

let all = [], points = [];
const live = [];   // リアルタイム追跡で取った点 [epochSec, lat, lon] (メモリのみ。霧・軌跡には即反映)
const tracksLayer = L.layerGroup();   // 軌跡は既定でオフ
let mode = 'fog';   // 'fog' (通った所は全部晴れ) | 'heat' (訪問日数のヒートマップ)
let cells = [];   // 濃淡モード用: [lat, lon, 訪問日数] (CELL_M 四方のセル単位で集計)
const CELL_M = 20;
const mask = document.createElement('canvas'), mctx = mask.getContext('2d', { willReadFrequently: true });

// ヒートマップの色: 訪問日数ごとの基準色 [この日数以上, 色]。凡例 (#legend) と揃える。間の輝度は色を補間してなめらかにつなぐ
const HEAT_STEPS = [[1, [59, 130, 246]], [2, [34, 197, 94]], [4, [250, 204, 21]], [10, [239, 68, 68]]];
const HEAT_ALPHA = 0.6, HEAT_FEATHER = [0.03, 0.6];   // 色が付く縁は 1日の輝度の 3%→60% で透明→不透明に立ち上げてぼかす
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
// GPS の点は疎なので、軌跡と同じ条件 (GAP_SEC / GAP_M 以内) で隣り合う点の間も CELL_M/2 刻みで補間し、通った道を連続させる
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
    if (prev && ts - prev[0] <= GAP_SEC) {
      const d = Math.hypot((lat - prev[1]) * 111000, (lon - prev[2]) * 111000 * cosLat);
      if (d <= GAP_M) {
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
    m.on('move zoom resize viewreset', this.redraw, this);
    this.redraw();
  },
  onRemove(m) {
    m.off('move zoom resize viewreset', this.redraw, this);
    this._c.remove();
  },
  redraw() {
    const m = this._map, size = m.getSize(), dpr = window.devicePixelRatio || 1, c = this._c;
    L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
    c.width = size.x * dpr; c.height = size.y * dpr;
    c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    if (mode === 'fog') {
      g.fillStyle = `rgba(8, 10, 16, ${+$('density').value / 100})`;
      g.fillRect(0, 0, size.x, size.y);
    }
    g.globalCompositeOperation = 'destination-out';
    const mpp = 40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180) / (256 * 2 ** m.getZoom());
    const r = Math.max(3, +$('radius').value / mpp);
    const b = m.getBounds().pad(r * mpp / 111000 + 0.01);
    if (mode === 'heat') return this._heat(g, m, size, r, b);
    const step = Math.max(1, r / 3), seen = new Set();   // 近接点は同じピクセルセルに丸めて描画を減らす
    for (const [, lat, lon] of points.concat(live)) {
      if (!b.contains([lat, lon])) continue;
      const p = m.latLngToContainerPoint([lat, lon]);
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
  },
  // ヒートマップ: 低解像度の格子に、各セルの訪問日数を重みにした山 (HEAT_PROFILE) を足し合わせて密度を作り、色に変換して重ねる。
  // セルごとの最大値ではなく足し合わせなので、日数の違うセルが隣り合っても色がなめらかにつながる。
  // 1日だけ通った道の中心が「1日」になるよう、道に沿ってセルが並んだときの合計 (HEAT_LINE_SUM) で割る。霧は出さない。
  // リアルタイム追跡の点は「今日1日分」として扱う
  _heat(g, m, size, r, b) {
    const w = Math.ceil(size.x), h = Math.ceil(size.y);
    if (!w || !h) return;
    const step = Math.max(1, r / 8), rg = r / step;   // 格子の1マス (CSS px)。山の半径は常に約8マス (荒いので拡大時に補間して滑らかにする)
    const gw = Math.ceil(w / step) + 2, gh = Math.ceil(h / step) + 2;
    if (heatBuf.length < gw * gh) heatBuf = new Float32Array(gw * gh);
    const F = heatBuf; F.fill(0, 0, gw * gh);
    const add = (lat, lon, n) => {
      if (!b.contains([lat, lon])) return;
      const p = m.latLngToContainerPoint([lat, lon]), cx = p.x / step, cy = p.y / step;
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
    for (const [, lat, lon] of live) add(lat, lon, 1);
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

function drawTracks() {
  tracksLayer.clearLayers();
  let seg = [], prev = null;
  const flush = () => {
    if (seg.length > 1) L.polyline(seg, { color: '#4fc3f7', weight: 2, opacity: 0.7, interactive: false }).addTo(tracksLayer);
    seg = [];
  };
  for (const [ts, lat, lon] of points) {
    if (prev && (ts - prev[0] > GAP_SEC || map.distance([prev[1], prev[2]], [lat, lon]) > GAP_M)) flush();
    seg.push([lat, lon]); prev = [ts, lat, lon];
  }
  flush();
}

let note = '', fitted = false;
function applyRange() {
  const v = $('range').value;
  const since = v === 'all' ? 0 : Date.now() / 1000 - Number(v) * 86400;
  points = all.filter((p) => p[0] >= since);
  const km = points.reduce((s, p, i) => (i && p[0] - points[i - 1][0] <= GAP_SEC ? s + map.distance([points[i - 1][1], points[i - 1][2]], [p[1], p[2]]) : s), 0) / 1000;
  $('stats').textContent = `${points.length.toLocaleString()} 点 / 約 ${km.toFixed(1)} km${note}`;
  buildCells();
  drawTracks();
  if ($('fog').checked) fog.redraw();
}

function showData(d, offline) {
  all = d.points || [];
  const when = d.generated ? new Date(d.generated).toLocaleString('ja-JP') : '';
  note = (when ? ` · 更新 ${when}` : '') + (offline ? ' · オフライン(控え)' : '');
  if (!all.length) { $('stats').textContent = '点がありません'; return; }
  let s = 90, w = 180, n = -90, e = -180;   // spread だと大量点でスタックが溢れるのでループで求める
  for (const [, lat, lon] of all) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
  if (!fitted) { map.fitBounds([[s, w], [n, e]]); fitted = true; }   // 再読み込みで表示位置を飛ばさない
  if (!map.hasLayer(fog) && $('fog').checked) fog.addTo(map);
  applyRange();
}

async function load() {
  $('stats').textContent = '読み込み中…';
  try {
    showData(await fetchPoints(), false);
  } catch (err) {
    const cached = LS.get('fog_cache');
    if (cached && !/ 40[019]\b/.test(err.message)) {   // 認可切れ(400/401/409)は控えに逃げない
      try { showData(JSON.parse(cached), true); return; } catch {}
    }
    $('stats').textContent = '読み込めません: ' + err.message;
  }
}

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
      z = { y: t.clientY, zoom: map.getZoom(), moved: false, at: map.mouseEventToContainerPoint(t), snap: map.options.zoomSnap };
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
const SETTING_IDS = ['fog', 'tracks', 'radius', 'density', 'range'];
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
$('tracks').onchange = (e) => { saveSettings(); e.target.checked ? tracksLayer.addTo(map) : map.removeLayer(tracksLayer); };
$('radius').oninput = (e) => { $('rv').textContent = e.target.value; saveSettings(); if ($('fog').checked) fog.redraw(); };
$('density').oninput = (e) => { $('dv').textContent = e.target.value; saveSettings(); if ($('fog').checked) fog.redraw(); };
$('range').onchange = () => { saveSettings(); applyRange(); };
const syncLegend = () => { $('legend').hidden = !(mode === 'heat' && $('fog').checked); };
function setMode(m) {
  mode = m;
  const heat = m === 'heat';
  $('mode').textContent = heat ? '🔥' : '🌫';
  $('mode').classList.toggle('on', heat);
  $('mode').setAttribute('aria-pressed', heat);
  $('mode').setAttribute('aria-label', heat ? 'ヒートマップ (押すと霧)' : '霧 (押すとヒートマップ)');
  syncLegend();
  if (map.hasLayer(fog)) fog.redraw();   // 起動時はまだ地図に載っていない
}
$('mode').onclick = () => { setMode(mode === 'heat' ? 'fog' : 'heat'); LS.set('fog_mode', mode); };
$('reload').onclick = load;
$('logout').onclick = () => {
  if (!confirm('この端末の Dropbox 認可と控えを削除しますか?')) return;
  for (const k of ['fog_key', 'fog_refresh', 'fog_ver', 'fog_state', 'fog_cache']) LS.set(k, null);
  location.reload();
};

// 現在地 (Geolocation は HTTPS が必要。GitHub Pages なら可)
const me = L.layerGroup().addTo(map);
let quietLocate = false;   // 起動時の自動取得は失敗してもパネルを開かない
let locateRetry = 0;
$('locate').onclick = () => {
  if (watching) { follow = true; if (lastPos) map.setView(lastPos, Math.max(map.getZoom(), 16)); return; }   // 追跡中は取得し直さず、直近の位置へ戻る
  if (!navigator.geolocation) { $('stats').textContent = 'この端末では現在地を取得できません'; return; }
  quietLocate = false;
  map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 15000 });
};
map.on('locationfound', (e) => {
  lastPos = e.latlng;
  if (watching) onLive(e);
  fitted = true;   // 現在地に合わせたので、データ読み込み時の全体表示で上書きしない
  me.clearLayers();
  L.circle(e.latlng, { radius: e.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(me);
  L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(me);
});
map.on('locationerror', async (e) => {
  if (watching && e.code === 3) return;   // 追跡中のタイムアウトは次の測位を待つだけ
  if (watching && e.code === 1) setLive(false);   // 許可が取り消されたら止める
  if (quietLocate) {
    if (locateRetry > 0) { locateRetry--; map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 }); return; }
    quietLocate = false; return;
  }
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
let watching = false, follow = false, lastPos = null, wake = null;
const liveLine = L.polyline([], { color: '#f59e0b', weight: 4, opacity: 0.9, interactive: false }).addTo(map);
async function lockScreen() { try { wake = await navigator.wakeLock.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (watching && document.visibilityState === 'visible') lockScreen(); });
map.on('dragstart', () => { follow = false; });   // 地図を動かしたら追従をやめる (◎ で戻る)
function onLive(e) {
  if (e.accuracy > LIVE_MAX_ACC_M) return;
  const last = live[live.length - 1];
  if (last && map.distance([last[1], last[2]], e.latlng) < LIVE_MIN_STEP_M) return;
  live.push([Math.floor(Date.now() / 1000), e.latlng.lat, e.latlng.lng]);
  liveLine.addLatLng(e.latlng);
  if (follow) map.setView(e.latlng, Math.max(map.getZoom(), 16));   // move で霧も再描画される
  else if ($('fog').checked) fog.redraw();
}
function setLive(on) {
  if (on && !navigator.geolocation) { $('stats').textContent = 'この端末では現在地を取得できません'; return; }
  watching = on; follow = on;
  $('live').classList.toggle('on', on);
  $('live').setAttribute('aria-pressed', on);
  if (on) {
    quietLocate = false;
    map.locate({ watch: true, setView: false, enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    lockScreen();
  } else {
    map.stopLocate();
    try { wake && wake.release(); } catch {}
    wake = null;
  }
}
$('live').onclick = () => setLive(!watching);

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
  quietLocate = true;   // 失敗したらデータ全体表示のまま
  locateRetry = 1;      // 起動直後は測位が間に合わず失敗しやすいので、精度を落として1回だけ取り直す
  map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
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
(async () => {
  map.setView([35.68, 139.76], 11);
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
  setMode(LS.get('fog_mode') === 'heat' ? 'heat' : 'fog');
  initialView();
  load();
})();
