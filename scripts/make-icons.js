// Generates icons/icon-192.png and icons/icon-512.png (no dependencies).
// Design: violet gradient tile with a 4x4 grid of OMR bubbles (some filled).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const cell = size / 4;
  const filled = new Set(['0,1', '1,0', '1,2', '2,3', '3,1']);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // background gradient #7c5cff -> #3b82f6
      const t = (x + y) / (2 * size);
      let r = 124 + (59 - 124) * t, g = 92 + (130 - 92) * t, b = 255 + (246 - 255) * t;
      // rounded tile corners: transparent outside radius
      const rad = size * 0.22;
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      let a = 255;
      if (cx < rad && cy < rad && Math.hypot(rad - cx, rad - cy) > rad) a = 0;
      // bubbles
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      const dx = x - (gx + 0.5) * cell, dy = y - (gy + 0.5) * cell;
      const d = Math.hypot(dx, dy), R = cell * 0.36;
      if (gx >= 0 && gx < 4 && gy >= 0 && gy < 4 && d < R + 1 && a) {
        const isFill = filled.has(gy + ',' + gx);
        if (isFill) { r = 255; g = 255; b = 255; }
        else { r = 20; g = 26; b = 48; }
        const edge = Math.max(0, Math.min(1, R + 1 - d));
        if (!isFill && d > R - size * 0.02) { r = 255; g = 255; b = 255; }
        a = Math.round(255 * edge);
      }
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), png(s));
console.log('icons written');
