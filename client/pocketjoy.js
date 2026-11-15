/**
 * PocketJoy client library.
 *
 * Drop this into your game and the phones connected to the PocketJoy server
 * show up as players.
 *
 *   import { PocketJoy } from './pocketjoy.js';
 *
 *   const pj = new PocketJoy({ layout: 'dual-stick', maxPlayers: 4 });
 *   pj.connect();
 *
 *   function frame() {
 *     for (const p of pj.players) {
 *       const { x, y } = p.stick('left');     // -1..1, y: -1 = up
 *       if (p.pressed('a')) shoot(p);         // true only on the frame it went down
 *       if (p.down('rt')) accelerate(p);      // triggers work as buttons too
 *     }
 *     pj.update();        // <- end of frame: clears pressed/released
 *     requestAnimationFrame(frame);
 *   }
 *
 * Axis convention (same as the HTML Gamepad API):
 *   lx/rx: -1 left,  +1 right
 *   ly/ry: -1 up,    +1 down
 *   lt/rt:  0 released, 1 pressed
 *
 * Works in the browser and in Node (needs the `ws` package there).
 */

const BUTTONS = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start',
  'ls', 'rs', 'up', 'down', 'left', 'right',
];
const TRIGGERS = { lt: 'lt', rt: 'rt' };
const DEFAULT_PORT = 3070;

/** One connected phone. */
export class Player {
  constructor(info, pj) {
    this.slot = info.slot;
    this.id = info.id;
    this.name = info.name;
    this.color = info.color;
    this._pj = pj;

    this.buttons = {};
    for (const b of BUTTONS) this.buttons[b] = false;
    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };

    this._pressed = new Set();
    this._released = new Set();
  }

  /** Is the button held right now? Triggers (lt/rt) count as pressed past 50%. */
  down(button) {
    if (TRIGGERS[button]) return this.axes[button] > 0.5;
    return !!this.buttons[button];
  }

  /** Did the button go down since the last pj.update()? */
  pressed(button) { return this._pressed.has(button); }

  /** Did the button come up since the last pj.update()? */
  released(button) { return this._released.has(button); }

  /** Raw axis value, -1..1 (triggers 0..1). */
  axis(name) { return this.axes[name] ?? 0; }

  /**
   * A stick as a vector. 'left' (default) or 'right'.
   * The d-pad is mirrored onto the left stick, so this works for every layout.
   */
  stick(which = 'left') {
    return which === 'right'
      ? { x: this.axes.rx, y: this.axes.ry }
      : { x: this.axes.lx, y: this.axes.ly };
  }

  /** Stick direction with a deadzone and length capped at 1. */
  dir(which = 'left', deadzone = 0.15) {
    const { x, y } = this.stick(which);
    const len = Math.hypot(x, y);
    if (len < deadzone) return { x: 0, y: 0, len: 0, angle: 0 };
    const capped = Math.min(1, len);
    return { x: (x / len) * capped, y: (y / len) * capped, len: capped, angle: Math.atan2(y, x) };
  }

  /** Buzz this phone. ms 10..2000, strength 0..1. */
  rumble(ms = 150, strength = 1) {
    this._pj._send({ t: 'rumble', slot: this.slot, ms, strength });
  }

  /** Disconnect this phone (it can rejoin). */
  kick() { this._pj._send({ t: 'kick', slot: this.slot }); }

  /**
   * Take in one packet and report what changed *in this packet*.
   *
   * The returned edges are what the press/release events are built from. They
   * have to be the new ones, not everything collected since the last
   * update(): a phone sends up to 60 packets a second, so between two frames
   * several usually arrive, and reporting the whole set each time would fire
   * the same press over and over.
   */
  _applyInput(btn, ax) {
    const pressed = [];
    const released = [];

    for (const [k, v] of Object.entries(btn || {})) {
      if (!(k in this.buttons)) continue;
      if (v && !this.buttons[k]) { this._pressed.add(k); pressed.push(k); }
      if (!v && this.buttons[k]) { this._released.add(k); released.push(k); }
      this.buttons[k] = v;
    }
    for (const [k, v] of Object.entries(ax || {})) {
      if (!(k in this.axes)) continue;
      // Triggers also produce press/release edges so down()/pressed() agree.
      if (TRIGGERS[k]) {
        const was = this.axes[k] > 0.5;
        const now = v > 0.5;
        if (now && !was) { this._pressed.add(k); pressed.push(k); }
        if (!now && was) { this._released.add(k); released.push(k); }
      }
      this.axes[k] = v;
    }
    return { pressed, released };
  }

  _clearEdges() {
    this._pressed.clear();
    this._released.clear();
  }
}

export class PocketJoy {
  /**
   * @param {object} opts
   * @param {string} [opts.url]        full ws:// URL; overrides host/port
   * @param {string} [opts.host]       default: the host this page came from
   * @param {number} [opts.port]       default: 3070
   * @param {string|object} [opts.layout] preset id ('platformer') or a layout
   *        of your own: { name, controls: [...] } - see the README
   * @param {boolean} [opts.lockLayout] keep the lobby from switching it away
   *        while this game is connected (default: false)
   * @param {number} [opts.maxPlayers] 1..8
   * @param {string} [opts.name]       shown in the server log
   * @param {boolean} [opts.autoReconnect] default: true
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.url = opts.url || buildUrl(opts);
    this.connected = false;
    /** The layout the phones are showing right now. */
    this.layout = null;
    /** True while this game keeps the lobby from switching the layout. */
    this.layoutLocked = false;
    this.maxPlayers = opts.maxPlayers || null;

    /** @type {Map<number, Player>} slot -> player */
    this._bySlot = new Map();
    this._listeners = new Map();
    this._ws = null;
    this._reconnectDelay = 400;
    this._closedByUs = false;
  }

  /** Players sorted by slot. */
  get players() {
    return [...this._bySlot.values()].sort((a, b) => a.slot - b.slot);
  }

  get count() { return this._bySlot.size; }

  /** The player in that slot, or null. */
  player(slot) { return this._bySlot.get(Number(slot)) || null; }

  /**
   * Connect to the server.
   * @returns {Promise<PocketJoy>} resolves once the server said hello
   */
  connect() {
    this._closedByUs = false;
    return new Promise((resolve, reject) => {
      this._open(resolve, reject);
    });
  }

  disconnect() {
    this._closedByUs = true;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
    this.connected = false;
  }

  /** Call once per frame, after reading input. Clears pressed()/released(). */
  update() {
    for (const p of this._bySlot.values()) p._clearEdges();
  }

  /**
   * Switch the controller layout on every connected phone, immediately.
   *
   * Takes the id of a preset ('platformer', 'racing', …) or a layout of your
   * own - see the README. Call it whenever the game changes mode: menu,
   * driving section, boss fight.
   *
   *   pj.setLayout('racing');
   *   pj.setLayout({ name: 'Angeln', controls: [...] });
   *
   * Pass `lock` to say whether the lobby may override it while you are
   * connected. Leave it out to keep the current setting.
   */
  setLayout(layout, lock) {
    this.opts.layout = layout;
    const msg = { t: 'layout', layout };
    if (lock !== undefined) {
      msg.lockLayout = lock === true;
      this.opts.lockLayout = lock === true;
    }
    this._send(msg);
  }

  /** Buzz every phone. */
  rumbleAll(ms = 150, strength = 1) {
    this._send({ t: 'rumble', slot: 'all', ms, strength });
  }

  // ------------------------------------------------------------- events

  /**
   * Events: 'connect', 'disconnect', 'join'(player), 'leave'(player),
   * 'player'(player) when a name changes, 'press'(player, button),
   * 'release'(player, button), 'layout'(layout), 'error'(reason)
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(...args); } catch (err) { console.error('[pocketjoy]', err); }
    }
  }

  // ---------------------------------------------------------- networking

  async _open(resolve, reject) {
    // Catch the one mistake that costs people an afternoon: a game served over
    // https cannot reach a PocketJoy server on the local network, because
    // browsers refuse insecure WebSocket connections from secure pages. No
    // option changes that - the server has to be behind https as well.
    if (globalThis.location?.protocol === 'https:' && this.url.startsWith('ws://')) {
      const err = new Error(
        `PocketJoy: Diese Seite läuft über https, der Server aber über ws:// (${this.url}). `
        + 'Browser blockieren das. Entweder das Spiel über http ausliefern (lokal), '
        + 'oder PocketJoy hinter https/wss betreiben. Siehe README, Abschnitt '
        + '"Gehostete Spiele".',
      );
      console.error(err.message);
      this._emit('error', 'insecure-url');
      return reject?.(err);
    }

    let ws;
    if (typeof this.opts.createSocket === 'function') {
      // Someone else supplies the transport - used by the WebRTC mode, where
      // the hub runs inside this very page and no network socket is involved.
      try { ws = this.opts.createSocket(); } catch (err) { return reject?.(err); }
    } else {
      let WS = globalThis.WebSocket;
      if (!WS) {
        try { WS = (await import('ws')).default; }
        catch { return reject?.(new Error('No WebSocket available. In Node: npm install ws')); }
      }
      try { ws = new WS(this.url); } catch (err) { return reject?.(err); }
    }
    this._ws = ws;

    const onOpen = () => {
      ws.send(JSON.stringify({
        t: 'hello',
        role: 'game',
        name: this.opts.name || 'game',
        layout: this.opts.layout,
        lockLayout: this.opts.lockLayout === true,
        maxPlayers: this.opts.maxPlayers,
      }));
    };

    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.data ?? raw); }
      catch { return; }
      this._handle(msg, resolve);
    };

    // Two WebSocket implementations end up here, and they do not agree on
    // what a failed connection looks like: the `ws` package always follows an
    // error with a close event, the one Node has had as a global since v22
    // does not. So a failure is handled wherever it shows up first, and this
    // flag keeps the second event from running it twice - otherwise a
    // reconnect would be scheduled two times over.
    let done = false;
    const onClose = () => {
      if (done) return;
      done = true;
      const was = this.connected;
      this.connected = false;
      this._bySlot.clear();
      if (was) this._emit('disconnect');

      if (!this._closedByUs && this.opts.autoReconnect !== false) {
        setTimeout(() => this._open(), this._reconnectDelay);
        this._reconnectDelay = Math.min(5000, this._reconnectDelay * 1.6);
      } else if (!was && reject) {
        // Never connected and not going to retry: connect() must fail here,
        // otherwise awaiting it would hang forever.
        reject(new Error(
          `PocketJoy: Keine Verbindung zu ${this.url}. Läuft der Server?`,
        ));
      }
      reject = null; // a later failure must not reject an already-resolved promise
    };

    // Browser (addEventListener) and Node `ws` (on) have different APIs.
    if (ws.addEventListener) {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', (e) => onMessage(e.data));
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onClose);
    } else {
      ws.on('open', onOpen);
      ws.on('message', (d) => onMessage(d.toString()));
      ws.on('close', onClose);
      ws.on('error', onClose);
    }
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(obj));
  }

  _handle(msg, resolve) {
    switch (msg.t) {
      case 'welcome': {
        this.connected = true;
        this._reconnectDelay = 400;
        this.maxPlayers = msg.maxPlayers;
        this.layout = msg.layout;
        this.layoutLocked = !!msg.layoutLocked;
        this._bySlot.clear();
        for (const info of msg.players || []) {
          const p = new Player(info, this);
          if (info.state) {
            Object.assign(p.buttons, info.state.buttons || {});
            Object.assign(p.axes, info.state.axes || {});
          }
          this._bySlot.set(p.slot, p);
        }
        this._emit('connect', this);
        for (const p of this.players) this._emit('join', p);
        resolve?.(this);
        break;
      }
      case 'join': {
        const p = new Player(msg.player, this);
        this._bySlot.set(p.slot, p);
        this._emit('join', p);
        break;
      }
      case 'leave': {
        const p = this._bySlot.get(msg.slot);
        if (p) { this._bySlot.delete(msg.slot); this._emit('leave', p); }
        break;
      }
      case 'player': {
        const p = this._bySlot.get(msg.player.slot);
        if (p) {
          p.name = msg.player.name;
          p.color = msg.player.color;
          this._emit('player', p);
        }
        break;
      }
      case 'input': {
        const p = this._bySlot.get(msg.slot);
        if (!p) break;
        const edges = p._applyInput(msg.btn, msg.ax);
        for (const b of edges.pressed) this._emit('press', p, b);
        for (const b of edges.released) this._emit('release', p, b);
        break;
      }
      case 'layout':
        this.layout = msg;
        this._emit('layout', msg);
        break;
      case 'config':
        if (msg.maxPlayers) this.maxPlayers = msg.maxPlayers;
        if (msg.layoutLocked !== undefined) this.layoutLocked = !!msg.layoutLocked;
        break;
      case 'error':
        this._emit('error', msg.reason);
        break;
      default: break;
    }
  }
}

function buildUrl({ host, port } = {}) {
  const loc = globalThis.location;
  const secure = loc?.protocol === 'https:';

  // A page served over https cannot open a plain ws:// connection at all -
  // browsers block that outright. So a hosted game has to reach PocketJoy
  // through its own origin (the usual reverse-proxy setup), not on port 3070.
  // Only a page served over http talks to the LAN server on its own port.
  if (secure && !host && !port) return `wss://${loc.host}/ws`;

  const h = host || loc?.hostname || 'localhost';
  const p = port ? `:${port}` : (secure ? '' : `:${DEFAULT_PORT}`);
  return `${secure ? 'wss' : 'ws'}://${h}${p}/ws`;
}

export default PocketJoy;
