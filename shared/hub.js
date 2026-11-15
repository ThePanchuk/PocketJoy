/**
 * PocketJoy hub - the heart of the whole thing.
 *
 * It lives in `shared/` because it runs in two places: inside the Node server
 * for the local mode, and inside the game's own page for the WebRTC mode. It
 * never touches the network itself - it only talks to socket-like objects.
 *
 * Keeps track of connected phones ("pads"), assigns each one a player slot,
 * and forwards their input to every consumer (a game, the lobby page, or the
 * optional system-gamepad bridge).
 *
 * Roles:
 *   pad    - a phone showing the controller UI
 *   game   - your game, using client/pocketjoy.js
 *   host   - the lobby page on the PC
 *   bridge - the Python system-gamepad bridge
 */

import { randomId } from './ids.js';
import {
  AXES, BUTTONS, LAYOUTS, MAX_PLAYERS, SLOT_COLORS,
  DEFAULT_LAYOUT, emptyState, layoutOrDefault, normalizeLayout, PROTOCOL_VERSION,
} from './protocol.js';

const CONSUMER_ROLES = new Set(['game', 'host', 'bridge']);

export class Hub {
  constructor({ maxPlayers = 4, layout = DEFAULT_LAYOUT, log = () => {} } = {}) {
    this.maxPlayers = Math.min(Math.max(1, maxPlayers), MAX_PLAYERS);
    this.log = log;

    /** The layout every pad currently shows (a preset, or a game's own). */
    this.layout = { id: layoutOrDefault(layout), ...LAYOUTS[layoutOrDefault(layout)] };
    /**
     * While a game asked to keep its layout, the lobby cannot switch it away.
     * Set back to false as soon as that game disconnects, so the lobby is
     * usable again.
     */
    this.layoutLocked = false;

    /** slot number (1-based) -> player */
    this.players = new Map();
    /** consumers: Set of { socket, role, name } */
    this.consumers = new Set();

    /**
     * Players who just left, by token and by address.
     *
     * A phone that reloads closes its socket first, so by the time it comes
     * back the player is already gone. Without this the player would return as
     * a nameless newcomer. This keeps slot and name around for a while, which
     * is what makes "reconnect and carry on" work.
     */
    this.recent = new Map();
  }

  /** How long a disconnected player is remembered, in ms. */
  static RECALL_MS = 10 * 60 * 1000;

  remember(p) {
    const entry = { slot: p.slot, name: p.name, named: !!p.named, at: Date.now() };
    if (p.token) this.recent.set(`token:${p.token}`, entry);
    if (p.addr && !p.fresh) this.recent.set(`addr:${p.addr}`, entry);

    // Drop stale entries so this cannot grow forever.
    const cutoff = Date.now() - Hub.RECALL_MS;
    for (const [key, e] of this.recent) {
      if (e.at < cutoff) this.recent.delete(key);
    }
  }

  recall(token, addr, fresh) {
    const keys = [];
    if (token) keys.push(`token:${token}`);
    if (addr && !fresh) keys.push(`addr:${addr}`);
    for (const key of keys) {
      const entry = this.recent.get(key);
      if (entry && Date.now() - entry.at < Hub.RECALL_MS) return entry;
    }
    return null;
  }

  // ---------------------------------------------------------------- helpers

  freeSlot() {
    for (let s = 1; s <= this.maxPlayers; s++) if (!this.players.has(s)) return s;
    return null;
  }

  playerInfo(p) {
    return {
      slot: p.slot,
      id: p.id,
      name: p.name,
      // true once the player typed a name - lets the pad pre-fill its field
      // on a reconnect, even if the phone itself stored nothing.
      named: !!p.named,
      // The main controller may remove players and set the layout for all.
      isHost: !!p.isHost,
      color: SLOT_COLORS[(p.slot - 1) % SLOT_COLORS.length],
      connected: true,
    };
  }

  snapshot() {
    return {
      maxPlayers: this.maxPlayers,
      layoutLocked: this.layoutLocked,
      layout: this.layout,
      players: [...this.players.values()].map((p) => ({
        ...this.playerInfo(p),
        state: p.state,
      })),
    };
  }

  /**
   * The main controller: whoever holds the lowest seat.
   *
   * "First one connected" in practice, because seats are handed out in order,
   * and it stays predictable when people come and go - player 1 is in charge.
   * If they leave, the next one takes over rather than leaving nobody able to
   * manage the round.
   */
  hostSlot() {
    let lowest = null;
    for (const slot of this.players.keys()) {
      if (lowest === null || slot < lowest) lowest = slot;
    }
    return lowest;
  }

  /** Hand the role to whoever should have it, and tell the phones. */
  refreshHost() {
    const slot = this.hostSlot();
    for (const p of this.players.values()) {
      const should = p.slot === slot;
      if (p.isHost === should) continue;
      p.isHost = should;
      this.send(p.socket, { t: 'host', isHost: should });
      this.toConsumers({ t: 'player', player: this.playerInfo(p) });
    }
    this.sendOverview();
  }

  /**
   * Everything the main controller needs to manage the round from its phone:
   * who is playing and which layout is active. Ordinary pads never get this.
   */
  sendOverview() {
    const slot = this.hostSlot();
    const host = slot === null ? null : this.players.get(slot);
    if (!host) return;
    this.send(host.socket, {
      t: 'overview',
      maxPlayers: this.maxPlayers,
      layout: this.layout,
      layoutLocked: this.layoutLocked,
      players: [...this.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => this.playerInfo(p)),
    });
  }

  /** May this connection manage the round? */
  mayManage(conn) {
    if (conn.role !== 'pad') return true;          // games, lobby, bridge
    return !!conn.player?.isHost;                  // the main controller
  }

  send(socket, msg) {
    if (socket.readyState === 1) {
      try { socket.send(JSON.stringify(msg)); } catch { /* socket died mid-send */ }
    }
  }

  toConsumers(msg, { except } = {}) {
    const raw = JSON.stringify(msg);
    for (const c of this.consumers) {
      if (c.socket === except) continue;
      if (c.socket.readyState === 1) {
        try { c.socket.send(raw); } catch { /* ignore */ }
      }
    }
  }

  toPads(msg) {
    for (const p of this.players.values()) this.send(p.socket, msg);
  }

  // ------------------------------------------------------------- connection

  attach(socket, remoteAddr) {
    const conn = { socket, role: null, player: null, consumer: null, addr: remoteAddr };

    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { this.handle(conn, msg); } catch (err) { this.log(`msg error: ${err.message}`); }
    });

    socket.on('close', () => this.detach(conn));
    socket.on('error', () => this.detach(conn));
    return conn;
  }

  detach(conn) {
    if (conn.player) {
      const p = conn.player;
      if (this.players.get(p.slot) === p) {
        this.players.delete(p.slot);
        this.remember(p);
        this.log(`pad left: ${p.name} (slot ${p.slot})`);
        this.toConsumers({ t: 'leave', slot: p.slot, id: p.id });
        this.refreshHost();
      }
      conn.player = null;
    }
    if (conn.consumer) {
      this.consumers.delete(conn.consumer);
      this.log(`${conn.consumer.role} disconnected`);
      conn.consumer = null;
      // The lobby gets control back once no game is holding the layout.
      this.refreshLayoutLock();
    }
  }

  // ----------------------------------------------------------- message pump

  handle(conn, msg) {
    if (msg.t === 'hello') return this.onHello(conn, msg);
    if (!conn.role) return; // must say hello first

    switch (msg.t) {
      case 'input':  return this.onInput(conn, msg);
      case 'name':   return this.onName(conn, msg);
      case 'layout': return this.onLayout(conn, msg);
      case 'rumble': return this.onRumble(conn, msg);
      case 'kick':   return this.onKick(conn, msg);
      case 'ping':   return this.send(conn.socket, { t: 'pong', time: msg.time });
      default: break;
    }
  }

  onHello(conn, msg) {
    const role = msg.role === 'pad'
      ? 'pad'
      : CONSUMER_ROLES.has(msg.role) ? msg.role : null;
    if (!role) return this.send(conn.socket, { t: 'error', reason: 'unknown-role' });
    conn.role = role;

    if (role === 'pad') return this.joinPad(conn, msg);

    // A consumer: game, lobby or bridge.
    const consumer = { socket: conn.socket, role, name: String(msg.name || role) };
    conn.consumer = consumer;
    this.consumers.add(consumer);
    this.log(`${role} connected${msg.name ? ': ' + msg.name : ''}`);

    // A game dictates the layout and player count for the whole session.
    if (role === 'game') {
      if (msg.maxPlayers) this.setMaxPlayers(msg.maxPlayers);
      if (msg.layout) {
        const wanted = normalizeLayout(msg.layout);
        if (wanted) {
          consumer.wantsLayout = wanted;
          consumer.locksLayout = msg.lockLayout === true;
          this.setLayout(wanted);
          this.setLayoutLock(consumer.locksLayout);
        } else {
          this.log('game asked for an unusable layout - ignored');
          this.send(conn.socket, { t: 'error', reason: 'bad-layout' });
        }
      }
    }
    this.send(conn.socket, { t: 'welcome', v: PROTOCOL_VERSION, role, ...this.snapshot() });
  }

  joinPad(conn, msg) {
    const token = typeof msg.token === 'string' ? msg.token : null;

    /**
     * One device = one player.
     *
     * A phone is identified by the token it stores locally, and by its address
     * if it has no token yet (private mode, storage blocked). A second tab on
     * the same phone therefore does NOT become a second player.
     *
     * `fresh` opts out of this - the pad sends it for /pad?new, which is how
     * you test several players from one computer.
     */
    const fresh = msg.fresh === true;

    /**
     * Same device as an existing player?
     *
     * Two ways to tell, because a phone connecting for the very first time has
     * no token yet: the token it stored earlier, or its network address. A
     * player who asked for a separate identity (`fresh`) is never matched -
     * otherwise a /pad?new tab would evict a normal one.
     */
    const sameDevice = (p) => {
      if (fresh || p.fresh) return false;
      // A token is a precise identity, so it decides on its own.
      if (token) return p.token === token;
      // No token yet (first visit, or storage blocked): the address is the
      // best identity available. Two phones in one WLAN never share one.
      return p.addr === conn.addr;
    };

    let slot = null;
    let takenOver = null;
    let inheritedName = null;

    // This connection replaces the old one instead of taking a second slot.
    // It also makes reconnecting instant - no waiting for the dead socket to
    // time out first.
    for (const p of this.players.values()) {
      if (sameDevice(p)) {
        slot = p.slot;
        takenOver = p;
        inheritedName = p.name;
        break;
      }
    }

    // Not currently playing - but maybe this phone was here a moment ago and
    // just reloaded. Then it gets its slot and its name back.
    let inheritedNamed = false;
    if (slot === null) {
      const memory = this.recall(token, conn.addr, fresh);
      if (memory) {
        inheritedName = memory.name;
        inheritedNamed = memory.named;
        if (!this.players.has(memory.slot) && memory.slot <= this.maxPlayers) {
          slot = memory.slot;
        }
      }
    }
    if (slot === null) slot = this.freeSlot();

    if (slot === null) {
      this.send(conn.socket, { t: 'full', maxPlayers: this.maxPlayers });
      return;
    }

    const myToken = (!fresh && token) || randomId();
    const givenName = (typeof msg.name === 'string' && msg.name.trim())
      ? msg.name.trim().slice(0, 16)
      : null;

    const player = {
      slot,
      id: randomId(),
      token: myToken,
      addr: conn.addr,
      fresh,
      name: givenName || inheritedName || `Spieler ${slot}`,
      named: !!givenName || (takenOver ? takenOver.named : inheritedNamed),
      socket: conn.socket,
      state: emptyState(),
      lastSeq: -1,
    };

    this.players.set(slot, player);
    conn.player = player;

    // Replace the old connection only now that the slot belongs to the new
    // one - its close handler sees that and leaves the player alone.
    if (takenOver) {
      this.send(takenOver.socket, { t: 'takeover' });
      try { takenOver.socket.close(); } catch { /* already gone */ }
      this.log(`pad reconnected: ${player.name} (slot ${slot}) from ${conn.addr}`);
      this.send(conn.socket, {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        role: 'pad',
        token: myToken,
        ...this.playerInfo(player),
        layout: this.layout,
      });
      // The player never left, so tell consumers about the update, not a join.
      this.toConsumers({ t: 'player', player: this.playerInfo(player) });
      this.refreshHost();
      return;
    }

    this.log(`pad joined: ${player.name} (slot ${slot}) from ${conn.addr}`);

    this.send(conn.socket, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      role: 'pad',
      token: myToken,
      ...this.playerInfo(player),
      layout: this.layout,
    });
    this.toConsumers({ t: 'join', player: this.playerInfo(player) });
    this.refreshHost();
  }

  onInput(conn, msg) {
    const p = conn.player;
    if (!p) return;

    /**
     * Packet order and loss.
     *
     * Over WebRTC the channel is deliberately unreliable - waiting for a lost
     * packet would stall everything behind it, and a stale input is worthless
     * anyway. But this protocol sends only CHANGES, so a lost packet leaves
     * the two sides disagreeing: miss a "button released" and that button
     * stays down forever.
     *
     * So: ignore anything stale, and when the numbering jumps, ask the phone
     * for its full state.
     */
    if (typeof msg.seq === 'number') {
      if (msg.full) {
        // A full state is the truth by definition - take it and resync.
        p.lastSeq = msg.seq;
        p.resyncPending = false;
      } else {
        if (msg.seq <= p.lastSeq && p.lastSeq - msg.seq < 1000) return;
        if (p.lastSeq >= 0 && msg.seq > p.lastSeq + 1) this.requestResync(p);
        p.lastSeq = msg.seq;
      }
    }

    const btn = {};
    const ax = {};

    if (msg.btn && typeof msg.btn === 'object') {
      for (const [k, v] of Object.entries(msg.btn)) {
        if (!BUTTONS.includes(k)) continue;
        const down = !!v;
        if (p.state.buttons[k] !== down) {
          p.state.buttons[k] = down;
          btn[k] = down;
        }
      }
    }
    if (msg.ax && typeof msg.ax === 'object') {
      for (const [k, v] of Object.entries(msg.ax)) {
        if (!AXES.includes(k) || typeof v !== 'number' || Number.isNaN(v)) continue;
        const lo = (k === 'lt' || k === 'rt') ? 0 : -1;
        const val = Math.max(lo, Math.min(1, v));
        if (Math.abs(p.state.axes[k] - val) > 0.002) {
          p.state.axes[k] = val;
          ax[k] = val;
        }
      }
    }

    if (!Object.keys(btn).length && !Object.keys(ax).length) return;
    this.toConsumers({ t: 'input', slot: p.slot, id: p.id, btn, ax });
  }

  /**
   * Ask a phone to send everything it currently holds.
   *
   * Throttled: a burst of loss would otherwise trigger a request per packet,
   * and the answer takes a moment to arrive anyway.
   */
  requestResync(p) {
    const now = Date.now();
    if (p.resyncAt && now - p.resyncAt < 300) return;
    p.resyncAt = now;
    p.resyncPending = true;
    this.send(p.socket, { t: 'resync' });
  }

  onName(conn, msg) {
    const p = conn.player;
    if (!p || typeof msg.name !== 'string') return;
    const name = msg.name.trim().slice(0, 16);
    if (!name) return;
    p.name = name;
    p.named = true;
    this.toConsumers({ t: 'player', player: this.playerInfo(p) });
    this.sendOverview();
    this.send(conn.socket, { t: 'player', ...this.playerInfo(p) });
  }

  onLayout(conn, msg) {
    // Ordinary pads never choose a layout; the main controller may.
    if (!this.mayManage(conn)) return;

    // While a game insists on its layout, the lobby may not override it -
    // otherwise a stray click would hand everyone the wrong controller
    // mid-game. The game itself always may.
    if (conn.role !== 'game' && this.layoutLocked) {
      this.send(conn.socket, { t: 'error', reason: 'layout-locked' });
      return;
    }

    const wanted = normalizeLayout(msg.layout ?? msg.id);
    if (!wanted) return;

    if (conn.role === 'game' && conn.consumer) {
      conn.consumer.wantsLayout = wanted;
      if (msg.lockLayout !== undefined) {
        conn.consumer.locksLayout = msg.lockLayout === true;
        this.setLayoutLock(conn.consumer.locksLayout);
      }
    }
    this.setLayout(wanted);
  }

  setLayout(layout) {
    const next = normalizeLayout(layout);
    if (!next) return;
    // Same preset again is a no-op; a custom layout may have changed inside.
    if (!next.custom && next.id === this.layout.id) return;

    this.layout = next;
    this.log(`layout -> ${next.id}${next.custom ? ' (eigenes)' : ''}`);
    this.toPads({ t: 'layout', ...next });
    this.toConsumers({ t: 'layout', ...next });
    this.sendOverview();
  }

  setLayoutLock(locked) {
    if (this.layoutLocked === locked) return;
    this.layoutLocked = locked;
    this.toConsumers({ t: 'config', layoutLocked: locked });
    this.sendOverview();
  }

  /** Any game still insisting on its layout? Called when a consumer leaves. */
  refreshLayoutLock() {
    for (const c of this.consumers) {
      if (c.role === 'game' && c.locksLayout) return;
    }
    this.setLayoutLock(false);
  }

  setMaxPlayers(n) {
    const next = Math.min(Math.max(1, Number(n) || 4), MAX_PLAYERS);
    if (next === this.maxPlayers) return;
    this.maxPlayers = next;
    // Disconnect anyone above the new limit.
    for (const [slot, p] of [...this.players]) {
      if (slot > next) {
        this.send(p.socket, { t: 'full', maxPlayers: next });
        p.socket.close();
      }
    }
    this.toConsumers({ t: 'config', maxPlayers: next });
    this.sendOverview();
  }

  onRumble(conn, msg) {
    if (!this.mayManage(conn)) return;
    const ms = Math.min(2000, Math.max(10, Number(msg.ms) || 150));
    const strength = Math.min(1, Math.max(0, Number(msg.strength ?? 1)));
    if (msg.slot === undefined || msg.slot === null || msg.slot === 'all') {
      this.toPads({ t: 'rumble', ms, strength });
    } else {
      const p = this.players.get(Number(msg.slot));
      if (p) this.send(p.socket, { t: 'rumble', ms, strength });
    }
  }

  /**
   * Remove a player: free the slot and disconnect that phone.
   *
   * The phone is told why, so it stays on its start screen instead of
   * reconnecting straight away. Whoever was removed can still join again by
   * hand - this frees a seat, it does not ban a device.
   */
  onKick(conn, msg) {
    if (!this.mayManage(conn)) return;
    const p = this.players.get(Number(msg.slot));
    if (!p) return;
    // The main controller cannot remove itself - that would only orphan the
    // round and surprise whoever tapped it.
    if (conn.player && conn.player === p) return;

    this.log(`pad removed: ${p.name} (slot ${p.slot})`);
    this.forget(p);
    this.send(p.socket, { t: 'kicked' });

    // Drop the player here rather than waiting for the socket to close, so
    // the seat is free the moment the host clicks.
    if (this.players.get(p.slot) === p) {
      this.players.delete(p.slot);
      this.toConsumers({ t: 'leave', slot: p.slot, id: p.id });
      this.refreshHost();
    }
    setTimeout(() => { try { p.socket.close(); } catch { /* gone */ } }, 50);
  }

  /** Forget a player's slot and name, so they come back as a newcomer. */
  forget(p) {
    if (p.token) this.recent.delete(`token:${p.token}`);
    if (p.addr) this.recent.delete(`addr:${p.addr}`);
  }
}
