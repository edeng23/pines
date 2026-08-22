#!/usr/bin/env node
/**
 * Trim a PNG to its content and re-pad with an exact margin.
 *
 *   node trim.mjs in.png out.png [marginPx]
 *
 * Background is taken from the top-left pixel. Handles 8-bit RGB/RGBA.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const [inPath, outPath, marginArg] = process.argv.slice(2);
const margin = Number(marginArg ?? 56);

const buf = readFileSync(inPath);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");

let pos = 8;
let ihdr = null;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString("ascii", pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === "IHDR") ihdr = data;
  else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  pos += 12 + len;
}

const W = ihdr.readUInt32BE(0);
const H = ihdr.readUInt32BE(4);
const depth = ihdr[8];
const colorType = ihdr[9];
if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
  throw new Error(`unsupported PNG: depth ${depth}, colorType ${colorType}`);
}
const CH = colorType === 6 ? 4 : 3;

// Unfilter into a flat RGB(A) raster.
const raw = inflateSync(Buffer.concat(idat));
const stride = W * CH;
const px = Buffer.alloc(H * stride);
let rp = 0;
for (let y = 0; y < H; y++) {
  const filter = raw[rp++];
  const row = raw.subarray(rp, rp + stride);
  rp += stride;
  const out = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= CH ? out[x - CH] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= CH ? prev[x - CH] : 0;
    let v = row[x];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[x] = v & 0xff;
  }
}

// Content bounding box against the corner colour.
const bg = px.subarray(0, CH);
const same = (o) => {
  for (let i = 0; i < CH; i++) if (px[o + i] !== bg[i]) return false;
  return true;
};
let top = H, left = W, right = -1, bottom = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (same(y * stride + x * CH)) continue;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    if (x < left) left = x;
    if (x > right) right = x;
  }
}
if (bottom < 0) throw new Error("image is uniform — nothing to trim");

const x0 = Math.max(0, left - margin);
const y0 = Math.max(0, top - margin);
const x1 = Math.min(W - 1, right + margin);
const y1 = Math.min(H - 1, bottom + margin);
const nw = x1 - x0 + 1;
const nh = y1 - y0 + 1;

// Re-encode, filter 0 per scanline.
const outRaw = Buffer.alloc(nh * (1 + nw * CH));
for (let y = 0; y < nh; y++) {
  const o = y * (1 + nw * CH);
  outRaw[o] = 0;
  px.copy(outRaw, o + 1, (y0 + y) * stride + x0 * CH, (y0 + y) * stride + (x0 + nw) * CH);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const nihdr = Buffer.alloc(13);
nihdr.writeUInt32BE(nw, 0);
nihdr.writeUInt32BE(nh, 4);
nihdr[8] = 8;
nihdr[9] = colorType;

writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", nihdr),
  chunk("IDAT", deflateSync(outRaw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));

process.stdout.write(`${W}x${H} -> ${nw}x${nh}\n`);
