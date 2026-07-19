// rail-sim の JS データモジュールを Unity 用 JSON にエクスポートする。
// 使い方: node tools/export_unity.mjs [出力先ディレクトリ]
// 既定の出力先: C:\Users\hagah\UnityProjects\keio-rail-export
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? 'C:\\Users\\hagah\\UnityProjects\\keio-rail-export';
mkdirSync(join(outDir, 'plateau'), { recursive: true });

// `const NAME={...};` 形式のファイルから JSON 部分を取り出す
function extract(file, constName) {
  const src = readFileSync(join(root, file), 'utf8');
  const m = src.match(new RegExp(`const\\s+${constName}\\s*=\\s*([\\s\\S]+?);?\\s*$`));
  if (!m) throw new Error(`${file}: const ${constName} が見つからない`);
  return JSON.parse(m[1]);
}

const exports_ = [
  ['segment.js', 'SEGMENT', 'segment.json'],
  ['terrain.js', 'TERRAIN', 'terrain.json'],
  ['plateau_manifest.js', 'PLATEAU_TILES', 'plateau_manifest.json'],
  ['buildings.js', 'BUILDINGS', 'buildings.json'],
  ['roads.js', 'ROADS', 'roads.json'],
];
for (const [file, constName, outName] of exports_) {
  const data = extract(file, constName);
  // Unity 側 JsonUtility はトップレベル配列を読めないため、配列はラップする
  const payload = Array.isArray(data) ? { items: data } : data;
  writeFileSync(join(outDir, outName), JSON.stringify(payload));
  console.log(`${outName} 書き出し完了`);
}

let n = 0;
for (const f of readdirSync(join(root, 'plateau'))) {
  if (f.endsWith('.glb')) { copyFileSync(join(root, 'plateau', f), join(outDir, 'plateau', f)); n++; }
}
console.log(`plateau GLB ${n} 個コピー完了 → ${outDir}`);
