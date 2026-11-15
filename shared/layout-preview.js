/**
 * A small picture of a layout.
 *
 * Reading "Dual Stick · twin-stick shooter" tells you far less than seeing
 * two sticks and two buttons, so the lobby draws every layout before you
 * choose it.
 *
 * The drawing comes straight from the layout data and controlBox(), which is
 * also what the controller and the geometry check use - so the preview cannot
 * quietly disagree with what the phone will show.
 */

import { BUTTON_LABELS, controlBox } from './protocol.js';

/** Same proportions as a phone held sideways. */
const VIEW_W = 200;
const VIEW_H = 100;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * @param {object} layout            a layout with `controls`
 * @param {object} [opts]
 * @param {string} [opts.color]      colour for every element, so the active
 *        layout stands out as a whole rather than only where a stick happens
 *        to be (a racing layout has none)
 * @param {boolean} [opts.labels]    draw button letters (off in small previews)
 * @returns {string} an inline SVG
 */
export function layoutPreviewSvg(layout, { color = '#3d8bfd', labels = false } = {}) {
  const controls = Array.isArray(layout?.controls) ? layout.controls : [];
  const parts = [];

  for (const c of controls) {
    const box = controlBox(c);
    if (!box) continue;

    // x is a percentage of the width, size a percentage of the HEIGHT.
    const cx = (c.x / 100) * VIEW_W;
    const cy = (c.y / 100) * VIEW_H;
    const w = (box.w / 100) * VIEW_H;
    const h = (box.h / 100) * VIEW_H;

    if (c.kind === 'stick') {
      // Ring plus knob, so a stick reads differently from a button.
      parts.push(
        `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(w / 2)}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="1.5"/>`,
        `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(w / 4.5)}" fill="${color}" fill-opacity="0.55"/>`,
      );
    } else if (c.kind === 'dpad') {
      const arm = w * 0.34;
      const long = w * 0.98;
      parts.push(
        `<rect x="${r(cx - arm / 2)}" y="${r(cy - long / 2)}" width="${r(arm)}" height="${r(long)}" rx="${r(arm * 0.25)}" fill="${color}" fill-opacity="0.45"/>`,
        `<rect x="${r(cx - long / 2)}" y="${r(cy - arm / 2)}" width="${r(long)}" height="${r(arm)}" rx="${r(arm * 0.25)}" fill="${color}" fill-opacity="0.45"/>`,
      );
    } else if (box.round) {
      parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(w / 2)}" fill="${color}" fill-opacity="0.4"/>`);
      if (labels) {
        const text = c.label || BUTTON_LABELS[c.id] || '';
        if (text.length <= 2) {
          parts.push(
            `<text x="${r(cx)}" y="${r(cy + w * 0.17)}" text-anchor="middle" font-size="${r(w * 0.5)}" fill="#0b0d11" font-family="system-ui, sans-serif" font-weight="700">${escape(text)}</text>`,
          );
        }
      }
    } else {
      // Shoulder buttons, triggers, steering slider.
      parts.push(
        `<rect x="${r(cx - w / 2)}" y="${r(cy - h / 2)}" width="${r(w)}" height="${r(h)}" rx="${r(Math.min(w, h) * 0.3)}" fill="${color}" fill-opacity="0.35"/>`,
      );
    }
  }

  return `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" xmlns="http://www.w3.org/2000/svg" `
    + `role="img" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

/** Two decimals are plenty and keep the markup short. */
function r(n) {
  return Math.round(n * 100) / 100;
}
