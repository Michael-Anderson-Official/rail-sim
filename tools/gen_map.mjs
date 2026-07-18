// OSM生データ(buildings_raw.json / roads_raw.json)から buildings.js / roads.js を生成する
// - 座標変換は segment.js と同じ球面近似(x=dlng·a·cosφ0, z=-dlat·a)・0.1m丸め
// - 建物: h = heightタグ(0.1丸め) > building:levels×3 > 6。線路中心線13m回廊
//   (輪郭頂点＋辺中点判定)に掛かる建物は除外(前面展望で建物内を走らないため)
// - 道路: highway種別→[幅, 種類(0=車道,1=歩道系)]。表にない種別は除外。クリップなし
// 使い方: node tools/gen_map.mjs  (リポジトリ直下で。segment.js生成後に実行)
import fs from "fs";

const C = { lat: 35.66808008333333, lng: 139.6283615 };
const D2R = Math.PI / 180, A = 6378137;
const KX = A * Math.cos(C.lat * D2R) * D2R, KZ = A * D2R;
const toXZ = (lat, lon) => [(lon - C.lng) * KX, -(lat - C.lat) * KZ];
const r1 = v => Math.round(v * 10) / 10;

// 線路中心線(生成済みsegment.jsを読む)を8m刻みにサンプル
const seg = JSON.parse(fs.readFileSync("segment.js", "utf8").replace(/^const SEGMENT=/, "").replace(/;\s*$/, ""));
const trackPts = [];
for (let i = 1; i < seg.points.length; i++) {
  const a = seg.points[i - 1], b = seg.points[i];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / 8));
  for (let k = 0; k < n; k++) trackPts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
}
const CORRIDOR = 13, C2 = CORRIDOR * CORRIDOR;
function nearTrack(x, z) {
  for (const t of trackPts) {
    const dx = x - t[0], dz = z - t[1];
    if (dx * dx + dz * dz < C2) return true;
  }
  return false;
}

// ---- 建物 ----
{
  const raw = JSON.parse(fs.readFileSync("buildings_raw.json", "utf8"));
  const out = [];
  let removed = 0;
  for (const w of raw.elements) {
    if (w.type !== "way" || !w.geometry || !w.tags || !w.tags.building) continue;
    const g = w.geometry.slice(0, -1);   // 閉路の重複終点を除く
    if (g.length < 3) continue;
    const p = g.map(q => { const [x, z] = toXZ(q.lat, q.lon); return [r1(x), r1(z)]; });
    // 線路回廊判定: 頂点と辺中点
    let hit = false;
    for (let i = 0; i < p.length && !hit; i++) {
      const q = p[i], nx = p[(i + 1) % p.length];
      if (nearTrack(q[0], q[1]) || nearTrack((q[0] + nx[0]) / 2, (q[1] + nx[1]) / 2)) hit = true;
    }
    if (hit) { removed++; continue; }
    let h = 6;
    if (w.tags.height && isFinite(parseFloat(w.tags.height))) h = r1(parseFloat(w.tags.height));
    else if (w.tags["building:levels"] && isFinite(parseInt(w.tags["building:levels"], 10))) h = parseInt(w.tags["building:levels"], 10) * 3;
    out.push({ p, h });
  }
  fs.writeFileSync("buildings.js", "const BUILDINGS=" + JSON.stringify(out) + ";\n");
  console.log(`buildings.js: ${out.length}棟 (線路回廊で${removed}棟除外)`);
}

// ---- 道路 ----
{
  const HWY = {
    motorway: [13, 0], trunk: [13, 0], primary: [12, 0], secondary: [9, 0],
    tertiary: [7, 0], motorway_link: [7, 0], trunk_link: [7, 0], primary_link: [7, 0],
    secondary_link: [7, 0], tertiary_link: [7, 0],
    residential: [5, 0], unclassified: [5, 0], living_street: [5, 0],
    service: [3.2, 0],
    pedestrian: [3.5, 1],
    footway: [1.8, 1], path: [1.8, 1], steps: [1.8, 1], cycleway: [1.8, 1],
  };
  const raw = JSON.parse(fs.readFileSync("roads_raw.json", "utf8"));
  const out = [];
  for (const w of raw.elements) {
    if (w.type !== "way" || !w.geometry || !w.tags || !w.tags.highway) continue;
    const m = HWY[w.tags.highway];
    if (!m) continue;
    const p = w.geometry.map(q => { const [x, z] = toXZ(q.lat, q.lon); return [r1(x), r1(z)]; });
    if (p.length < 2) continue;
    out.push({ p, w: m[0], k: m[1] });
  }
  fs.writeFileSync("roads.js", "const ROADS=" + JSON.stringify(out) + ";\n");
  console.log(`roads.js: ${out.length}本`);
}
