// PLATEAU 3D Tiles(世田谷区LOD2)から線路沿いのタイルを取得して組み込む
// 1. plateau_tileset.json のregionが線路中心線から MARGIN m 以内のタイルを選定
// 2. 未取得分をダウンロード → plateau/ に b3dm保存 + glb切り出し保存
// 3. glbのCESIUM_RTC中心を抽出、Dracoデコードで地面高g(楕円体高の3パーセンタイル)を実測
// 4. plateau_manifest.js を全タイルで書き直す
// 使い方: node tools/add_tiles.mjs           … 選定と差分表示のみ(dry run)
//         node tools/add_tiles.mjs --apply   … ダウンロードとmanifest更新まで実行
//         node tools/add_tiles.mjs --verify  … 既存タイルのg再計算で手法を自己検証
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require2 = createRequire(import.meta.url);

const BASE = "https://assets.cms.plateau.reearth.io/assets/1a/57c9bb-cbed-47c0-be15-bbe662eabce4/13112_setagaya-ku_pref_2025_citygml_1_op_bldg_3dtiles_13112_setagaya-ku_lod2_no_texture/";
const MARGIN = 210;   // 線路からこの距離(m)以内のregionのタイルを採用
const R2D = 180 / Math.PI, D2R = Math.PI / 180, A = 6378137, E2 = 0.00669437999014;
const C = { lat: 35.66808008333333, lng: 139.6283615 };
const KX = A * Math.cos(C.lat * D2R) * D2R, KZ = A * D2R;

// ---- 線路中心線(20m刻みサンプル) ----
const seg = JSON.parse(fs.readFileSync("segment.js", "utf8").replace(/^const SEGMENT=/, "").replace(/;\s*$/, ""));
const trackPts = [];
for (let i = 1; i < seg.points.length; i++) {
  const a = seg.points[i - 1], b = seg.points[i];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / 20));
  for (let k = 0; k <= n; k++) trackPts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
}

// ---- タイル選定 ----
const ts = JSON.parse(fs.readFileSync("plateau_tileset.json", "utf8"));
const tiles = [];
(function walk(n) {
  if (!n) return;
  const isLeaf = !n.children || n.children.length === 0;
  // rootのcontent(data952=全域の粗いLOD)は除外し、詳細なleafタイルのみ採用
  if (isLeaf && n.content && n.content.uri && n.boundingVolume && n.boundingVolume.region) tiles.push({ uri: n.content.uri, region: n.boundingVolume.region });
  (n.children || []).forEach(walk);
})(ts.root);

function tileDistance(region) {
  // region: [W,S,E,N](rad) → ローカルXZ矩形。線路サンプル点との最短距離
  const w = (region[0] * R2D - C.lng) * KX, e = (region[2] * R2D - C.lng) * KX;
  const s = -(region[1] * R2D - C.lat) * KZ, n = -(region[3] * R2D - C.lat) * KZ;
  const zMin = Math.min(s, n), zMax = Math.max(s, n);
  let best = Infinity;
  for (const p of trackPts) {
    const dx = p[0] < w ? w - p[0] : p[0] > e ? p[0] - e : 0;
    const dz = p[1] < zMin ? zMin - p[1] : p[1] > zMax ? p[1] - zMax : 0;
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
const wanted = tiles.filter(t => tileDistance(t.region) < MARGIN)
  .map(t => path.basename(t.uri));   // data/dataXXX.b3dm → dataXXX.b3dm

// 既存manifest
const mf = fs.readFileSync("plateau_manifest.js", "utf8");
const existing = JSON.parse(mf.replace(/^const PLATEAU_TILES=/, "").replace(/;\s*$/, ""));
const have = new Set(existing.map(t => t.f.replace(".glb", ".b3dm")));
const missing = wanted.filter(f => !have.has(f));
const obsolete = [...have].filter(f => !wanted.includes(f));
console.log(`選定: ${wanted.length}タイル / 既存: ${existing.length} / 新規: ${missing.length} / 対象外になる既存: ${obsolete.length}`);
console.log("新規:", missing.join(" ") || "(なし)");
if (obsolete.length) console.log("対象外(維持はする):", obsolete.join(" "));

// ---- glb処理ヘルパー ----
function b3dmToGlb(buf) {
  const ftJ = buf.readUInt32LE(12), ftB = buf.readUInt32LE(16), btJ = buf.readUInt32LE(20), btB = buf.readUInt32LE(24);
  return buf.slice(28 + ftJ + ftB + btJ + btB);
}
function glbChunks(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString());
  let off = 20 + jsonLen;
  let bin = null;
  if (off < glb.length) {
    const chLen = glb.readUInt32LE(off);
    bin = glb.slice(off + 8, off + 8 + chLen);
  }
  return { json, bin };
}
function ecefToH(x, y, z) {
  // Bowring近似で楕円体高
  const b = A * Math.sqrt(1 - E2);
  const ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y);
  const th = Math.atan2(z * A, p * b);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return p / Math.cos(lat) - N;
}

let dracoP = null;
function getDraco() {
  if (!dracoP) {
    const mod = require2(path.resolve("draco/draco_decoder.js"));
    const factory = mod.DracoDecoderModule || mod;
    // Emscriptenモジュールはthenableなので、素のresolve(m)だとPromiseが
    // 再帰unwrapして無限ループする。オブジェクトで包んでからresolveする
    // (three.js DRACOLoaderの "Wrap before resolving to avoid loop" と同じ)
    dracoP = new Promise(resolve => { factory({ onModuleLoaded: m => resolve({ draco: m }) }); });
  }
  return dracoP;
}
async function groundHeight(glb, rtcCenter) {
  const { json, bin } = glbChunks(glb);
  const { draco } = await getDraco();
  const hs = [];
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
      if (!ext) continue;
      const bv = json.bufferViews[ext.bufferView];
      const data = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      const dbuf = new draco.DecoderBuffer();
      dbuf.Init(new Int8Array(data), data.length);
      const dec = new draco.Decoder();
      const dmesh = new draco.Mesh();
      const st = dec.DecodeBufferToMesh(dbuf, dmesh);
      if (!st.ok()) { draco.destroy(dbuf); draco.destroy(dec); draco.destroy(dmesh); continue; }
      const att = dec.GetAttributeByUniqueId(dmesh, ext.attributes.POSITION);
      const n = dmesh.num_points();
      const arr = new draco.DracoFloat32Array();
      dec.GetAttributeFloatForAllPoints(dmesh, att, arr);
      for (let i = 0; i < n; i++) {
        const vx = arr.GetValue(i * 3), vy = arr.GetValue(i * 3 + 1), vz = arr.GetValue(i * 3 + 2);
        // glTF y-up → ECEF z-up: Rx(+90°) → ecef = center + [vx, -vz, vy]
        hs.push(ecefToH(rtcCenter[0] + vx, rtcCenter[1] - vz, rtcCenter[2] + vy));
      }
      draco.destroy(arr); draco.destroy(dmesh); draco.destroy(dec); draco.destroy(dbuf);
    }
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return Math.round(hs[Math.floor(hs.length * 0.03)] * 100) / 100;
}

const mode = process.argv[2];
if (mode === "--verify") {
  // 既存タイルでg再計算 → manifest値と比較して手法を検証
  const samples = existing.slice(0, 5);
  for (const t of samples) {
    const glb = fs.readFileSync("plateau/" + t.f);
    const { json } = glbChunks(glb);
    const rtc = json.extensions.CESIUM_RTC.center;
    const g = await groundHeight(glb, rtc);
    console.log(`${t.f}: manifest g=${t.g} 再計算=${g} 差=${(g - t.g).toFixed(2)}`);
  }
} else if (mode === "--apply") {
  const out = existing.slice();
  for (const f of missing) {
    const url = BASE + "data/" + f;
    process.stdout.write(`fetch ${f} ... `);
    const res = await fetch(url);
    if (!res.ok) { console.log("HTTP " + res.status + " スキップ"); continue; }
    const b3dm = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync("plateau/" + f, b3dm);
    const glb = b3dmToGlb(b3dm);
    const gname = f.replace(".b3dm", ".glb");
    fs.writeFileSync("plateau/" + gname, glb);
    const { json } = glbChunks(glb);
    const rtc = json.extensions.CESIUM_RTC.center;
    const g = await groundHeight(glb, rtc);
    out.push({ f: gname, c: [Math.round(rtc[0] * 1000) / 1000, Math.round(rtc[1] * 1000) / 1000, Math.round(rtc[2] * 1000) / 1000], g });
    console.log(`b3dm ${(b3dm.length / 1024).toFixed(0)}KB glb ${(glb.length / 1024).toFixed(0)}KB g=${g}`);
  }
  fs.writeFileSync("plateau_manifest.js", "const PLATEAU_TILES=" + JSON.stringify(out) + ";\n");
  console.log(`plateau_manifest.js: ${out.length}タイル`);
} else {
  console.log("(dry run。--apply で取得+manifest更新、--verify で手法検証)");
}
