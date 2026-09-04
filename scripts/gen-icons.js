#!/usr/bin/env node
'use strict';

/**
 * Dependency-free app-icon generator for Bubbly Desktop.
 *
 * Renders the Bubbly bubble mark (2x2 grid of 4 orange bubbles on a dark rounded square) and writes:
 *   - desktop/assets/icon.png  (256x256 PNG — window/taskbar icon, Linux)
 *   - desktop/assets/icon.ico  (MULTI-RESOLUTION ICO used by electron-builder)
 *
 * WHY MULTI-RESOLUTION MATTERS
 * ---------------------------
 * Windows asks for specific icon sizes in different places: 16px in Explorer's
 * details view, 32px for desktop shortcuts, 48px in the taskbar/Alt-Tab, 256px
 * for large tiles. An ICO containing ONLY a 256px PNG entry (what this script
 * used to emit) leaves the shell with nothing to draw at small sizes, so it
 * falls back to the generic blank/rectangle icon — which is exactly the bug
 * this replaces. We now emit 16/24/32/48/64/128/256, with the small sizes as
 * uncompressed BMP/DIB entries (maximum shell compatibility) and 256 as a PNG
 * entry (standard, keeps the file small).
 *
 * Each size is rendered at 4x and box-downsampled so small icons stay crisp
 * rather than aliased, and the finest highlight is dropped below 32px where it
 * would just turn into mud.
 *
 * Uses only Node built-ins (zlib for PNG compression), so it runs anywhere
 * without installing native image libraries.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Sizes embedded in the .ico, smallest first. */
const TARGET_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Supersample factor — render this many times larger, then box-downsample. */
const SS = 4;
const OUT_DIR = path.resolve(__dirname, '..', 'desktop', 'assets');

// ---- simple software rasterizer -------------------------------------------

function makeCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4, 0) };
}

function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  // alpha-over compositing onto existing pixel
  const sa = a / 255;
  const da = c.data[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) return;
  for (let k = 0; k < 3; k++) {
    const sc = [r, g, b][k];
    const dc = c.data[i + k];
    c.data[i + k] = Math.round((sc * sa + dc * da * (1 - sa)) / outA);
  }
  c.data[i + 3] = Math.round(outA * 255);
}

function roundedRect(c, color, radius) {
  const [r, g, b, a] = color;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      // distance into corners for rounding
      const dx = Math.min(x, c.w - 1 - x);
      const dy = Math.min(y, c.h - 1 - y);
      if (dx < radius && dy < radius) {
        const cx = radius - dx;
        const cy = radius - dy;
        if (cx * cx + cy * cy > radius * radius) continue;
      }
      setPx(c, x, y, r, g, b, a);
    }
  }
}

function filledCircle(c, cx, cy, rad, colorFn) {
  const minX = Math.floor(cx - rad);
  const maxX = Math.ceil(cx + rad);
  const minY = Math.floor(cy - rad);
  const maxY = Math.ceil(cy + rad);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= rad) {
        // soft 1px edge for anti-aliasing
        const edge = Math.min(1, rad - d);
        const [r, g, b, a] = colorFn(x, y);
        setPx(c, x, y, r, g, b, Math.round(a * edge));
      }
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Draw the mark into a canvas of `px` pixels, scaling from the original 256px
 * design space. `finalSize` is the size this will end up at AFTER downsampling
 * and drives how much fine detail is worth drawing.
 */
function drawIcon(px, finalSize) {
  const c = makeCanvas(px, px);
  const s = px / 256; // design-space -> canvas scale

  // No background - transparent canvas (already initialized with alpha=0)

  // Orange gradient for bubbles: center #ffb366 -> edge #ff7518
  const innerOrange = [0xff, 0xb3, 0x66];
  const outerOrange = [0xff, 0x75, 0x18];

  // 2x2 grid of 4 orange bubbles
  const positions = [
    { cx: 88, cy: 88 },   // top left
    { cx: 168, cy: 88 },  // top right
    { cx: 88, cy: 168 },  // bottom left
    { cx: 168, cy: 168 }, // bottom right
  ];

  const bubbleR = 36 * s;
  const highlightR = 12 * s;

  for (const pos of positions) {
    const bubbleCx = pos.cx * s;
    const bubbleCy = pos.cy * s;
    
    // gradient focus offset toward top-left
    const focusX = bubbleCx - bubbleR * 0.25;
    const focusY = bubbleCy - bubbleR * 0.3;
    
    // Draw bubble with radial gradient
    filledCircle(c, bubbleCx, bubbleCy, bubbleR, (x, y) => {
      const t = Math.min(1, Math.hypot(x - focusX, y - focusY) / (bubbleR * 1.1));
      return [
        Math.round(lerp(innerOrange[0], outerOrange[0], t)),
        Math.round(lerp(innerOrange[1], outerOrange[1], t)),
        Math.round(lerp(innerOrange[2], outerOrange[2], t)),
        255,
      ];
    });

    // White highlight (only at larger sizes for clarity)
    if (finalSize >= 24) {
      const highlightCx = bubbleCx - bubbleR * 0.3;
      const highlightCy = bubbleCy - bubbleR * 0.3;
      filledCircle(c, highlightCx, highlightCy, highlightR, () => [255, 255, 255, 102]);
    }
  }

  return c;
}

/** Box-downsample by an integer factor, averaging in premultiplied alpha. */
function downsample(src, factor) {
  const w = Math.round(src.w / factor);
  const h = Math.round(src.h / factor);
  const out = makeCanvas(w, h);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.w + (x * factor + dx)) * 4;
          const a = src.data[i + 3] / 255;
          // premultiply so edge pixels don't bleed dark halos
          ar += src.data[i] * a;
          ag += src.data[i + 1] * a;
          ab += src.data[i + 2] * a;
          aa += a;
        }
      }
      const o = (y * w + x) * 4;
      if (aa === 0) { out.data[o] = out.data[o + 1] = out.data[o + 2] = out.data[o + 3] = 0; continue; }
      out.data[o] = Math.round(ar / aa);
      out.data[o + 1] = Math.round(ag / aa);
      out.data[o + 2] = Math.round(ab / aa);
      out.data[o + 3] = Math.round((aa / n) * 255);
    }
  }
  return out;
}

/** Render one crisp icon at the requested final size. */
function renderIcon(size) {
  return downsample(drawIcon(size * SS, size), SS);
}

// ---- PNG encoder ----------------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(canvas) {
  const { w, h, data } = canvas;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0;
    data.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO encoding ----------------------------------------------------------

/**
 * Encode a canvas as a BMP/DIB icon image: BITMAPINFOHEADER with doubled height
 * (XOR colour rows + AND mask rows), 32bpp BGRA, stored bottom-up. This is the
 * format the Windows shell handles most reliably at small sizes.
 */
function encodeBMP(canvas) {
  const { w, h, data } = canvas;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);      // biSize
  header.writeInt32LE(w, 4);        // biWidth
  header.writeInt32LE(h * 2, 8);    // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12);      // biPlanes
  header.writeUInt16LE(32, 14);     // biBitCount
  header.writeUInt32LE(0, 16);      // biCompression = BI_RGB

  // XOR (colour) data, bottom-up, BGRA.
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // flip vertically
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      const d = (y * w + x) * 4;
      xor[d] = data[s + 2];     // B
      xor[d + 1] = data[s + 1]; // G
      xor[d + 2] = data[s];     // R
      xor[d + 3] = data[s + 3]; // A
    }
  }

  // AND mask: 1bpp, each row padded to a 4-byte boundary. With a real alpha
  // channel the mask is all zeros (fully opaque), but it must still be present
  // and correctly sized or the shell rejects the entry.
  const maskRowBytes = Math.ceil(w / 8 / 4) * 4;
  const mask = Buffer.alloc(maskRowBytes * h, 0);

  header.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage

  return Buffer.concat([header, xor, mask]);
}

/** Build a multi-resolution .ico from [{ size, data, png }] images. */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);  // image count

  const dirSize = 16 * images.length;
  let offset = 6 + dirSize;

  const entries = [];
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry[0] = img.size >= 256 ? 0 : img.size; // width (0 == 256)
    entry[1] = img.size >= 256 ? 0 : img.size; // height
    entry[2] = 0;                              // palette colours
    entry[3] = 0;                              // reserved
    entry.writeUInt16LE(1, 4);                 // colour planes
    entry.writeUInt16LE(32, 6);                // bits per pixel
    entry.writeUInt32LE(img.data.length, 8);   // data size
    entry.writeUInt32LE(offset, 12);           // data offset
    entries.push(entry);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ---- main ------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

const images = TARGET_SIZES.map((size) => {
  const canvas = renderIcon(size);
  // 256 goes in PNG-compressed (standard, much smaller); everything below is a
  // raw DIB so the Windows shell always has a bitmap it can draw.
  const data = size >= 256 ? encodePNG(canvas) : encodeBMP(canvas);
  return { size, data, canvas };
});

const png256 = encodePNG(images[images.length - 1].canvas);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256);

const ico = encodeICO(images);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

console.log(
  `✓ icon.png (${png256.length} bytes)\n` +
  `✓ icon.ico (${ico.length} bytes) with ${images.length} sizes: ${TARGET_SIZES.join(', ')}`
);
