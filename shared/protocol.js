/**
 * PocketJoy - shared protocol definitions.
 *
 * Loaded by the Node server (import) AND by the browser (<script type="module">),
 * so both sides always agree on button names, axis names and layouts.
 *
 * Everything maps onto a standard Xbox-style gamepad. That is deliberate: the
 * optional system bridge (ViGEmBus on Windows, uinput on Linux) can then map a
 * player 1:1 onto a virtual Xbox 360 pad without any per-layout special cases.
 */

export const PROTOCOL_VERSION = 1;

/** Digital buttons. Order matters: it is the wire order for the bitmask. */
export const BUTTONS = [
  'a', 'b', 'x', 'y',
  'lb', 'rb',
  'back', 'start',
  'ls', 'rs',
  'up', 'down', 'left', 'right',
];

/** Analog axes. Sticks are -1..1, triggers are 0..1. */
export const AXES = ['lx', 'ly', 'rx', 'ry', 'lt', 'rt'];

export const BUTTON_INDEX = Object.fromEntries(BUTTONS.map((b, i) => [b, i]));

/** Human labels, used by the pad UI when a layout gives no explicit label. */
export const BUTTON_LABELS = {
  a: 'A', b: 'B', x: 'X', y: 'Y',
  lb: 'LB', rb: 'RB',
  back: 'Back', start: 'Start',
  ls: 'L', rs: 'R',
  up: '▲', down: '▼', left: '◀', right: '▶',
};

/**
 * Layout presets.
 *
 * The English name/hint here is a fallback; the translations live in i18n.js
 * under `layout.<id>.name`. Fixed labels use `labelKey` for the same reason -
 * a layout a game brings itself carries plain `label` text instead.
 *
 * Coordinates are percentages of the pad area in LANDSCAPE orientation:
 *   x: 0 (left) .. 100 (right)
 *   y: 0 (top)  .. 100 (bottom)
 * `size` is a percentage of the pad area HEIGHT, so controls keep their
 * proportions on any screen. Every control is centred on its (x, y).
 *
 * kinds:
 *   stick   - analog thumbstick. id 'left' -> lx/ly (+ ls on tap), 'right' -> rx/ry (+ rs)
 *   dpad    - 4-way digital pad; also mirrored onto lx/ly so axis-reading games work
 *   button  - digital button, id must be a name from BUTTONS
 *   trigger - shoulder trigger, id 'lt' or 'rt'; analog axis, 1.0 while held
 *   steer   - horizontal slider mapped to lx only (racing wheel)
 */
export const LAYOUTS = {
  'dual-stick': {
    name: 'Dual Stick',
    hint: 'Twin-stick shooter: move left, aim right.',
    controls: [
      { kind: 'stick', id: 'left', x: 20, y: 56, size: 52 },
      { kind: 'stick', id: 'right', x: 80, y: 56, size: 52 },
      { kind: 'button', id: 'b', x: 50, y: 36, size: 21 },
      { kind: 'button', id: 'a', x: 50, y: 70, size: 21 },
      { kind: 'button', id: 'lb', x: 11, y: 9, size: 15, wide: true },
      { kind: 'button', id: 'rb', x: 89, y: 9, size: 15, wide: true },
      { kind: 'button', id: 'start', x: 50, y: 8, size: 12 },
    ],
  },

  'single-stick': {
    name: 'Stick + 2 buttons',
    hint: 'The classic: one stick, two buttons.',
    controls: [
      { kind: 'stick', id: 'left', x: 23, y: 55, size: 58 },
      { kind: 'button', id: 'a', x: 76, y: 64, size: 30 },
      { kind: 'button', id: 'b', x: 92, y: 32, size: 24 },
      { kind: 'button', id: 'start', x: 50, y: 10, size: 13 },
    ],
  },

  platformer: {
    name: 'Jump & Run',
    hint: 'D-pad left, jump right.',
    controls: [
      { kind: 'dpad', id: 'dpad', x: 21, y: 56, size: 58 },
      { kind: 'button', id: 'a', x: 79, y: 66, size: 30, labelKey: 'layout.platformer.jump' },
      { kind: 'button', id: 'b', x: 93, y: 33, size: 25 },
      { kind: 'button', id: 'start', x: 50, y: 10, size: 13 },
    ],
  },

  racing: {
    name: 'Racing',
    hint: 'Steer on the left, pedals on the right.',
    controls: [
      { kind: 'steer', id: 'steer', x: 30, y: 58, size: 46 },
      { kind: 'trigger', id: 'rt', x: 79, y: 34, size: 27, labelKey: 'layout.racing.gas' },
      { kind: 'trigger', id: 'lt', x: 79, y: 74, size: 27, labelKey: 'layout.racing.brake' },
      { kind: 'button', id: 'a', x: 52, y: 18, size: 16 },
      { kind: 'button', id: 'start', x: 30, y: 12, size: 13 },
    ],
  },

  gamepad: {
    name: 'Full gamepad',
    hint: 'Everything an Xbox controller has.',
    controls: [
      // The four shoulder controls must fit side by side even on a 16:9 phone,
      // which is the narrowest common screen relative to its height.
      { kind: 'button', id: 'lb', x: 8.5, y: 5.5, size: 13, wide: true },
      { kind: 'trigger', id: 'lt', x: 25, y: 5.5, size: 13, wide: true },
      { kind: 'trigger', id: 'rt', x: 75, y: 5.5, size: 13, wide: true },
      { kind: 'button', id: 'rb', x: 91.5, y: 5.5, size: 13, wide: true },
      { kind: 'stick', id: 'left', x: 17, y: 70, size: 38 },
      { kind: 'dpad', id: 'dpad', x: 17, y: 28, size: 32 },
      { kind: 'stick', id: 'right', x: 83, y: 70, size: 38 },
      { kind: 'button', id: 'y', x: 83, y: 20, size: 15 },
      { kind: 'button', id: 'x', x: 71.5, y: 30, size: 15 },
      { kind: 'button', id: 'b', x: 94.5, y: 30, size: 15 },
      { kind: 'button', id: 'a', x: 83, y: 40, size: 15 },
      { kind: 'button', id: 'back', x: 43, y: 22, size: 13 },
      { kind: 'button', id: 'start', x: 57, y: 22, size: 13 },
    ],
  },

  buttons: {
    name: '4 buttons',
    hint: 'For party and quiz games.',
    controls: [
      { kind: 'button', id: 'x', x: 27, y: 31, size: 36 },
      { kind: 'button', id: 'y', x: 73, y: 31, size: 36 },
      { kind: 'button', id: 'a', x: 27, y: 76, size: 36 },
      { kind: 'button', id: 'b', x: 73, y: 76, size: 36 },
    ],
  },

  buzzer: {
    name: 'Buzzer',
    hint: 'One big button. Nothing else.',
    controls: [
      { kind: 'button', id: 'a', x: 50, y: 54, size: 80, label: 'BUZZ' },
    ],
  },
};

export const DEFAULT_LAYOUT = 'dual-stick';
export const MAX_PLAYERS = 8;

/** Player colours by slot - shared between pad, lobby and games. */
export const SLOT_COLORS = [
  '#f2544b', '#3d8bfd', '#2fbf71', '#f7b32b',
  '#a259e6', '#19c4c4', '#ff7fbf', '#8c9199',
];

export function emptyState() {
  const buttons = {};
  for (const b of BUTTONS) buttons[b] = false;
  return { buttons, axes: { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 } };
}

export function layoutOrDefault(id) {
  return LAYOUTS[id] ? id : DEFAULT_LAYOUT;
}

export const CONTROL_KINDS = ['stick', 'dpad', 'button', 'trigger', 'steer'];

/**
 * How big a control is, and whether it is round.
 *
 * Width and height are percentages of the pad's HEIGHT, exactly as the pad
 * stylesheet computes them. It lives here because three places need the same
 * answer: the layout check (does anything overlap or run off the screen?),
 * the preview in the lobby, and - as the source of those CSS factors - the
 * controller itself. Three copies would drift apart; a preview that lies
 * about the layout is worse than no preview.
 */
export function controlBox(control) {
  const size = Number(control?.size) || 0;
  switch (control?.kind) {
    case 'stick':
      return { w: size, h: size, round: true };
    case 'dpad':
      return { w: size, h: size, round: false };
    case 'button':
      return control.wide
        ? { w: size * 2.1, h: size * 0.72, round: false }
        : { w: size, h: size, round: true };
    case 'trigger':
      return { w: size * 2.1, h: size * (control.wide ? 0.72 : 0.95), round: false };
    case 'steer':
      return { w: size * 2.1, h: size * 0.62, round: false };
    default:
      return null;
  }
}

/**
 * Turn whatever a game asked for into a layout the pad can render.
 *
 * Accepts either the id of a preset ('platformer') or a layout of its own:
 *
 *   { name: 'Fishing', controls: [
 *       { kind: 'stick',  id: 'left', x: 22, y: 55, size: 55 },
 *       { kind: 'button', id: 'a', x: 78, y: 60, size: 30, label: 'Cast' },
 *   ] }
 *
 * Returns null if nothing usable came in. Every value is checked here, because
 * a game sending nonsense must not be able to leave the phones with a broken
 * or empty controller.
 */
export function normalizeLayout(input) {
  if (typeof input === 'string') {
    return LAYOUTS[input] ? { id: input, ...LAYOUTS[input] } : null;
  }
  if (!input || typeof input !== 'object') return null;

  // Already normalized? Running this twice must not turn a preset into a
  // "custom" layout, so a known id without the custom flag stays a preset.
  if (!input.custom && typeof input.id === 'string' && LAYOUTS[input.id]) {
    return { id: input.id, ...LAYOUTS[input.id] };
  }

  if (!Array.isArray(input.controls)) return null;

  const controls = [];
  for (const raw of input.controls.slice(0, 24)) {
    const control = normalizeControl(raw);
    if (control) controls.push(control);
  }
  if (!controls.length) return null;

  return {
    id: typeof input.id === 'string' ? input.id.slice(0, 40) : 'custom',
    name: String(input.name || 'Own layout').slice(0, 40),
    hint: String(input.hint || 'Set by the game').slice(0, 120),
    custom: true,
    controls,
  };
}

function normalizeControl(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!CONTROL_KINDS.includes(raw.kind)) return null;

  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  // Each kind only accepts ids it can actually drive.
  let id = String(raw.id ?? '');
  if (raw.kind === 'stick') { if (id !== 'left' && id !== 'right') id = 'left'; }
  else if (raw.kind === 'trigger') { if (id !== 'lt' && id !== 'rt') id = 'rt'; }
  else if (raw.kind === 'button') { if (!BUTTONS.includes(id)) return null; }
  else id = raw.kind; // dpad, steer

  const control = {
    kind: raw.kind,
    id,
    x: num(raw.x, 0, 100, 50),
    y: num(raw.y, 0, 100, 50),
    size: num(raw.size, 4, 100, 20),
  };
  if (raw.wide) control.wide = true;
  if (raw.label !== undefined) control.label = String(raw.label).slice(0, 12);
  if (raw.labelKey !== undefined) control.labelKey = String(raw.labelKey).slice(0, 60);
  return control;
}
