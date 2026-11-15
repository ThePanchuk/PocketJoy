/**
 * Signalling for the WebRTC mode.
 *
 * This is the only part that has to be reachable from the internet if you
 * host your game somewhere like itch.io - and it is deliberately tiny: it
 * introduces a phone to a game and then gets out of the way. It never sees
 * button presses, player names or layouts.
 *
 * A room is identified by a short code the host shows on screen. Without the
 * code nobody can join, which replaces the "same WLAN" boundary that the
 * WebSocket mode relies on.
 *
 * Messages (JSON over WebSocket on /signal):
 *   host -> {t:'host'}                 <- {t:'room', code}
 *   pad  -> {t:'join', code}           <- {t:'joined', peer} | {t:'no-room'}
 *   both -> {t:'signal', to?, data}    -> delivered as {t:'signal', from, data}
 */

import { roomCode } from '../shared/ids.js';

/** Rooms disappear this long after the host is gone. */
const ROOM_GRACE_MS = 60 * 1000;
const MAX_ROOMS = 200;
const MAX_PEERS_PER_ROOM = 16;

export class SignalingServer {
  /**
   * @param {object} opts
   * @param {() => {servers: RTCIceServer[]}} [opts.iceServers]  called per
   *        connection, so time-limited TURN credentials stay fresh.
   */
  constructor({ log = () => {}, iceServers = null } = {}) {
    this.rooms = new Map();   // code -> { code, host, peers: Map, closingAt }
    this.log = log;
    this.iceServers = iceServers;
  }

  /**
   * ICE servers for one side.
   *
   * Both the game and the phones get them from here, so the credentials live
   * in one place and never sit in the page source. Phones especially need
   * them: a phone on mobile data is the side that has to offer the relay
   * route, and it cannot do that if it does not know the server.
   */
  ice(label) {
    if (!this.iceServers) return [];
    try { return this.iceServers(label).servers || []; }
    catch { return []; }
  }

  send(socket, msg) {
    if (socket?.readyState === 1) {
      try { socket.send(JSON.stringify(msg)); } catch { /* gone */ }
    }
  }

  freshCode() {
    for (let len = 4; len <= 6; len++) {
      for (let i = 0; i < 40; i++) {
        const code = roomCode(len);
        if (!this.rooms.has(code)) return code;
      }
    }
    return null;
  }

  attach(socket) {
    const conn = { socket, role: null, room: null, peerId: null };

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { this.handle(conn, msg); } catch (err) { this.log(`signal error: ${err.message}`); }
    });

    socket.on('close', () => this.detach(conn));
    socket.on('error', () => this.detach(conn));
  }

  handle(conn, msg) {
    switch (msg.t) {
      case 'host': return this.openRoom(conn, msg);
      case 'join': return this.joinRoom(conn, msg);
      case 'signal': return this.relay(conn, msg);
      case 'ping': return this.send(conn.socket, { t: 'pong' });
      default: break;
    }
  }

  openRoom(conn, msg) {
    if (conn.room) return;
    if (this.rooms.size >= MAX_ROOMS) {
      return this.send(conn.socket, { t: 'error', reason: 'too-many-rooms' });
    }

    // A host coming back (page reload) may reclaim its own room while the
    // grace period lasts, so players do not have to retype a new code.
    const wanted = typeof msg.code === 'string' ? msg.code.toUpperCase() : null;
    let room = wanted ? this.rooms.get(wanted) : null;
    if (room && room.host && room.host.socket?.readyState === 1) room = null;

    if (!room) {
      const code = this.freshCode();
      if (!code) return this.send(conn.socket, { t: 'error', reason: 'no-code' });
      room = { code, host: null, peers: new Map(), closingAt: null };
      this.rooms.set(code, room);
    }

    clearTimeout(room.closingAt);
    room.closingAt = null;
    room.host = conn;
    conn.role = 'host';
    conn.room = room;

    this.log(`room ${room.code} opened`);
    this.send(conn.socket, { t: 'room', code: room.code, iceServers: this.ice('host') });

    // Tell the host about phones that were already waiting.
    for (const peerId of room.peers.keys()) {
      this.send(conn.socket, { t: 'peer-joined', peer: peerId });
    }
  }

  joinRoom(conn, msg) {
    const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
    const room = this.rooms.get(code);
    if (!room) return this.send(conn.socket, { t: 'no-room', code });
    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      return this.send(conn.socket, { t: 'error', reason: 'room-full' });
    }

    const peerId = `p${Math.random().toString(36).slice(2, 9)}`;
    conn.role = 'pad';
    conn.room = room;
    conn.peerId = peerId;
    room.peers.set(peerId, conn);

    this.send(conn.socket, {
      t: 'joined', peer: peerId, code: room.code, iceServers: this.ice(peerId),
    });
    if (room.host) this.send(room.host.socket, { t: 'peer-joined', peer: peerId });
    this.log(`room ${room.code}: peer ${peerId} joined`);
  }

  /** Pass a signalling message along. Hosts address a peer, peers the host. */
  relay(conn, msg) {
    const room = conn.room;
    if (!room) return;

    if (conn.role === 'host') {
      const target = room.peers.get(msg.to);
      if (target) this.send(target.socket, { t: 'signal', from: 'host', data: msg.data });
    } else if (room.host) {
      this.send(room.host.socket, { t: 'signal', from: conn.peerId, data: msg.data });
    }
  }

  detach(conn) {
    const room = conn.room;
    if (!room) return;
    conn.room = null;

    if (conn.role === 'pad') {
      room.peers.delete(conn.peerId);
      if (room.host) this.send(room.host.socket, { t: 'peer-left', peer: conn.peerId });
      return;
    }

    if (room.host === conn) {
      room.host = null;
      // Keep the room briefly: a reloaded game page gets its code back, and
      // already-connected phones keep playing over their direct channels.
      room.closingAt = setTimeout(() => {
        if (!room.host) {
          this.rooms.delete(room.code);
          this.log(`room ${room.code} closed`);
        }
      }, ROOM_GRACE_MS);
    }
  }
}
