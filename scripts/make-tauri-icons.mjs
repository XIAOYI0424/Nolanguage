/**
 * Generate the Tauri bundle icons.
 *
 * `tauri build` refuses to run without them, and this repository deliberately
 * keeps no binary assets in git — so the icons are generated from code instead
 * of committed. A dark panel with an accent diagonal: the workspace's own
 * palette, at the sizes the bundler asks for.
 *
 * Run: node scripts/make-tauri-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons');

const BG = [0x1e, 0x1f, 0x24];   // --bg-secondary (darcula panel)
const ACCENT = [0x4a, 0x9e, 0xda]; // --accent

/** zlib CRC-32, as PNG chunks require. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A `size`×`size` RGBA bitmap: dark field, accent diagonal band. */
function pixels(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inBand = Math.abs(x - y) < Math.max(1, size / 12) && x < size * 0.82 && y < size * 0.82;
      const c = inBand ? ACCENT : BG;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }
  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    out.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return raw;
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels(size))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico wrapping the PNG payloads (Vista+ reads PNG-in-ICO). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [];
  const payloads = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;   // palette colours
    e[3] = 0;   // reserved
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    payloads.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

/** An .icns wrapping PNG payloads (the modern icns types are PNG-compressed). */
function icns(images) {
  const body = Buffer.concat(images.map(({ type, data }) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length + 8);
    return Buffer.concat([Buffer.from(type, 'ascii'), len, data]);
  }));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const sizes = [32, 128, 256, 512];
await mkdir(outDir, { recursive: true });
for (const s of sizes) {
  await writeFile(join(outDir, `${s}x${s}.png`), png(s));
}
// macOS wants a @2x variant alongside 128x128; Windows' .ico wants small sizes.
await writeFile(join(outDir, '128x128@2x.png'), png(256));
await writeFile(join(outDir, 'icon.ico'), ico([
  { size: 16, data: png(16) },
  { size: 32, data: png(32) },
  { size: 48, data: png(48) },
]));
// icns types: icp4=16, icp5=32, ic07=128, ic08=256, ic09=512 — all PNG payloads.
await writeFile(join(outDir, 'icon.icns'), icns([
  { type: 'icp4', data: png(16) },
  { type: 'icp5', data: png(32) },
  { type: 'ic07', data: png(128) },
  { type: 'ic08', data: png(256) },
  { type: 'ic09', data: png(512) },
]));
console.log(`make-tauri-icons: wrote ${sizes.length} PNGs + 128x128@2x.png + icon.ico + icon.icns to src-tauri/icons/`);
