/**
 * Layout geometry check.
 *
 * Every control is placed in percent of the pad area, and its size is a
 * percentage of the HEIGHT. On a narrow phone (16:9 is the tightest common
 * one in landscape) wide controls therefore eat a lot of horizontal space and
 * can run off the screen or collide.
 *
 * Sizes come from controlBox() in the protocol, the same source the lobby
 * preview uses.
 *
 *   node scripts/checklayouts.mjs
 */

import { LAYOUTS, controlBox } from '../shared/protocol.js';
import { layoutPreviewSvg } from '../shared/layout-preview.js';

/** Typical phone screens in landscape (width x height in CSS pixels). */
const SCREENS = [
  { name: '16:9  (667x375)', w: 667, h: 375 },
  { name: '18:9  (740x370)', w: 740, h: 370 },
  { name: '19.5:9 (812x375)', w: 812, h: 375 },
  { name: '20:9  (851x383)', w: 851, h: 383 },
];

/** Controls that may touch on purpose (round buttons in a cluster). */
const OVERLAP_TOLERANCE = 2; // px

function boxOf(control, screen) {
  const shape = controlBox(control);
  if (!shape) return null;
  const w = (shape.w / 100) * screen.h;
  const h = (shape.h / 100) * screen.h;
  const cx = (control.x / 100) * screen.w;
  const cy = (control.y / 100) * screen.h;
  return { id: control.id, kind: control.kind, round: shape.round, cx, cy, w, h,
           left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

function overlaps(a, b) {
  // Two circles only collide if their centres are closer than their radii.
  if (a.round && b.round) {
    const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    return dist + OVERLAP_TOLERANCE < (a.w / 2 + b.w / 2);
  }
  return a.left + OVERLAP_TOLERANCE < b.right
      && b.left + OVERLAP_TOLERANCE < a.right
      && a.top + OVERLAP_TOLERANCE < b.bottom
      && b.top + OVERLAP_TOLERANCE < a.bottom;
}

let problems = 0;

console.log('\nLayout-Geometrie\n');

for (const [id, layout] of Object.entries(LAYOUTS)) {
  const issues = [];

  for (const screen of SCREENS) {
    const boxes = layout.controls.map((c) => boxOf(c, screen)).filter(Boolean);

    for (const b of boxes) {
      const over = [];
      if (b.left < -1) over.push(`${Math.round(-b.left)}px links`);
      if (b.right > screen.w + 1) over.push(`${Math.round(b.right - screen.w)}px rechts`);
      if (b.top < -1) over.push(`${Math.round(-b.top)}px oben`);
      if (b.bottom > screen.h + 1) over.push(`${Math.round(b.bottom - screen.h)}px unten`);
      if (over.length) issues.push(`${screen.name}: "${b.id}" ragt heraus (${over.join(', ')})`);
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (overlaps(boxes[i], boxes[j])) {
          issues.push(`${screen.name}: "${boxes[i].id}" und "${boxes[j].id}" ueberlappen`);
        }
      }
    }
  }

  if (issues.length) {
    problems += issues.length;
    console.log(`  FAIL  ${id}`);
    for (const line of issues) console.log(`          ${line}`);
  } else {
    console.log(`  ok    ${id}  (${layout.controls.length} Elemente)`);
  }
}

// --- previews -------------------------------------------------------------
// The lobby draws these before you pick a layout. Same data as the pad, so
// they cannot disagree with it - but an empty or clipped preview would still
// be useless, and that is what this checks.
console.log('');
console.log('Vorschau-Bilder');
console.log('');

const RE_CIRCLE = /<circle cx="([-0-9.]+)" cy="([-0-9.]+)" r="([-0-9.]+)"/g;
const RE_RECT = /<rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/g;

for (const [id, layout] of Object.entries(LAYOUTS)) {
  const svg = layoutPreviewSvg(layout);
  const shapes = (svg.match(/<(circle|rect)/g) || []).length;
  const issues = [];

  if (shapes < layout.controls.length) {
    issues.push(`nur ${shapes} Formen fuer ${layout.controls.length} Elemente`);
  }
  for (const m of svg.matchAll(RE_CIRCLE)) {
    const cx = Number(m[1]); const cy = Number(m[2]); const rad = Number(m[3]);
    if (cx - rad < -0.5 || cx + rad > 200.5 || cy - rad < -0.5 || cy + rad > 100.5) {
      issues.push(`Kreis ragt heraus (${cx}, ${cy}, r=${rad})`);
    }
  }
  for (const m of svg.matchAll(RE_RECT)) {
    const x = Number(m[1]); const y = Number(m[2]);
    const w = Number(m[3]); const h = Number(m[4]);
    if (x < -0.5 || y < -0.5 || x + w > 200.5 || y + h > 100.5) {
      issues.push(`Rechteck ragt heraus (${x}, ${y}, ${w}x${h})`);
    }
  }

  if (issues.length) {
    problems += issues.length;
    console.log(`  FAIL  ${id}`);
    for (const line of issues) console.log(`          ${line}`);
  } else {
    console.log(`  ok    ${id}  (${shapes} Formen)`);
  }
}

console.log(problems ? `\n  ${problems} Problem(e)\n` : '\n  Layouts und Vorschauen in Ordnung.\n');
process.exit(problems ? 1 : 0);
