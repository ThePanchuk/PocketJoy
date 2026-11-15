/**
 * PocketJoy, web mode - for games that are hosted somewhere (itch.io, your own
 * site) instead of being served from a PocketJoy server on the local machine.
 *
 * Nobody installs anything. The game page itself runs the hub, and the phones
 * connect to it directly over WebRTC. A small signalling service only
 * introduces the two sides; it never sees any input.
 *
 *   import { PocketJoyWeb } from './pocketjoy-web.js';
 *
 *   const pj = new PocketJoyWeb({
 *     signaling: 'wss://pocketjoy.example.com/signal',
 *     layout: 'dual-stick',
 *     maxPlayers: 4,
 *   });
 *   await pj.connect();
 *
 *   console.log(pj.room);      // "K7M2" - the code players type
 *   console.log(pj.padUrl);    // the link / QR target for phones
 *
 * From here on it behaves exactly like the normal PocketJoy class: pj.players,
 * p.down(), p.pressed(), p.stick(), pj.update() - the same game code works in
 * both modes.
 */

import { PocketJoy } from './pocketjoy.js';
import { Hub } from '../shared/hub.js';
import {
  asHubSocket, createAnsweringPeer, describeConnection, DEFAULT_ICE,
} from '../shared/rtc.js';

/**
 * A pair of connected in-memory sockets.
 *
 * One end looks like a `ws` socket (what the hub expects), the other like a
 * browser WebSocket (what the client library expects). This is how the game
 * talks to a hub that lives in the same page - no network in between.
 */
function localPair() {
  const hubHandlers = {};
  const gameListeners = {};
  let open = true;

  const hubSide = {
    get readyState() { return open ? 1 : 3; },
    send(data) { if (open) queueMicrotask(() => emitGame('message', { data })); },
    close() { if (!open) return; open = false; queueMicrotask(() => emitGame('close', {})); },
    on(event, cb) { (hubHandlers[event] ||= []).push(cb); },
  };

  const gameSide = {
    get readyState() { return open ? 1 : 3; },
    send(data) { if (open) queueMicrotask(() => emitHub('message', data)); },
    close() { if (!open) return; open = false; queueMicrotask(() => emitHub('close')); },
    addEventListener(event, cb) { (gameListeners[event] ||= []).push(cb); },
  };

  const emitHub = (event, arg) => {
    for (const cb of hubHandlers[event] || []) cb(arg);
  };
  const emitGame = (event, arg) => {
    for (const cb of gameListeners[event] || []) cb(arg);
  };

  // The client library waits for 'open' before saying hello.
  queueMicrotask(() => emitGame('open', {}));
  return { hubSide, gameSide };
}

export class PocketJoyWeb extends PocketJoy {
  /**
   * @param {object} opts
   * @param {string} [opts.signaling]  wss:// address of the signalling service.
   *        Defaults to /signal on the page's own host.
   * @param {string} [opts.room]       ask for a specific code (e.g. to keep the
   *        same one across a page reload)
   * @param {string} [opts.padUrlBase] where phones should open the controller.
   *        Defaults to the signalling host's /pad.
   * @param {RTCIceServer[]} [opts.iceServers]  only needed for players outside
   *        the local network; empty by default, so nothing leaves the WLAN.
   * @param {string|object} [opts.layout]
   * @param {number} [opts.maxPlayers]
   * @param {boolean} [opts.lockLayout]
   */
  constructor(opts = {}) {
    super({
      ...opts,
      autoReconnect: false,
      createSocket: () => this._pair.gameSide,
    });

    this.signalingUrl = opts.signaling || defaultSignaling();
    this.iceServers = opts.iceServers || DEFAULT_ICE;

    /** The code players type in. Available after connect(). */
    this.room = null;
    /** Where phones should go. Available after connect(). */
    this.padUrl = null;

    this.hub = new Hub({
      maxPlayers: opts.maxPlayers || 4,
      layout: typeof opts.layout === 'string' ? opts.layout : undefined,
      log: opts.verbose ? (m) => console.log('[pocketjoy]', m) : () => {},
    });

    this._pair = null;
    this._signal = null;
    this._peers = new Map();     // peerId -> { peer, socket }
    this._wantedRoom = opts.room || null;
  }

  /**
   * Open a room and start listening for phones.
   * Resolves once the room code is known.
   */
  async connect() {
    this._pair = localPair();
    // The game's own connection to its hub, as a normal consumer.
    this.hub.attach(this._pair.hubSide, 'local');
    await super.connect();

    // A game layout given as an object has to go through the normal path.
    if (this.opts.layout && typeof this.opts.layout === 'object') {
      this.setLayout(this.opts.layout, this.opts.lockLayout);
    }

    await this._openSignaling();
    return this;
  }

  disconnect() {
    for (const { peer, socket } of this._peers.values()) {
      try { socket.close(); } catch { /* gone */ }
      peer.close();
    }
    this._peers.clear();
    try { this._signal?.close(); } catch { /* gone */ }
    this._signal = null;
    super.disconnect();
  }

  // ------------------------------------------------------------- signalling

  _openSignaling() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.signalingUrl); } catch (err) { return reject(err); }
      this._signal = ws;

      const fail = setTimeout(() => reject(new Error(
        `PocketJoy: Signaling-Dienst ${this.signalingUrl} antwortet nicht.`,
      )), 10000);

      ws.onopen = () => ws.send(JSON.stringify({ t: 'host', code: this._wantedRoom || undefined }));

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.t === 'room') {
          clearTimeout(fail);
          // Own setting wins; otherwise take what the service offers, so
          // TURN is configured in one place instead of in every game.
          if (!this.opts.iceServers && Array.isArray(msg.iceServers)) {
            this.iceServers = msg.iceServers;
          }
          this.room = msg.code;
          this._wantedRoom = msg.code;
          this.padUrl = this._buildPadUrl(msg.code);
          this._emit('room', msg.code, this.padUrl);
          resolve(this);
        } else if (msg.t === 'peer-joined') {
          this._addPeer(msg.peer);
        } else if (msg.t === 'peer-left') {
          this._dropPeer(msg.peer);
        } else if (msg.t === 'signal') {
          this._peers.get(msg.from)?.peer.handle(msg.data);
        } else if (msg.t === 'error') {
          this._emit('error', msg.reason);
        }
      };

      ws.onclose = () => {
        clearTimeout(fail);
        // Phones already connected keep playing - their channels are direct.
        this._emit('signaling-lost');
      };
      ws.onerror = () => { /* close follows */ };
    });
  }

  _buildPadUrl(code) {
    if (this.opts.padUrlBase) {
      const base = this.opts.padUrlBase.replace(/\/$/, '');
      return `${base}?room=${code}`;
    }
    try {
      const u = new URL(this.signalingUrl);
      const scheme = u.protocol === 'wss:' ? 'https:' : 'http:';
      return `${scheme}//${u.host}/pad?room=${code}`;
    } catch {
      return `/pad?room=${code}`;
    }
  }

  // ----------------------------------------------------------------- peers

  _addPeer(peerId) {
    if (this._peers.has(peerId)) return;

    const peer = createAnsweringPeer({
      iceServers: this.iceServers,
      send: (data) => this._signalTo(peerId, data),
      onChannel: (channel) => {
        const socket = asHubSocket(channel);
        this._peers.get(peerId).socket = socket;
        // From here the phone is an ordinary pad as far as the hub cares.
        this.hub.attach(socket, `rtc:${peerId}`);
        this._noteConnection(peerId);
      },
      onState: (state) => {
        const entry = this._peers.get(peerId);
        if (!entry) return;

        if (state === 'connected') {
          // Back on its feet (possibly on a new route) - cancel the eviction
          // and find out which way it goes now.
          clearTimeout(entry.evictAt);
          entry.evictAt = null;
          this._noteConnection(peerId);
          return;
        }

        if (state === 'closed') return this._dropPeer(peerId);

        if (state === 'failed') {
          // Do not evict straight away: a phone that changed network tries to
          // renegotiate, and that needs its peer to still exist here.
          if (entry.evictAt) return;
          entry.evictAt = setTimeout(() => this._dropPeer(peerId), 10000);
        }
      },
    });

    this._peers.set(peerId, { peer, socket: null, info: null, evictAt: null });
  }

  /**
   * Find out which route this phone took and remember it on its player.
   *
   * Done a moment after the channel opens, because ICE often upgrades to a
   * better pair right after the first working one.
   */
  async _noteConnection(peerId) {
    const entry = this._peers.get(peerId);
    if (!entry) return;

    const look = async () => {
      const current = this._peers.get(peerId);
      if (!current) return;
      const info = await describeConnection(current.peer.pc);
      current.info = info;

      // Attach it to whichever player this phone became.
      for (const p of this.players) {
        if (this._slotOfPeer(peerId) === p.slot) {
          p.connection = info;
          this._emit('connection', p, info);
        }
      }
    };

    setTimeout(look, 500);
    setTimeout(look, 3000);
  }

  /** Which slot does this peer's socket belong to? */
  _slotOfPeer(peerId) {
    const socket = this._peers.get(peerId)?.socket;
    if (!socket) return null;
    for (const [slot, player] of this.hub.players) {
      if (player.socket === socket) return slot;
    }
    return null;
  }

  /** Connection route for a player, once known. */
  connectionOf(slot) {
    for (const [peerId, entry] of this._peers) {
      if (this._slotOfPeer(peerId) === Number(slot)) return entry.info || null;
    }
    return null;
  }

  _dropPeer(peerId) {
    const entry = this._peers.get(peerId);
    if (!entry) return;
    this._peers.delete(peerId);
    clearTimeout(entry.evictAt);
    try { entry.socket?.close(); } catch { /* gone */ }
    entry.peer.close();
  }

  _signalTo(peerId, data) {
    if (this._signal?.readyState === 1) {
      this._signal.send(JSON.stringify({ t: 'signal', to: peerId, data }));
    }
  }
}

function defaultSignaling() {
  const loc = globalThis.location;
  if (!loc) return 'ws://localhost:3070/signal';
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/signal`;
}

export default PocketJoyWeb;
