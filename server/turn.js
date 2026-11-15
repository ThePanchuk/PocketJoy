/**
 * ICE configuration for the web mode: STUN and TURN.
 *
 * Who needs what:
 *   - Everyone in the same WLAN       nothing at all (local candidates match)
 *   - Players on a different network  STUN, usually enough
 *   - Players behind a strict NAT,
 *     mobile data, or a guest WLAN
 *     with client isolation           TURN, a relay for everything
 *
 * Nothing is configured by default, on purpose: without a TURN server no
 * third party learns who is playing, and a living-room game never needs one.
 *
 * Credentials are NOT put in the page. TURN servers work with short-lived
 * credentials derived from a shared secret (the scheme coturn calls its REST
 * API): the username is an expiry timestamp, the password an HMAC of it. The
 * secret stays on this server; what a phone receives stops working after a
 * few hours, so a leaked link cannot turn your relay into a free service for
 * strangers.
 *
 * Configure via environment variables:
 *   POCKETJOY_STUN         stun:stun.example.com:3478   (comma separated)
 *   POCKETJOY_TURN         turn:turn.example.com:3478   (comma separated)
 *   POCKETJOY_TURN_SECRET  the shared secret from the TURN server
 *   POCKETJOY_TURN_TTL     how long credentials last, in seconds (default 3600)
 *   POCKETJOY_TURN_USER    static user, only for servers without a secret
 *   POCKETJOY_TURN_PASS    static password (same case)
 */

import { createHmac } from 'node:crypto';

const list = (value) => String(value || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function readTurnConfig(env = process.env) {
  return {
    stun: list(env.POCKETJOY_STUN),
    turn: list(env.POCKETJOY_TURN),
    secret: env.POCKETJOY_TURN_SECRET || null,
    ttl: Math.max(60, Number(env.POCKETJOY_TURN_TTL) || 3600),
    user: env.POCKETJOY_TURN_USER || null,
    pass: env.POCKETJOY_TURN_PASS || null,
  };
}

/**
 * Build the iceServers list handed to a phone or a game.
 * Returns [] when nothing is configured - which is the normal local case.
 */
export function buildIceServers(config, label = 'pocketjoy') {
  const servers = [];

  if (config.stun.length) servers.push({ urls: config.stun });

  if (config.turn.length) {
    if (config.secret) {
      const expires = Math.floor(Date.now() / 1000) + config.ttl;
      const username = `${expires}:${label}`;
      const credential = createHmac('sha1', config.secret).update(username).digest('base64');
      servers.push({ urls: config.turn, username, credential });
    } else if (config.user && config.pass) {
      servers.push({ urls: config.turn, username: config.user, credential: config.pass });
    } else {
      // A TURN address without credentials is useless - say so rather than
      // letting connections fail mysteriously later.
      return { servers, warning: 'TURN ist konfiguriert, aber ohne Zugangsdaten (POCKETJOY_TURN_SECRET oder POCKETJOY_TURN_USER/PASS).' };
    }
  }

  return { servers };
}

/** One line for the startup banner. */
export function describeTurnConfig(config) {
  if (!config.stun.length && !config.turn.length) return null;
  const parts = [];
  if (config.stun.length) parts.push(`STUN: ${config.stun.join(', ')}`);
  if (config.turn.length) {
    const how = config.secret ? 'Zugangsdaten auf Zeit' : (config.user ? 'feste Zugangsdaten' : 'OHNE Zugangsdaten');
    parts.push(`TURN: ${config.turn.join(', ')} (${how})`);
  }
  return parts.join('   ');
}
