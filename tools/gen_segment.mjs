// 京王線の実線形(OSM rail_raw.json)から segment.js を生成する
// - railway=rail のwayをノード共有でグラフ化し、東端→西端の本線パスをDijkstraで選ぶ
//   (siding/crossoverは距離ペナルティで回避。井の頭線はway名で除外)
// - Douglas-Peuckerで簡略化し、駅ノードを中心線へ射影してkm位置を求める
// 使い方: node tools/gen_segment.mjs  (リポジトリ直下で)
import fs from "fs";

const C = { lat: 35.66808008333333, lng: 139.6283615 };   // 既存centerを維持(PLATEAU配置と整合)
const D2R = Math.PI / 180, A = 6378137;
const KX = A * Math.cos(C.lat * D2R) * D2R, KZ = A * D2R;
const toXZ = (lat, lon) => [(lon - C.lng) * KX, -(lat - C.lat) * KZ];

// 区間の両端way(この区間専用。延伸時はここを差し替える)
const EAST_END_WAY = 47195914;    // 下高井戸の東・明大前方(東端ノードを起点に)
const WEST_END_WAY = 777012687;   // 八幡山の西・芦花公園方(西端ノードを終点に)

const raw = JSON.parse(fs.readFileSync("rail_raw.json", "utf8"));
const ways = raw.elements.filter(e => e.type === "way" && e.geometry &&
  !(e.tags && e.tags.name && e.tags.name.includes("井の頭")));
const stations = raw.elements.filter(e => e.type === "node" && e.tags && e.tags.railway === "station");

// ---- グラフ構築(ノードID→隣接) ----
const pos = new Map();   // nodeId -> [x,z]
const adj = new Map();   // nodeId -> [{to, w}]
function addEdge(a, b, w) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push({ to: b, w });
  adj.get(b).push({ to: a, w });
}
for (const w of ways) {
  const pen = (w.tags && (w.tags.service === "siding" || w.tags.service === "yard" ||
    w.tags.service === "crossover" || w.tags.service === "spur")) ? 8 : 1;
  for (let i = 0; i < w.nodes.length; i++) {
    const id = w.nodes[i], g = w.geometry[i];
    if (!pos.has(id)) pos.set(id, toXZ(g.lat, g.lon));
  }
  for (let i = 1; i < w.nodes.length; i++) {
    const a = pos.get(w.nodes[i - 1]), b = pos.get(w.nodes[i]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    addEdge(w.nodes[i - 1], w.nodes[i], d * pen);
  }
}

// 端点: 指定wayの最東端/最西端ノード
function endNode(wayId, dir) {
  const w = ways.find(x => x.id === wayId);
  let best = null, bx = dir > 0 ? -1e9 : 1e9;
  for (let i = 0; i < w.nodes.length; i++) {
    const x = pos.get(w.nodes[i])[0];
    if (dir > 0 ? x > bx : x < bx) { bx = x; best = w.nodes[i]; }
  }
  return best;
}
const S = endNode(EAST_END_WAY, +1), T = endNode(WEST_END_WAY, -1);

// ---- Dijkstra ----
const dist = new Map([[S, 0]]), prev = new Map();
const Q = new Set([S]);
while (Q.size) {
  let u = null, du = Infinity;
  for (const n of Q) { const d = dist.get(n); if (d < du) { du = d; u = n; } }
  Q.delete(u);
  if (u === T) break;
  for (const { to, w } of adj.get(u) || []) {
    const nd = du + w;
    if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); Q.add(to); }
  }
}
if (!prev.has(T)) { console.error("経路が見つからない"); process.exit(1); }
let chain = [T];
while (chain[chain.length - 1] !== S) chain.push(prev.get(chain[chain.length - 1]));
chain.reverse();   // 東(下高井戸側)→西(八幡山側)
let path = chain.map(id => pos.get(id));

// ---- Douglas-Peucker簡略化 ----
function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let imax = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = ((pts[i][0] - a[0]) * (b[0] - a[0]) + (pts[i][1] - a[1]) * (b[1] - a[1])) /
      (((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) || 1e-9);
    const q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const d = Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]);
    if (d > dmax) { dmax = d; imax = i; }
  }
  if (dmax <= eps) return [a, b];
  return dp(pts.slice(0, imax + 1), eps).slice(0, -1).concat(dp(pts.slice(imax), eps));
}
// DPは軽く(ノイズ除去)かけ、その後40m等間隔で再サンプルする。
// 点間隔が大きいとランタイムのCatmullRom(tension0.5)が波打って実線形から外れるため
const dped = dp(path, 0.8);
function resample(pts, step) {
  const out = [pts[0].slice()];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1], b = pts[i];
    let d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (acc + d >= step) {
      const t = (step - acc) / d;
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(q);
      a = q; d = Math.hypot(b[0] - a[0], b[1] - a[1]); acc = 0;
    }
    acc += d;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.3) out.push(last.slice());
  else { out[out.length - 1] = last.slice(); }
  return out;
}
const simplified = resample(dped, 40).map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);

// ---- 駅を中心線へ射影 ----
function project(pt, pts) {
  let best = { d: 1e9, p: null };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * dx, a[1] + t * dz];
    const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
    if (d < best.d) best = { d, p: q };
  }
  return best;
}
const KEY = { "下高井戸": "shimotakaido", "桜上水": "sakurajosui", "上北沢": "kamikitazawa", "八幡山": "hachimanyama" };
const stOut = {};
for (const s of stations) {
  const key = KEY[s.tags.name];
  if (!key) continue;
  const pr = project(toXZ(s.lat, s.lon), simplified);
  stOut[key] = [Math.round(pr.p[0] * 100) / 100, Math.round(pr.p[1] * 100) / 100];
  console.log(`${s.tags.name}: 射影距離 ${pr.d.toFixed(1)}m → [${stOut[key]}]`);
}

let len = 0;
for (let i = 1; i < simplified.length; i++)
  len += Math.hypot(simplified[i][0] - simplified[i - 1][0], simplified[i][1] - simplified[i - 1][1]);
console.log(`points: ${path.length} → ${simplified.length} (DP0.8m+40m等間隔) / 全長 ${len.toFixed(0)}m`);

const out = { center: C, points: simplified, stations: stOut };
fs.writeFileSync("segment.js", "const SEGMENT=" + JSON.stringify(out) + ";\n");
console.log("segment.js written");
