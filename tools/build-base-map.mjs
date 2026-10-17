// オフライン用の背景地図 (base-map.json) を作る。Natural Earth (パブリックドメイン) の陸地ポリゴンを間引いたもの。
//   node tools/build-base-map.mjs <ne_10m_land.geojson> <ne_50m_land.geojson> base-map.json
// 日本周辺 (JP 範囲に収まる島) は 10m を細かく、それ以外の世界は 50m を粗く。1つの MultiPolygon にまとめる。
import { readFileSync, writeFileSync } from 'node:fs';

const [f10, f50, out] = process.argv.slice(2);
if (!out) { console.error('usage: node tools/build-base-map.mjs ne_10m_land.geojson ne_50m_land.geojson out.json'); process.exit(1); }

const JP = [120, 20, 150, 48];   // [西, 南, 東, 北]
const TOL_JP = 0.001, TOL_WORLD = 0.05;   // 度。0.001° ≒ 100m
const DEC = 1e4;

const bboxOf = (ring) => {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
};
const inJP = (b) => b[0] >= JP[0] && b[1] >= JP[1] && b[2] <= JP[2] && b[3] <= JP[3];

// Douglas-Peucker (反復版)。閉じたリングは両端が同じ点なので、そのまま端点を残す
function simplify(pts, tol) {
  const n = pts.length, keep = new Uint8Array(n), t2 = tol * tol;
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d2;
      if (L === 0) d2 = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L)); const qx = px - t * dx, qy = py - t * dy; d2 = qx * qx + qy * qy; }
      if (d2 > max) { max = d2; idx = i; }
    }
    if (max > t2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const round = (ring) => ring.map(([x, y]) => [Math.round(x * DEC) / DEC, Math.round(y * DEC) / DEC]);
const polys = [];
function add(poly, tol, minSpan) {
  const outer = poly[0], b = bboxOf(outer);
  if (Math.max(b[2] - b[0], b[3] - b[1]) < minSpan) return;   // 小さすぎる島は捨てる
  const rings = [];
  for (const [i, r] of poly.entries()) {
    const s = round(simplify(r, tol));
    if (s.length >= 4) rings.push(s);
    else if (i === 0) return;
  }
  polys.push(rings);
}

const load = (f) => JSON.parse(readFileSync(f, 'utf8')).features.flatMap((ft) => (ft.geometry.type === 'MultiPolygon' ? ft.geometry.coordinates : [ft.geometry.coordinates]));
for (const p of load(f10)) { const b = bboxOf(p[0]); if (inJP(b)) add(p, TOL_JP, 0.01); }
for (const p of load(f50)) { const b = bboxOf(p[0]); if (inJP(b)) continue; add(p, TOL_WORLD, 0.5); }

const json = JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } });
writeFileSync(out, json);
console.log(polys.length, 'polygons,', polys.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0), 'points,', (json.length / 1024).toFixed(0), 'KB');
