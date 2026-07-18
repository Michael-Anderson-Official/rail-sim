// 依存なしの最小PNGデコーダ(8bit RGB/RGBA, non-interlaced専用。GSI標高タイル用)
// zlibはNode組み込みのinflateSyncを使う。カラーパレット・16bit・インターレースは非対応
import zlib from "zlib";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, ihdr = null;
  const idatChunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8), colorType: data.readUInt8(9), interlace: data.readUInt8(12),
      };
    } else if (type === "IDAT") idatChunks.push(data);
    else if (type === "IEND") break;
    off += 8 + len + 4;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error("unsupported PNG variant (bitDepth/interlace)");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error("unsupported colorType " + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const { width: W, height: H } = ihdr;
  const stride = W * channels;
  const out = Buffer.alloc(H * stride);
  let pos = 0;
  for (let y = 0; y < H; y++) {
    const filter = raw[pos]; pos += 1;
    const rowIn = raw.subarray(pos, pos + stride); pos += stride;
    const rowOut = out.subarray(y * stride, (y + 1) * stride);
    const prevOut = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = rowIn[i];
      const a = i >= channels ? rowOut[i - channels] : 0;
      const b = prevOut ? prevOut[i] : 0;
      const c = prevOut && i >= channels ? prevOut[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error("bad filter type " + filter);
      }
      rowOut[i] = v & 0xff;
    }
  }
  return { width: W, height: H, channels, data: out };
}
