// GSI標高タイル(dem5a_png, 5mメッシュLiDAR)から実地形の起伏を取得し terrain.js を生成する
// 1. 区間bboxをカバーするタイル(z=15)を取得(scratchpadに保存済みのものを使う。無ければ再取得)
// 2. 全タイルをデコードして1枚のピクセルグリッドにモザイク化
// 3. ローカルXZ座標の等間隔グリッド上へ双線形補間でリサンプル(欠測は近傍探索で埋める)
// 4. 3x3ボックスブラーで軽く平滑化(LiDAR点群由来の微細ノイズを均す。地形の起伏傾向は保持)
// 使い方: node tools/gen_terrain.mjs
import fs from "fs";
import { decodePNG } from "./png_decode.mjs";

const C = { lat: 35.66808008333333, lng: 139.6283615 };
const D2R = Math.PI / 180, A = 6378137;
const KX = A * Math.cos(C.lat * D2R) * D2R, KZ = A * D2R;
const toXZ = (lat, lon) => [(lon - C.lng) * KX, -(lat - C.lat) * KZ];
const toLatLon = (x, z) => [C.lat - z / KZ, C.lng + x / KX];

const Z = 15;
const TILE_X0 = 29091, TILE_X1 = 29095, TILE_Y0 = 12903, TILE_Y1 = 12905;   // 事前計算済み(bbox: 35.660-35.676N, 139.605-139.648E)
const CACHE_DIR = "tools/dem_cache";

function tile2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function tile2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

async function fetchTile(x, y) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = `${CACHE_DIR}/${x}_${y}.png`;
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${Z}/${x}/${y}.png`;
  const res = await fetch(url, { headers: { "User-Agent": "rail-sim-dev/1.0" } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cachePath, buf);
  return buf;
}

function elevFromPixel(img, px, py) {
  px = Math.max(0, Math.min(img.width - 1, px));
  py = Math.max(0, Math.min(img.height - 1, py));
  const i = (py * img.width + px) * img.channels;
  const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;                       // GSI仕様の欠測値
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

async function main() {
  const tiles = new Map();   // "x,y" -> decoded image
  for (let tx = TILE_X0; tx <= TILE_X1; tx++) {
    for (let ty = TILE_Y0; ty <= TILE_Y1; ty++) {
      const buf = await fetchTile(tx, ty);
      if (buf) tiles.set(tx + "," + ty, decodePNG(buf));
    }
  }
  console.log(`タイル取得: ${tiles.size}/${(TILE_X1 - TILE_X0 + 1) * (TILE_Y1 - TILE_Y0 + 1)}`);

  const N = Math.pow(2, Z);
  function elevAtLatLon(lat, lon) {
    const xt = (lon + 180) / 360 * N;
    const latR = lat * Math.PI / 180;
    const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * N;
    const tx = Math.floor(xt), ty = Math.floor(yt);
    const img = tiles.get(tx + "," + ty);
    if (!img) return null;
    const fx = (xt - tx) * img.width, fy = (yt - ty) * img.height;
    const px0 = Math.floor(fx - 0.5), py0 = Math.floor(fy - 0.5);
    const dx = fx - 0.5 - px0, dy = fy - 0.5 - py0;
    const e00 = elevFromPixel(img, px0, py0), e10 = elevFromPixel(img, px0 + 1, py0);
    const e01 = elevFromPixel(img, px0, py0 + 1), e11 = elevFromPixel(img, px0 + 1, py0 + 1);
    const vals = [e00, e10, e01, e11].filter(v => v !== null);
    if (!vals.length) return null;
    // 欠測は有効値の平均で置換してから双線形補間(境界の1px程度なので影響は軽微)
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const f = v => v === null ? avg : v;
    const top = f(e00) * (1 - dx) + f(e10) * dx, bot = f(e01) * (1 - dx) + f(e11) * dx;
    return top * (1 - dy) + bot * dy;
  }

  // ---- ローカルXZグリッド生成(地面メッシュと同じ4200x2400mを15m間隔でカバー) ----
  const CELL = 15, HALF_W = 2100, HALF_H = 1200;
  const cols = Math.ceil((HALF_W * 2) / CELL) + 1, rows = Math.ceil((HALF_H * 2) / CELL) + 1;
  const ox = -HALF_W, oz = -HALF_H;
  const grid = new Float32Array(cols * rows);
  let missing = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ox + i * CELL, z = oz + j * CELL;
      const [lat, lon] = toLatLon(x, z);
      let e = elevAtLatLon(lat, lon);
      if (e === null) { missing++; e = 40; }   // タイル範囲外(想定外の遠方)は平均的な標高で埋める
      grid[j * cols + i] = e;
    }
  }
  console.log(`グリッド ${cols}x${rows} (${CELL}m間隔)。範囲外/欠測: ${missing}`);

  // ---- 3x3ボックスブラー(LiDAR点群の細かいノイズを均す。建物の凹凸なども軽減) ----
  const smoothed = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii >= cols || jj < 0 || jj >= rows) continue;
        sum += grid[jj * cols + ii]; n++;
      }
      smoothed[j * cols + i] = sum / n;
    }
  }

  let min = Infinity, max = -Infinity;
  for (const v of smoothed) { if (v < min) min = v; if (v > max) max = v; }
  console.log(`標高範囲(平滑後): ${min.toFixed(1)} 〜 ${max.toFixed(1)} m`);

  const h = Array.from(smoothed).map(v => Math.round(v * 100) / 100);
  const out = { ox, oz, cell: CELL, cols, rows, h };
  fs.writeFileSync("terrain.js", "const TERRAIN=" + JSON.stringify(out) + ";\n");
  console.log(`terrain.js written (${(fs.statSync("terrain.js").size / 1024).toFixed(0)}KB)`);
}
main();
