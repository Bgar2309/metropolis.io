// Sprite-atlas packer for Metropolis.io.
//
// Reads every PNG in packages/client/assets/sprites/ and packs them into a single texture
// at packages/client/public/atlas.png, alongside an atlas.json describing each frame's
// rect: { frames: { "<name>": { x, y, w, h } }, meta: {...} }.
//
// Design note: ZERO heavy dependencies. PNG decode/encode is done here with only Node's
// built-in zlib (inflate/deflate) plus fs. This keeps `pnpm build:atlas` installable and
// runnable offline, and — per the build contract — it must NOT crash on an empty sprites
// folder: in that case it emits a clean warning and writes a valid empty atlas.
//
// Supported input PNGs: 8-bit grayscale / grayscale+alpha / truecolor / truecolor+alpha,
// and indexed (palette, 1/2/4/8-bit) with optional tRNS. Interlaced PNGs are rejected with
// a clear message (re-export non-interlaced). Output is always 8-bit RGBA, non-interlaced.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SPRITES_DIR = join(ROOT, "packages/client/assets/sprites");
const OUT_DIR = join(ROOT, "packages/client/public");
const OUT_PNG = join(OUT_DIR, "atlas.png");
const OUT_JSON = join(OUT_DIR, "atlas.json");

const PADDING = 1; // transparent gutter between frames to avoid bleeding when sampled

// --- decoded-image shape -------------------------------------------------------------
interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array; // width*height*4, straight (non-premultiplied) alpha
}

interface Frame extends Decoded {
  name: string;
}

// =====================================================================================
// PNG decoding
// =====================================================================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buf: Buffer, label: string): Decoded {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`${label}: not a PNG (bad signature)`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Uint8Array | null = null; // RGB triplets
  let trns: Uint8Array | null = null; // palette alpha (color type 3) or key (0/2)

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len; // length(4) + type(4) + data(len) + crc(4)

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") {
      palette = new Uint8Array(data);
    } else if (type === "tRNS") {
      trns = new Uint8Array(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error(`${label}: bad dimensions`);
  if (interlace !== 0) throw new Error(`${label}: interlaced PNG unsupported — re-export non-interlaced`);
  if (bitDepth > 8 && bitDepth !== 16) throw new Error(`${label}: unsupported bit depth ${bitDepth}`);

  const raw = inflateSync(Buffer.concat(idat));

  // channels per pixel in the raw stream, by color type
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`${label}: unsupported color type ${colorType}`);

  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8);

  // --- unfilter scanlines (PNG filter types 0..4) ---
  const unfiltered = new Uint8Array(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[pos++]!;
      const a = x >= bytesPerPixel ? unfiltered[rowStart + x - bytesPerPixel]! : 0;
      const b = y > 0 ? unfiltered[rowStart - rowBytes + x]! : 0;
      const c = y > 0 && x >= bytesPerPixel ? unfiltered[rowStart - rowBytes + x - bytesPerPixel]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paeth(a, b, c); break;
        default: throw new Error(`${label}: bad filter type ${filter}`);
      }
      unfiltered[rowStart + x] = v & 0xff;
    }
  }

  // --- expand to RGBA ---
  const rgba = new Uint8Array(width * height * 4);
  const sample = makeSampler(unfiltered, rowBytes, bitDepth);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(y, x * channels);
        const p = idx * 3;
        rgba[o] = palette ? palette[p]! : 0;
        rgba[o + 1] = palette ? palette[p + 1]! : 0;
        rgba[o + 2] = palette ? palette[p + 2]! : 0;
        rgba[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = scale(sample(y, x * channels), bitDepth);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? scale(sample(y, x * channels + 1), bitDepth) : 255;
      } else {
        // truecolor (2) or truecolor+alpha (6)
        rgba[o] = scale(sample(y, x * channels), bitDepth);
        rgba[o + 1] = scale(sample(y, x * channels + 1), bitDepth);
        rgba[o + 2] = scale(sample(y, x * channels + 2), bitDepth);
        rgba[o + 3] = colorType === 6 ? scale(sample(y, x * channels + 3), bitDepth) : 255;
      }
    }
  }

  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Scale an N-bit sample up to 8 bits (no-op for 8-bit, expand for 16/sub-byte handled by sampler).
function scale(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v & 0xff;
  if (bitDepth === 16) return (v >> 8) & 0xff;
  // sub-byte depths: replicate bits to fill 0..255
  const max = (1 << bitDepth) - 1;
  return Math.round((v / max) * 255);
}

// Returns a function (row, sampleIndex) -> raw integer sample, handling sub-byte and 16-bit.
function makeSampler(data: Uint8Array, rowBytes: number, bitDepth: number): (row: number, i: number) => number {
  if (bitDepth === 8) {
    return (row, i) => data[row * rowBytes + i]!;
  }
  if (bitDepth === 16) {
    return (row, i) => (data[row * rowBytes + i * 2]! << 8) | data[row * rowBytes + i * 2 + 1]!;
  }
  // 1/2/4-bit packed samples, MSB first
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  return (row, i) => {
    const byte = data[row * rowBytes + Math.floor(i / perByte)]!;
    const shift = (perByte - 1 - (i % perByte)) * bitDepth;
    return (byte >> shift) & mask;
  };
}

// =====================================================================================
// PNG encoding (8-bit RGBA, filter 0, single IDAT)
// =====================================================================================

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const rowBytes = width * 4;
  const rawWithFilter = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    rawWithFilter[y * (rowBytes + 1)] = 0; // filter: none
    rawWithFilter.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const compressed = deflateSync(Buffer.from(rawWithFilter), { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([len, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// =====================================================================================
// Packing — shelf/row packer (sort by height desc, fill rows in a fixed-width sheet)
// =====================================================================================

interface Placed {
  frame: Frame;
  x: number;
  y: number;
}

function packShelves(frames: Frame[]): { width: number; height: number; placed: Placed[] } {
  const sorted = [...frames].sort((a, b) => b.height - a.height || b.width - a.width);

  // Sheet width: at least the widest frame, otherwise grow toward a roughly square sheet.
  const totalArea = frames.reduce((s, f) => s + (f.width + PADDING) * (f.height + PADDING), 0);
  const widest = Math.max(...frames.map((f) => f.width + PADDING));
  const sheetWidth = Math.max(widest, Math.ceil(Math.sqrt(totalArea)));

  const placed: Placed[] = [];
  let x = PADDING;
  let y = PADDING;
  let rowHeight = 0;
  let usedWidth = 0;

  for (const frame of sorted) {
    if (x + frame.width + PADDING > sheetWidth && x > PADDING) {
      // wrap to next shelf
      x = PADDING;
      y += rowHeight + PADDING;
      rowHeight = 0;
    }
    placed.push({ frame, x, y });
    x += frame.width + PADDING;
    usedWidth = Math.max(usedWidth, x);
    rowHeight = Math.max(rowHeight, frame.height);
  }

  const width = Math.max(1, usedWidth);
  const height = Math.max(1, y + rowHeight + PADDING);
  return { width, height, placed };
}

function composite(width: number, height: number, placed: Placed[]): Uint8Array {
  const sheet = new Uint8Array(width * height * 4); // all-zero = fully transparent
  for (const { frame, x, y } of placed) {
    for (let row = 0; row < frame.height; row++) {
      const src = row * frame.width * 4;
      const dst = ((y + row) * width + x) * 4;
      sheet.set(frame.rgba.subarray(src, src + frame.width * 4), dst);
    }
  }
  return sheet;
}

// =====================================================================================
// Main
// =====================================================================================

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  if (!existsSync(SPRITES_DIR)) {
    console.warn(`[build-atlas] sprites dir not found: ${SPRITES_DIR}`);
    console.warn("[build-atlas] writing empty atlas. Add PNGs to that folder and re-run.");
    writeEmpty();
    return;
  }

  const files = readdirSync(SPRITES_DIR).filter((f) => f.toLowerCase().endsWith(".png")).sort();

  if (files.length === 0) {
    console.warn(`[build-atlas] no PNGs in ${SPRITES_DIR} — writing empty atlas (this is fine).`);
    writeEmpty();
    return;
  }

  const frames: Frame[] = [];
  for (const file of files) {
    const name = basename(file, ".png");
    try {
      const decoded = decodePng(readFileSync(join(SPRITES_DIR, file)), file);
      frames.push({ name, ...decoded });
    } catch (err) {
      console.error(`[build-atlas] SKIPPED ${file}: ${(err as Error).message}`);
    }
  }

  if (frames.length === 0) {
    console.warn("[build-atlas] no decodable sprites — writing empty atlas.");
    writeEmpty();
    return;
  }

  const { width, height, placed } = packShelves(frames);
  const sheet = composite(width, height, placed);

  const frameMap: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const { frame, x, y } of placed) {
    frameMap[frame.name] = { x, y, w: frame.width, h: frame.height };
  }

  writeFileSync(OUT_PNG, encodePng(width, height, sheet));
  writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        frames: frameMap,
        meta: { app: "metropolis.io build-atlas", size: { w: width, h: height }, count: frames.length, tile: { w: 32, h: 16 } },
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`[build-atlas] packed ${frames.length} sprite(s) into ${width}x${height} -> atlas.png + atlas.json`);
}

function writeEmpty(): void {
  // 1x1 transparent PNG + empty frame map, so consumers always find valid files.
  writeFileSync(OUT_PNG, encodePng(1, 1, new Uint8Array(4)));
  writeFileSync(
    OUT_JSON,
    JSON.stringify(
      { frames: {}, meta: { app: "metropolis.io build-atlas", size: { w: 1, h: 1 }, count: 0, tile: { w: 32, h: 16 } } },
      null,
      2,
    ) + "\n",
  );
}

main();
