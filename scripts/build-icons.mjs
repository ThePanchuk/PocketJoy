/**
 * Turn the icon SVG into the binary formats Windows and browsers want.
 *
 *   npm run build:icons
 *
 * Writes web/icons/: pocketjoy.ico (used for PocketJoy.exe and as favicon)
 * plus a few PNGs for the web pages.
 *
 * Why rasterize here instead of checking in files from a drawing program:
 * the SVG stays the only place the icon is defined. Change web/icon.svg, run
 * this, and everything else follows. Nothing has to be redrawn twice and the
 * .ico cannot quietly drift away from the .svg.
 *
 * The renderer below understands exactly what the two icon files use -
 * rounded rectangles, circles, a vertical gradient, one stroke. It is not an
 * SVG renderer and should not grow into one: if the icon ever needs paths or
 * text, render it in a browser instead and check the result in.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'web', 'icons');

// --------------------------------------------------------------- reading SVG

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function parseColor(value) {
  const hex = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return [0, 1, 2].map((i) => parseInt(hex[i + 1] + hex[i + 1], 16));
  }
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  throw new Error(`Farbe nicht verstanden: ${value}`);
}

/** Vertical two-stop gradients, which is all the icon uses. */
function parseGradients(svg) {
  const gradients = {};
  for (const m of svg.matchAll(/<linearGradient\s([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
    const { id } = parseAttrs(m[1]);
    const stops = [...m[2].matchAll(/<stop\s([^/>]*)\/?>/g)].map((s) => {
      const a = parseAttrs(s[1]);
      return { offset: parseFloat(a.offset), color: parseColor(a['stop-color']) };
    });
    if (stops.length >= 2) gradients[id] = stops;
  }
  return gradients;
}

/**
 * The shapes, in painting order, with <g> attributes inherited.
 */
function parseShapes(svg) {
  const shapes = [];
  const inherited = [{}];
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');

  for (const m of body.matchAll(/<(\/?)(g|rect|circle)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrText] = m;
    if (tag === 'g') {
      if (closing) inherited.pop();
      else inherited.push({ ...inherited.at(-1), ...parseAttrs(attrText) });
      continue;
    }
    const a = { ...inherited.at(-1), ...parseAttrs(attrText) };
    const num = (key, fallback = 0) => (a[key] === undefined ? fallback : parseFloat(a[key]));
    if (tag === 'rect') {
      shapes.push({
        type: 'rect',
        x: num('x'), y: num('y'), w: num('width'), h: num('height'),
        r: num('rx', 0),
        fill: a.fill, stroke: a.stroke, strokeWidth: num('stroke-width', 1),
      });
    } else {
      shapes.push({
        type: 'circle',
        cx: num('cx'), cy: num('cy'), rad: num('r'),
        fill: a.fill, stroke: a.stroke, strokeWidth: num('stroke-width', 1),
      });
    }
  }
  return shapes;
}

function viewBoxSize(svg) {
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!m) throw new Error('viewBox fehlt oder faengt nicht bei 0 0 an');
  if (m[1] !== m[2]) throw new Error('Das Icon muss quadratisch sein');
  return parseFloat(m[1]);
}

// ----------------------------------------------------------------- rasterizer

/** Rounded rectangle, the usual distance-to-core test. */
function inRoundRect(px, py, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return false;
  const radius = Math.min(r, w / 2, h / 2);
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const dx = Math.max(x + radius - px, 0, px - (x + w - radius));
  const dy = Math.max(y + radius - py, 0, py - (y + h - radius));
  return dx * dx + dy * dy <= radius * radius;
}

const inCircle = (px, py, cx, cy, rad) =>
  (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad;

/**
 * One drawing operation: a shape's fill, or a shape's stroke.
 * `covers` answers "is this sample point painted", `colorAt` what colour.
 */
function operations(shapes, gradients) {
  const ops = [];

  const colorFn = (value, box) => {
    const url = /^url\(#([^)]+)\)$/.exec(value || '');
    if (!url) {
      const rgb = parseColor(value);
      return () => rgb;
    }
    const stops = gradients[url[1]];
    if (!stops) throw new Error(`Gradient ${url[1]} fehlt`);
    const [from, to] = [stops[0].color, stops.at(-1).color];
    // The icon's gradient runs top to bottom across the element's own box.
    return (_px, py) => {
      const t = Math.min(1, Math.max(0, (py - box.y) / box.h));
      return [0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * t);
    };
  };

  for (const s of shapes) {
    const box = s.type === 'rect'
      ? { y: s.y, h: s.h }
      : { y: s.cy - s.rad, h: s.rad * 2 };

    if (s.fill && s.fill !== 'none') {
      const colorAt = colorFn(s.fill, box);
      const covers = s.type === 'rect'
        ? (px, py) => inRoundRect(px, py, s.x, s.y, s.w, s.h, s.r)
        : (px, py) => inCircle(px, py, s.cx, s.cy, s.rad);
      ops.push({ covers, colorAt });
    }

    if (s.stroke && s.stroke !== 'none') {
      const colorAt = colorFn(s.stroke, box);
      const hw = s.strokeWidth / 2;
      const covers = s.type === 'rect'
        ? (px, py) =>
          inRoundRect(px, py, s.x - hw, s.y - hw, s.w + 2 * hw, s.h + 2 * hw, s.r + hw) &&
          !inRoundRect(px, py, s.x + hw, s.y + hw, s.w - 2 * hw, s.h - 2 * hw, Math.max(s.r - hw, 0))
        : (px, py) =>
          inCircle(px, py, s.cx, s.cy, s.rad + hw) && !inCircle(px, py, s.cx, s.cy, s.rad - hw);
      ops.push({ covers, colorAt });
    }
  }
  return ops;
}

/**
 * Render to straight-alpha RGBA. Anti-aliasing by sampling each pixel in a
 * grid - slow and simple, which at these sizes costs nothing.
 */
function render(ops, viewBox, size, samples = 4) {
  const scale = viewBox / size;
  // Premultiplied while compositing, so partially covered edges blend right.
  const buf = new Float64Array(size * size * 4);

  for (const op of ops) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        let hits = 0;
        for (let sy = 0; sy < samples; sy++) {
          const py = (j + (sy + 0.5) / samples) * scale;
          for (let sx = 0; sx < samples; sx++) {
            const px = (i + (sx + 0.5) / samples) * scale;
            if (op.covers(px, py)) hits++;
          }
        }
        if (!hits) continue;

        const a = hits / (samples * samples);
        const [r, g, b] = op.colorAt((i + 0.5) * scale, (j + 0.5) * scale);
        const o = (j * size + i) * 4;
        buf[o] = r * a + buf[o] * (1 - a);
        buf[o + 1] = g * a + buf[o + 1] * (1 - a);
        buf[o + 2] = b * a + buf[o + 2] * (1 - a);
        buf[o + 3] = a + buf[o + 3] * (1 - a);
      }
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const a = buf[p * 4 + 3];
    for (let c = 0; c < 3; c++) {
      out[p * 4 + c] = a > 0 ? Math.round(Math.min(255, buf[p * 4 + c] / a)) : 0;
    }
    out[p * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

// ----------------------------------------------------------------- PNG / ICO

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
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour with alpha
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // Scanlines, each with a filter byte. Filter 0 (none) keeps this readable;
  // the images are tiny, so the few bytes saved are not worth the code.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) {
    rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico is a small directory of images; PNG entries are fine since Vista. */
function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);                 // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    dir[at] = size >= 256 ? 0 : size;         // 0 means 256
    dir[at + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, at + 4);             // colour planes
    dir.writeUInt16LE(32, at + 6);            // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ----------------------------------------------------------------------- main

function load(name) {
  const file = path.join(ROOT, 'web', name);
  const svg = fs.readFileSync(file, 'utf8');
  const gradients = parseGradients(svg);
  return { ops: operations(parseShapes(svg), gradients), viewBox: viewBoxSize(svg) };
}

const detailed = load('icon.svg');        // the full drawing
const simple = load('icon-small.svg');   // chunkier, for 16 and 24 px

/** Below this many pixels the simplified drawing reads better. */
const SIMPLE_UP_TO = 24;

const draw = (size) => {
  const source = size <= SIMPLE_UP_TO ? simple : detailed;
  return render(source.ops, source.viewBox, size);
};

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('\nIcons bauen\n');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = toIco(ICO_SIZES.map((size) => {
  process.stdout.write(`  ${size}px`.padEnd(10));
  const png = toPng(draw(size), size);
  console.log(`${String(png.length).padStart(7)} Bytes`);
  return { size, png };
}));

fs.writeFileSync(path.join(OUT_DIR, 'pocketjoy.ico'), ico);
console.log(`\n  pocketjoy.ico   ${ico.length} Bytes (${ICO_SIZES.join(', ')} px)`);

// Separate PNGs for the web pages: browsers prefer these over the .ico, and
// 180 px is what iOS wants for a bookmark on the home screen.
for (const size of [32, 180, 512]) {
  const png = toPng(draw(size), size);
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png);
  console.log(`  icon-${size}.png${' '.repeat(Math.max(1, 8 - String(size).length))}${png.length} Bytes`);
}

console.log(`
  Fertig. Quelle ist web/icon.svg (und web/icon-small.svg fuer 16-24 px).
  Nach einer Aenderung am SVG hier nochmal laufen lassen, danach
  "npm run build:exe", damit die exe das neue Icon bekommt.
`);
