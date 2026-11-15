/**
 * PocketJoy pad - the controller UI that runs on the phone.
 *
 * Renders the layout the server sends, tracks multi-touch, and streams input
 * deltas over the WebSocket at up to 60 Hz.
 *
 * Axis convention (same as the HTML Gamepad API):
 *   lx/rx: -1 = left,  +1 = right
 *   ly/ry: -1 = up,    +1 = down
 *   lt/rt:  0 = released, 1 = pressed
 */

import { AXES, BUTTONS, BUTTON_LABELS, LAYOUTS, SLOT_COLORS } from '/shared/protocol.js';
import { layoutPreviewSvg } from '/shared/layout-preview.js';
import { asWebSocketLike, createOfferingPeer } from '/shared/rtc.js';
import {
  LANGUAGES, getLanguage, layoutText, onLanguageChange, setLanguage, t,
} from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);

const el = {
  setup: $('setup'), status: $('status'), name: $('name'), go: $('go'), hint: $('hint'),
  room: $('room'), roomField: $('roomField'), langSelect: $('langSelect'),
  pad: $('pad'), controls: $('controls'),
  badge: $('badge'), badgeDot: $('badgeDot'), badgeName: $('badgeName'),
  menu: $('menu'), menuBtn: $('menuBtn'), menuInfo: $('menuInfo'),
  closeMenu: $('closeMenu'), fullscreenBtn: $('fullscreenBtn'), renameBtn: $('renameBtn'),
  overviewBtn: $('overviewBtn'), overview: $('overview'), overviewRoom: $('overviewRoom'),
  overviewPlayers: $('overviewPlayers'), overviewLayouts: $('overviewLayouts'),
  overviewLayoutNote: $('overviewLayoutNote'), closeOverview: $('closeOverview'),
};

const DEADZONE = 0.1;
const TAP_MS = 200;
const SEND_INTERVAL = 16;   // ms between input packets (~60 per second)

/**
 * /pad?new asks for a separate identity instead of this device's usual one.
 * Needed to test several players from one computer - normally one device is
 * exactly one player, no matter how many tabs are open.
 */
const PARAMS = new URLSearchParams(location.search);
const FRESH = PARAMS.has('new');

/**
 * ?room=CODE  -> web mode, connect to a hosted game via WebRTC
 * ?room       -> web mode, ask for the code
 * (nothing)   -> local mode, WebSocket to the PocketJoy server in this WLAN
 */
const WEB_MODE = PARAMS.has('room');

const store = {
  _area() { return FRESH ? sessionStorage : localStorage; },
  get(k, d = null) { try { return this._area().getItem('pocketjoy.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { this._area().setItem('pocketjoy.' + k, v); } catch { /* private mode */ } },
};

// --------------------------------------------------------------- app state

const state = {
  ws: null,
  connected: false,
  started: false,
  slot: null,
  color: SLOT_COLORS[0],
  name: store.get('name', ''),
  token: store.get('token'),
  layout: null,
  reconnectDelay: 500,
  seq: 0,
  wakeLock: null,
  /** set when a previous start crashed - then we skip optional display APIs */
  skipRisky: false,
  /** set when another window of this device took over the player slot */
  closedByTakeover: false,
  /** set when the host removed this player - no automatic reconnect then */
  kicked: false,
  /** set while waiting for a connection in order to start right away */
  startWhenConnected: false,
  /** true for the main controller: may remove players and set the layout */
  isHost: false,
  /** what the main controller sees in the overview */
  overview: null,
  /** web mode: the room code of the hosted game */
  room: '',
  /** web mode: the signalling connection (only for setting things up) */
  signal: null,
  /** true while the controller is rotated by CSS to force landscape */
  rotated: false,
  /** values last sent to the server, so we only send changes */
  sent: { btn: {}, ax: {} },
  /** values waiting to go out on the next send */
  pending: { btn: {}, ax: {} },
  flushTimer: null,
  lastFlush: 0,
};

el.name.value = state.name;

if (WEB_MODE) {
  state.room = (PARAMS.get('room') || store.get('room', '') || '').toUpperCase();
  el.room.value = state.room;
  // Only ask when we do not already have a code from the link.
  if (!state.room) showRoomField(true);
}

// ---------------------------------------------------------------- networking

function setStatus(text, cls = '') {
  el.status.textContent = text;
  el.status.className = 'status ' + cls;
}

/**
 * Two ways in, same protocol afterwards:
 *
 *  - local mode: a WebSocket to the PocketJoy server in this WLAN
 *  - web mode (?room=CODE): a direct WebRTC channel to a hosted game, because
 *    a game served over https is not allowed to open ws:// into a local
 *    network. The channel is wrapped so it looks like a WebSocket from here.
 */
function connect() {
  if (WEB_MODE) return connectViaRoom();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }
  wireSocket(ws);
}

/** Hook up a transport (real WebSocket or WebRTC channel) to the pad logic. */
function wireSocket(ws) {
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 500;
    ws.send(JSON.stringify({
      t: 'hello',
      role: 'pad',
      token: state.token || undefined,
      name: state.name || undefined,
      fresh: FRESH || undefined,
    }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    el.badge.classList.add('offline');
    el.badgeName.textContent = t('pad.disconnected');
    // After a takeover this tab must stay quiet - otherwise it would grab the
    // slot straight back and the two tabs would fight forever.
    if (state.closedByTakeover || state.kicked) return;
    if (!state.started) setStatus(t('pad.lost'), 'err');
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose follows */ };
}

/**
 * Web mode: find the game through a room code and open a direct channel.
 *
 * The signalling service only introduces the two sides - after that the
 * controller talks straight to the game, which keeps input fast and keeps
 * the service out of the way.
 */
/** Everything belonging to the web-mode transport, so it can be torn down. */
const rtc = { signal: null, peer: null, code: null, restartTimer: null, giveUpTimer: null };

function closeRtc() {
  clearTimeout(rtc.restartTimer);
  clearTimeout(rtc.giveUpTimer);
  rtc.restartTimer = null;
  rtc.giveUpTimer = null;
  if (rtc.peer) { rtc.peer.close(); rtc.peer = null; }
  if (rtc.signal) {
    rtc.signal.onclose = null;          // this close is ours, not a failure
    try { rtc.signal.close(); } catch { /* gone */ }
    rtc.signal = null;
  }
}

async function connectViaRoom() {
  const code = (state.room || '').toUpperCase();
  if (!code) {
    setStatus(t('pad.enterRoom'), 'warn');
    showRoomField(true);
    return;
  }

  closeRtc();   // never leave a half-dead connection behind
  rtc.code = code;
  setStatus(t('pad.searchingRoom', { code }));

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let signal;
  try {
    signal = new WebSocket(`${proto}//${location.host}/signal`);
  } catch {
    scheduleReconnect();
    return;
  }
  rtc.signal = signal;
  state.signal = signal;

  signal.onopen = () => {
    state.reconnectDelay = 500;
    signal.send(JSON.stringify({ t: 'join', code }));
  };

  signal.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.t === 'no-room') {
      setStatus(t('pad.noRoom', { code: msg.code || code }), 'err');
      showRoomField(true);
      state.room = '';
      closeRtc();
      return;
    }

    if (msg.t === 'joined') {
      setStatus(t('pad.joiningGame'));
      // The phone needs these itself: on mobile data it is the side that has
      // to offer the relay route, and it cannot do that without knowing the
      // server. They come from the service, never from this page's source.
      rtc.peer = createOfferingPeer({
        iceServers: Array.isArray(msg.iceServers) ? msg.iceServers : [],
        send: (data) => {
          if (signal.readyState === 1) signal.send(JSON.stringify({ t: 'signal', data }));
        },
        onChannel: (channel) => {
          store.set('room', code);
          wireSocket(asWebSocketLike(channel));
        },
        onState: onPeerState,
      });
      return;
    }

    if (msg.t === 'signal' && rtc.peer) await rtc.peer.handle(msg.data);
  };

  signal.onclose = () => {
    rtc.signal = null;
    // Once the channel is up, losing the signalling link is harmless - the
    // controller talks to the game directly. We only need it back to
    // renegotiate, so reopen it quietly while playing.
    if (state.connected) { setTimeout(reopenSignaling, 1500); return; }
    if (!state.kicked && !state.closedByTakeover) scheduleReconnect();
  };
  signal.onerror = () => { /* close follows */ };
}

/**
 * React to the connection changing state.
 *
 * A phone that walks out of WLAN range onto mobile data does not fail
 * instantly - it goes 'disconnected' first. Often it recovers by itself; if
 * not, renegotiating the route is far cheaper than rejoining, because the
 * player keeps their slot and the game never sees them leave.
 */
function onPeerState(pcState) {
  if (pcState === 'connected') {
    clearTimeout(rtc.restartTimer);
    clearTimeout(rtc.giveUpTimer);
    rtc.restartTimer = null;
    rtc.giveUpTimer = null;
    el.badge.classList.remove('offline');
    // Put the player's name back - it was replaced by the warning.
    if (state.slot) el.badgeName.textContent = `P${state.slot} · ${state.name}`;
  if (!el.overview.classList.contains('hidden')) renderOverview();
    if (state.started) setStatus(t('pad.connected', { slot: state.slot }), 'ok');
    return;
  }

  if (pcState === 'disconnected') {
    el.badge.classList.add('offline');
    el.badgeName.textContent = t('pad.unstable');
    // Give it a moment to heal on its own before stirring things up.
    if (!rtc.restartTimer) rtc.restartTimer = setTimeout(tryRenegotiate, 2500);
    return;
  }

  if (pcState === 'failed') {
    el.badge.classList.add('offline');
    tryRenegotiate();
  }
}

/** Ask for a new route; fall back to joining again if that does not help. */
async function tryRenegotiate() {
  clearTimeout(rtc.restartTimer);
  rtc.restartTimer = null;

  const ok = rtc.signal?.readyState === 1 && rtc.peer && await rtc.peer.restart();
  if (!ok) return scheduleReconnect();

  setStatus(t('pad.networkChanged'), 'warn');

  // Bring the display back in line with reality: a renegotiation on a link
  // that never really dropped produces no state change of its own.
  setTimeout(() => {
    if (rtc.peer) onPeerState(rtc.peer.pc.connectionState);
  }, 1500);
  // If the new route does not come up either, start over from the room code.
  if (!rtc.giveUpTimer) {
    rtc.giveUpTimer = setTimeout(() => {
      rtc.giveUpTimer = null;
      if (!state.connected || rtc.peer?.pc?.connectionState !== 'connected') scheduleReconnect();
    }, 8000);
  }
}

/** Reopen the signalling link while playing, so renegotiation stays possible. */
function reopenSignaling() {
  if (rtc.signal || !state.connected || !rtc.code) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let signal;
  try { signal = new WebSocket(`${proto}//${location.host}/signal`); } catch { return; }

  rtc.signal = signal;
  state.signal = signal;
  signal.onopen = () => signal.send(JSON.stringify({ t: 'join', code: rtc.code }));
  signal.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'signal' && rtc.peer) await rtc.peer.handle(msg.data);
  };
  signal.onclose = () => {
    rtc.signal = null;
    if (state.connected) setTimeout(reopenSignaling, 5000);
  };
  signal.onerror = () => { /* close follows */ };
}

function showRoomField(show) {
  el.roomField.classList.toggle('hidden', !show);
  if (show) el.room.focus();
}

function scheduleReconnect() {
  setTimeout(connect, state.reconnectDelay);
  state.reconnectDelay = Math.min(5000, state.reconnectDelay * 1.6);
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome': {
      state.connected = true;
      state.slot = msg.slot;
      state.color = msg.color || SLOT_COLORS[0];
      state.name = msg.name || state.name;

      // Coming back to a slot we already had a name in? Show that name again,
      // ready in the field. The server is the source here, so this also works
      // on a phone that stores nothing itself (private mode).
      if (msg.named && msg.name) {
        state.name = msg.name;
        store.set('name', msg.name);
      }
      el.name.value = state.name;

if (WEB_MODE) {
  state.room = (PARAMS.get('room') || store.get('room', '') || '').toUpperCase();
  el.room.value = state.room;
  // Only ask when we do not already have a code from the link.
  if (!state.room) showRoomField(true);
}
      if (msg.token) { state.token = msg.token; store.set('token', msg.token); }
      document.documentElement.style.setProperty('--accent', state.color);
      applyLayout(msg.layout);
      el.badge.classList.remove('offline');
      el.badgeDot.style.background = state.color;
      el.badgeName.textContent = `P${state.slot} · ${state.name}`;
      el.go.disabled = false;
      setStatus(t('pad.connected', { slot: state.slot }), 'ok');
      if (state.startWhenConnected) {
        state.startWhenConnected = false;
        startPad();
      }
      // Sync any held controls to the (possibly new) server state.
      state.sent = { btn: {}, ax: {} };
      sendFullState();
      break;
    }
    case 'player':
      state.name = msg.name || state.name;
      el.name.value = state.name;

if (WEB_MODE) {
  state.room = (PARAMS.get('room') || store.get('room', '') || '').toUpperCase();
  el.room.value = state.room;
  // Only ask when we do not already have a code from the link.
  if (!state.room) showRoomField(true);
}
      el.badgeName.textContent = `P${state.slot} · ${state.name}`;
      break;
    case 'layout':
      applyLayout(msg);
      break;
    case 'host':
      // First one in runs the round; if they leave, the next takes over.
      state.isHost = !!msg.isHost;
      el.overviewBtn.classList.toggle('hidden', !state.isHost);
      if (!state.isHost) el.overview.classList.add('hidden');
      break;
    case 'overview':
      state.overview = msg;
      if (!el.overview.classList.contains('hidden')) renderOverview();
      break;
    case 'rumble':
      vibrate(msg.ms, msg.strength);
      break;
    case 'resync':
      // The server noticed a gap in our numbering - tell it everything.
      sendFullState();
      break;
    case 'full':
      setStatus(t('pad.full', { max: msg.maxPlayers }), 'warn');
      el.go.disabled = true;
      break;
    case 'kicked':
      // The host freed this seat. Do NOT reconnect by ourselves - that would
      // undo the removal within half a second. Joining again is a deliberate
      // tap, and that is allowed.
      state.kicked = true;
      state.started = false;
      show('setup');
      setStatus(t('pad.removed'), 'warn');
      el.hint.textContent = t('pad.removedHint');
      el.go.disabled = false;
      el.go.textContent = t('pad.rejoin');
      break;
    case 'takeover':
      // This device opened the controller somewhere else (another tab, or a
      // reconnect). That other connection is the player now; this one stops.
      state.closedByTakeover = true;
      state.started = false;
      show('setup');
      setStatus(t('pad.elsewhere'), 'warn');
      el.go.disabled = true;
      el.hint.textContent = t('pad.elsewhereHint');
      break;
    default: break;
  }
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

// ------------------------------------------------------------ input sending

function setButton(id, down) {
  if (state.pending.btn[id] === down) return;
  state.pending.btn[id] = down;
  queueFlush();
}

function setAxis(id, value) {
  const v = Math.round(value * 1000) / 1000;
  if (state.pending.ax[id] === v) return;
  state.pending.ax[id] = v;
  queueFlush();
}

/**
 * Schedule a send, at most every SEND_INTERVAL ms.
 *
 * Deliberately a timer and not requestAnimationFrame: a controller should send
 * at a steady rate, not at the display's frame rate, and there are states where
 * a page believes it is visible but gets no frames at all - input would then
 * stop dead.
 */
function queueFlush() {
  if (state.flushTimer !== null) return;
  const since = performance.now() - state.lastFlush;
  state.flushTimer = setTimeout(flush, Math.max(0, SEND_INTERVAL - since));
}

function flush() {
  if (state.flushTimer !== null) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  state.lastFlush = performance.now();
  const btn = {};
  const ax = {};
  for (const [k, v] of Object.entries(state.pending.btn)) {
    if (state.sent.btn[k] !== v) { btn[k] = v; state.sent.btn[k] = v; }
  }
  for (const [k, v] of Object.entries(state.pending.ax)) {
    if (state.sent.ax[k] !== v) { ax[k] = v; state.sent.ax[k] = v; }
  }
  if (!Object.keys(btn).length && !Object.keys(ax).length) return;
  send({ t: 'input', seq: state.seq++, btn, ax });
}

/**
 * Send everything, not just what changed.
 *
 * Needed because normal packets only carry changes: if one goes missing over
 * an unreliable channel, the server keeps a wrong idea of this controller -
 * a button it never saw released stays down. This puts both sides back in
 * step, and `full` tells the server to trust it unconditionally.
 */
function sendFullState() {
  const btn = {};
  const ax = {};
  for (const b of BUTTONS) btn[b] = !!state.pending.btn[b];
  for (const a of AXES) ax[a] = state.pending.ax[a] ?? 0;

  state.sent = { btn: { ...btn }, ax: { ...ax } };
  state.lastFlush = performance.now();
  send({ t: 'input', seq: state.seq++, full: true, btn, ax });
}

/**
 * Release everything - used when the page is hidden or a layout changes.
 *
 * This flushes immediately instead of waiting for the next animation frame:
 * a hidden tab gets no frames, so a queued release would never be sent and the
 * server would keep the button held forever.
 */
function releaseAll() {
  for (const k of Object.keys(state.pending.btn)) setButton(k, false);
  for (const k of Object.keys(state.pending.ax)) setAxis(k, 0);
  flush();
}

// -------------------------------------------------------------- layout render

function applyLayout(layout) {
  if (!layout || !Array.isArray(layout.controls)) return;
  releaseAll();
  state.layout = layout;
  el.controls.innerHTML = '';
  for (const c of layout.controls) {
    const node = buildControl(c);
    if (node) el.controls.appendChild(node);
  }
  sizeControls();
  el.menuInfo.textContent = t('menu.layout', { name: layoutText(layout, 'name') });
}

function buildControl(c) {
  const node = document.createElement('div');
  node.className = `ctl ${c.kind}${c.wide ? ' wide' : ''}`;
  node.style.left = `${c.x}%`;
  node.style.top = `${c.y}%`;
  node.style.setProperty('--glow', state.color);
  node.dataset.size = c.size;
  node.dataset.kind = c.kind;
  node.dataset.id = c.id;

  if (c.kind === 'stick') {
    const knob = document.createElement('div');
    knob.className = 'knob';
    node.appendChild(knob);
    bindStick(node, knob, c);
  } else if (c.kind === 'dpad') {
    for (const dir of ['up', 'down', 'left', 'right']) {
      const arm = document.createElement('div');
      arm.className = `arm ${dir}`;
      arm.dataset.dir = dir;
      arm.textContent = BUTTON_LABELS[dir];
      node.appendChild(arm);
    }
    bindDpad(node, c);
  } else if (c.kind === 'steer') {
    const tick = document.createElement('div');
    tick.className = 'tick';
    const knob = document.createElement('div');
    knob.className = 'knob';
    node.append(tick, knob);
    bindSteer(node, knob, c);
  } else if (c.kind === 'trigger') {
    node.textContent = controlLabel(c) || (c.id === 'lt' ? 'LT' : 'RT');
    bindHold(node, c, (down) => setAxis(c.id, down ? 1 : 0));
  } else if (c.kind === 'button') {
    node.textContent = controlLabel(c) || BUTTON_LABELS[c.id] || c.id.toUpperCase();
    bindHold(node, c, (down) => setButton(c.id, down));
  } else {
    return null;
  }
  return node;
}

/** Control pixel sizes are percentages of the pad HEIGHT, so set them in JS. */
function sizeControls() {
  const h = el.controls.clientHeight || window.innerHeight;
  for (const node of el.controls.children) {
    const size = Number(node.dataset.size) || 20;
    node.style.setProperty('--w', `${(size / 100) * h}px`);
  }
}

// ------------------------------------------------------------ touch handling

/**
 * Where a finger is, relative to the centre of a control, in that control's
 * OWN axes.
 *
 * When the controller is rotated to force landscape, screen coordinates no
 * longer line up with the control: sliding a finger down the screen moves it
 * to the right of the control. This undoes that rotation, so every handler can
 * work in plain local coordinates.
 *
 * offsetWidth/offsetHeight are the untransformed layout size - unlike
 * getBoundingClientRect(), which returns the rotated bounding box.
 */
function localDelta(node, e) {
  const r = node.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  if (state.rotated) {
    const t = dx;
    dx = dy;
    dy = -t;
  }
  return { dx, dy, w: node.offsetWidth, h: node.offsetHeight };
}

/**
 * Pointer capture keeps a finger bound to its control even when it slides off.
 * It throws for pointer ids the browser does not know (synthetic events in
 * tests, odd browsers), and a throw here would swallow the whole press - so it
 * is always optional.
 */
function capture(node, pointerId) {
  try { node.setPointerCapture(pointerId); } catch { /* not essential */ }
}

/** Shared press/release bookkeeping: a control is held while any finger is on it. */
function bindHold(node, c, onChange) {
  const fingers = new Set();

  const update = () => {
    const held = fingers.size > 0;
    node.classList.toggle('held', held);
    onChange(held);
  };

  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(node, e.pointerId);
    fingers.add(e.pointerId);
    if (fingers.size === 1) { update(); vibrate(12, 0.3); }
  });
  const end = (e) => {
    if (!fingers.delete(e.pointerId)) return;
    if (fingers.size === 0) update();
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('lostpointercapture', end);
}

function bindStick(node, knob, c) {
  const axX = c.id === 'right' ? 'rx' : 'lx';
  const axY = c.id === 'right' ? 'ry' : 'ly';
  const clickBtn = c.id === 'right' ? 'rs' : 'ls';
  let active = null;
  let downAt = 0;
  let moved = 0;

  const apply = (e) => {
    const local = localDelta(node, e);
    const radius = local.w / 2;
    let dx = local.dx / radius;
    let dy = local.dy / radius;

    let len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; len = 1; }
    moved = Math.max(moved, len);

    // Radial deadzone, rescaled so the usable range stays full -1..1.
    if (len < DEADZONE) { dx = 0; dy = 0; }
    else {
      const scaled = (len - DEADZONE) / (1 - DEADZONE);
      dx = (dx / len) * scaled;
      dy = (dy / len) * scaled;
    }

    knob.style.transform = `translate(${dx * 58}%, ${dy * 58}%)`;
    setAxis(axX, dx);
    setAxis(axY, dy);
  };

  node.addEventListener('pointerdown', (e) => {
    if (active !== null) return;
    e.preventDefault();
    active = e.pointerId;
    downAt = performance.now();
    moved = 0;
    capture(node, e.pointerId);
    node.classList.add('held');
    apply(e);
  });

  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    e.preventDefault();
    apply(e);
  });

  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    node.classList.remove('held');
    knob.style.transform = 'translate(0, 0)';
    setAxis(axX, 0);
    setAxis(axY, 0);
    // A quick tap without moving counts as a stick click.
    if (performance.now() - downAt < TAP_MS && moved < 0.25) {
      setButton(clickBtn, true);
      setTimeout(() => setButton(clickBtn, false), 60);
    }
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('lostpointercapture', end);
}

function bindDpad(node, c) {
  let active = null;
  const dirs = { up: false, down: false, left: false, right: false };

  const apply = (e) => {
    const local = localDelta(node, e);
    const dx = local.dx / (local.w / 2);
    const dy = local.dy / (local.h / 2);
    const T = 0.3;

    const next = {
      left: dx < -T, right: dx > T,
      up: dy < -T, down: dy > T,
    };
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (next[dir] === dirs[dir]) continue;
      dirs[dir] = next[dir];
      setButton(dir, next[dir]);
      const arm = node.querySelector(`.arm.${dir}`);
      if (arm) arm.classList.toggle('on', next[dir]);
      if (next[dir]) vibrate(10, 0.25);
    }
    // Mirror onto the left stick so axis-reading games work with a d-pad too.
    setAxis('lx', (next.right ? 1 : 0) - (next.left ? 1 : 0));
    setAxis('ly', (next.down ? 1 : 0) - (next.up ? 1 : 0));
  };

  node.addEventListener('pointerdown', (e) => {
    if (active !== null) return;
    e.preventDefault();
    active = e.pointerId;
    capture(node, e.pointerId);
    apply(e);
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    e.preventDefault();
    apply(e);
  });
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (!dirs[dir]) continue;
      dirs[dir] = false;
      setButton(dir, false);
      node.querySelector(`.arm.${dir}`)?.classList.remove('on');
    }
    setAxis('lx', 0);
    setAxis('ly', 0);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('lostpointercapture', end);
}

function bindSteer(node, knob, c) {
  let active = null;

  const apply = (e) => {
    const local = localDelta(node, e);
    const usable = local.w * 0.86; // keep the knob inside the track
    let v = local.dx / (usable / 2);
    v = Math.max(-1, Math.min(1, v));
    if (Math.abs(v) < DEADZONE) v = 0;
    knob.style.transform = `translateX(${v * (usable / 2)}px)`;
    setAxis('lx', v);
  };

  node.addEventListener('pointerdown', (e) => {
    if (active !== null) return;
    e.preventDefault();
    active = e.pointerId;
    capture(node, e.pointerId);
    node.classList.add('held');
    apply(e);
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    e.preventDefault();
    apply(e);
  });
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    node.classList.remove('held');
    knob.style.transform = 'translateX(0)';
    setAxis('lx', 0);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('lostpointercapture', end);
}

// ------------------------------------------------------------------ device

function vibrate(ms, strength = 1) {
  if (!navigator.vibrate) return;
  try { navigator.vibrate(Math.max(5, Math.round(ms * (0.4 + 0.6 * strength)))); } catch { /* ignore */ }
}

/** Report a problem to the server, so it shows up in its terminal. */
function report(msg) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: String(msg), ua: navigator.userAgent }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never let logging break anything */ }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch { /* denied or unsupported */ }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    if (!document.documentElement.requestFullscreen) return false;
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return !!document.fullscreenElement;
  } catch (err) {
    // iOS Safari refuses this outright; some browsers refuse it silently.
    report(`Vollbild nicht moeglich: ${err?.message || err}`);
    return false;
  }
}

/**
 * Force landscape - with CSS, not with screen.orientation.lock().
 *
 * The lock API only works in fullscreen, is refused by iOS entirely, and is
 * one of the calls that can take a browser tab down. Rotating the controller
 * ourselves always works, on every browser, and cannot crash anything: if the
 * phone is held upright we simply turn the whole controller by 90 degrees.
 *
 * Touch coordinates are converted back in localDelta().
 */
function applyOrientation() {
  const portrait = window.innerHeight > window.innerWidth;
  state.rotated = portrait;
  document.body.classList.toggle('rotate', portrait);
  sizeControls();
}

/** Wait for the on-screen keyboard to be gone before touching display APIs. */
function closeKeyboard() {
  try { document.activeElement?.blur?.(); } catch { /* ignore */ }
  return new Promise((resolve) => setTimeout(resolve, 250));
}

// ------------------------------------------------------------------ screens

function show(which) {
  el.setup.classList.toggle('hidden', which !== 'setup');
  el.pad.classList.toggle('hidden', which !== 'pad');
  el.menu.classList.add('hidden');
  if (which === 'pad') {
    // setTimeout, not rAF: see queueFlush() - frames are not guaranteed.
    setTimeout(applyOrientation, 0);
  }
}

el.go.addEventListener('click', async () => {
  // Removed by the host? Then this is a fresh join: reconnect first, and the
  // controller opens by itself once the server has a seat for us again.
  if (state.kicked || !state.connected) {
    if (WEB_MODE) {
      const code = el.room.value.trim().toUpperCase();
      if (!code) { showRoomField(true); setStatus(t('pad.enterRoom'), 'warn'); return; }
      state.room = code;
    }
    state.kicked = false;
    state.startWhenConnected = true;
    el.go.disabled = true;
    el.go.textContent = t('pad.start');
    setStatus(t('pad.connecting'));
    connect();
    return;
  }
  await startPad();
});

async function startPad() {
  const name = el.name.value.trim();
  if (name && name !== state.name) {
    state.name = name;
    store.set('name', name);
    send({ t: 'name', name });
  }
  state.started = true;
  show('pad');

  // The keyboard is still open at this point - the player just typed a name.
  // Display APIs while it is up have killed browser tabs, so close it first
  // and let the layout settle.
  await step('tastatur', closeKeyboard);

  // Nothing risky runs by itself any more. Landscape is handled by CSS (see
  // applyOrientation), fullscreen is only offered in the menu, and even the
  // wake lock is guarded in case it is the one that trips a device up.
  if (!state.skipRisky) {
    await step('wakelock', requestWakeLock);
  }
}

/**
 * Run a startup step and leave a breadcrumb while it is running.
 *
 * If the browser dies inside `fn`, the flag survives in storage. The next time
 * the page loads it reports exactly which step was fatal and skips the risky
 * ones - so a device that crashes once still works on the second try.
 */
async function step(name, fn) {
  store.set('startup', name);
  try {
    await fn();
  } catch (err) {
    report(`Startschritt "${name}" fehlgeschlagen: ${err?.message || err}`);
  }
  store.set('startup', '');
}

el.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !el.go.disabled) el.go.click();
});

el.menuBtn.addEventListener('click', () => {
  resetFullscreenButton();
  el.menu.classList.remove('hidden');
});
el.closeMenu.addEventListener('click', () => el.menu.classList.add('hidden'));
/**
 * Fullscreen needs a deliberate second tap.
 *
 * On some phones requestFullscreen() ends the browser outright - it cannot be
 * caught, the tab is simply gone. So nobody should hit it by accident, and a
 * device that dies once never sees the button again (see
 * applyFullscreenAvailability).
 */
let fullscreenArmed = false;

function resetFullscreenButton() {
  fullscreenArmed = false;
  if (el.fullscreenBtn.disabled) return;
  el.fullscreenBtn.textContent = document.fullscreenElement
    ? t('menu.fullscreenOff')
    : t('menu.fullscreenOn');
}

el.fullscreenBtn.addEventListener('click', async () => {
  if (el.fullscreenBtn.disabled) return;

  // Leaving fullscreen is harmless - do it right away.
  if (!document.fullscreenElement && !fullscreenArmed) {
    fullscreenArmed = true;
    el.fullscreenBtn.textContent = t('menu.fullscreenConfirm');
    setTimeout(() => { if (fullscreenArmed) resetFullscreenButton(); }, 5000);
    return;
  }

  fullscreenArmed = false;
  state.skipRisky = false;
  await step('vollbild', toggleFullscreen);
  resetFullscreenButton();
});
el.overviewBtn.addEventListener('click', openOverview);
el.closeOverview.addEventListener('click', () => el.overview.classList.add('hidden'));

el.renameBtn.addEventListener('click', () => {
  el.menu.classList.add('hidden');
  state.started = false;
  show('setup');
  el.name.value = state.name;

if (WEB_MODE) {
  state.room = (PARAMS.get('room') || store.get('room', '') || '').toUpperCase();
  el.room.value = state.room;
  // Only ask when we do not already have a code from the link.
  if (!state.room) showRoomField(true);
}
  el.name.select();
  setStatus(state.connected ? t('pad.connected', { slot: state.slot }) : t('pad.connecting'),
            state.connected ? 'ok' : '');
});

window.addEventListener('resize', applyOrientation);
window.addEventListener('orientationchange', () => {
  setTimeout(applyOrientation, 120);
});

/**
 * Safety net for the one case gap detection cannot catch.
 *
 * Gaps only show up when more packets follow. If the very last packet of a
 * burst is the one that gets lost - typically "everything released" at the
 * end of a move - nothing follows, no gap appears, and the controller would
 * stay stuck. So whenever the line has been quiet for a moment, send the
 * full state. Costs nothing while actually playing, because then packets are
 * flowing anyway.
 */
const IDLE_RESYNC_MS = 400;
// Checked more often than the threshold: with both equal, timing jitter makes
// every other tick miss and the correction takes twice as long as intended.
setInterval(() => {
  if (!state.connected || state.flushTimer !== null) return;
  if (performance.now() - state.lastFlush < IDLE_RESYNC_MS) return;
  sendFullState();
}, Math.round(IDLE_RESYNC_MS / 2));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAll();
  else if (state.started) requestWakeLock();
});

// Belt and braces: never let the page scroll or zoom under a controller.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// Report problems to the server so they are visible in its terminal.
window.addEventListener('error', (e) => {
  report(`Fehler: ${e.message} (${e.filename || '?'}:${e.lineno || 0})`);
});
window.addEventListener('unhandledrejection', (e) => {
  report(`Promise-Fehler: ${e.reason?.message || e.reason}`);
});

/**
 * Did the last start die inside a step? Then that step took the browser down.
 * Name it in the server log and leave the risky ones out this time.
 */
const diedAt = store.get('startup');
if (diedAt) {
  store.set('startup', '');
  report(`Vorheriger Start ist bei Schritt "${diedAt}" abgebrochen - wird diesmal uebersprungen`);

  if (diedAt === 'vollbild') {
    // Fullscreen took this browser down. Some devices simply cannot do it -
    // remember that for good instead of offering the same trap again.
    store.set('nofullscreen', '1');
    el.hint.textContent = t('pad.fullscreenKilled');
  } else {
    state.skipRisky = true;
    el.hint.textContent = t('pad.startTrouble');
  }
}

/**
 * Put the current language on screen.
 *
 * Called at start-up and whenever the language changes: elements carrying
 * data-i18n get their text, and the pieces built in code are redrawn. The
 * controller itself is rebuilt too, because some layouts have labels.
 */
function applyTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }

  if (state.slot) el.badgeName.textContent = `P${state.slot} · ${state.name}`;
  if (!el.overview.classList.contains('hidden')) renderOverview();
  if (state.layout) applyLayout(state.layout);
  resetFullscreenButton();

  if (state.connected && !state.kicked) {
    setStatus(t('pad.connected', { slot: state.slot }), 'ok');
  } else if (!state.connected && !state.kicked) {
    setStatus(t('pad.connecting'));
  }
}

/**
 * The overview, for the main controller only.
 *
 * Everything needed to run a round from the phone: who is playing, who to
 * remove, and which layout everyone gets. In web mode it also shows the room
 * code, because there is no lobby on a screen to read it off.
 */
function renderOverview() {
  const data = state.overview;
  if (!data) return;

  // Room code - only useful in web mode.
  const showRoom = WEB_MODE && state.room;
  el.overviewRoom.classList.toggle('hidden', !showRoom);
  if (showRoom) el.overviewRoom.textContent = t('overview.room', { code: state.room });

  el.overviewPlayers.innerHTML = '';
  for (const p of data.players || []) {
    const row = document.createElement('div');
    row.className = 'ov-player';
    row.style.setProperty('--pc', p.color);

    const dot = document.createElement('span');
    dot.className = 'dot';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name;
    row.append(dot, who);

    if (p.slot === state.slot) {
      // You cannot remove yourself - that would only orphan the round.
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t('overview.you');
      row.appendChild(tag);
    } else {
      const kick = document.createElement('button');
      kick.textContent = t('overview.remove');
      kick.addEventListener('click', () => send({ t: 'kick', slot: p.slot }));
      row.appendChild(kick);
    }
    el.overviewPlayers.appendChild(row);
  }

  el.overviewLayoutNote.textContent = t(data.layoutLocked
    ? 'overview.layoutLocked'
    : 'overview.layoutHint');

  el.overviewLayouts.innerHTML = '';
  for (const [id, def] of Object.entries(LAYOUTS)) {
    const active = data.layout?.id === id && !data.layout?.custom;
    const btn = document.createElement('button');
    btn.className = 'ov-layout' + (active ? ' active' : '');
    btn.disabled = !!data.layoutLocked;
    btn.innerHTML = `<span class="prev">${layoutPreviewSvg(LAYOUTS[id], {
      color: active ? state.color : '#6f7a8b',
    })}</span>`;
    const name = document.createElement('span');
    name.textContent = layoutText({ id, ...def }, 'name');
    btn.appendChild(name);
    btn.addEventListener('click', () => {
      send({ t: 'layout', layout: id });
      vibrate(20, 0.4);
    });
    el.overviewLayouts.appendChild(btn);
  }
}

function openOverview() {
  el.menu.classList.add('hidden');
  renderOverview();
  el.overview.classList.remove('hidden');
}

/** The label on a control: a fixed one from a preset, or a game's own text. */
function controlLabel(c) {
  if (c.labelKey) return t(c.labelKey);
  return c.label || '';
}

function buildLanguageMenu() {
  el.langSelect.innerHTML = '';
  for (const lang of LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.name;
    el.langSelect.appendChild(option);
  }
  el.langSelect.value = getLanguage();
  el.langSelect.addEventListener('change', () => setLanguage(el.langSelect.value));
}

/** Hide the fullscreen button on devices where it is known to be fatal. */
function applyFullscreenAvailability() {
  if (store.get('nofullscreen') !== '1') return;
  el.fullscreenBtn.disabled = true;
  el.fullscreenBtn.textContent = t('menu.fullscreenImpossible');
}
applyFullscreenAvailability();

/**
 * Test hook: /pad?test exposes the innards, so a renegotiation or a dropped
 * connection can be triggered deliberately instead of waiting for a real
 * phone to walk out of WLAN range.
 */
if (PARAMS.has('test')) {
  window.__pj = {
    state,
    rtc,
    renegotiate: tryRenegotiate,
    /** Pretend the network changed under us. */
    simulateNetworkChange() {
      onPeerState('disconnected');
      return 'disconnected gemeldet';
    },
    connectionState: () => rtc.peer?.pc?.connectionState ?? 'kein Peer',
  };
}

buildLanguageMenu();
applyTranslations();
onLanguageChange(applyTranslations);

connect();
applyOrientation();
