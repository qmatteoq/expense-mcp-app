/**
 * Generates the two PNG icons the M365 app package requires:
 *   color.png   192x192, full-colour
 *   outline.png 32x32, single-colour with transparency
 *
 * Written with zero dependencies: PNGs are emitted by hand (raw RGBA scanlines,
 * zlib-deflated with node:zlib, CRC32 per chunk). Replace these placeholders
 * with real artwork before submitting to the Microsoft 365 App Store.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "cowork-plugin");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {(x:number,y:number)=>[number,number,number,number]} pixel */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A receipt glyph: a rounded card with three text lines and a total rule.
function receiptMask(x, y, size) {
  const u = x / size;
  const v = y / size;
  const inCard = u > 0.26 && u < 0.74 && v > 0.16 && v < 0.84;
  if (!inCard) return false;
  const border = u < 0.3 || u > 0.7 || v < 0.2 || v > 0.8;
  if (border) return true;
  const lines = [0.34, 0.46, 0.58];
  for (const ly of lines) {
    if (Math.abs(v - ly) < 0.035 && u > 0.36 && u < 0.64) return true;
  }
  return Math.abs(v - 0.71) < 0.035 && u > 0.36 && u < 0.55;
}

const ACCENT = [0x2b, 0x57, 0x9a];

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(
  join(OUT_DIR, "color.png"),
  png(192, (x, y) =>
    receiptMask(x, y, 192) ? [255, 255, 255, 255] : [...ACCENT, 255]
  )
);

writeFileSync(
  join(OUT_DIR, "outline.png"),
  png(32, (x, y) => (receiptMask(x, y, 32) ? [255, 255, 255, 255] : [0, 0, 0, 0]))
);

console.log("Wrote color.png (192x192) and outline.png (32x32) ->", OUT_DIR);
