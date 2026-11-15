/**
 * Random ids that work everywhere PocketJoy runs.
 *
 * Node has crypto.randomUUID, and so does a browser - but only in a "secure
 * context". A pad opened over http://192.168.x.x is NOT a secure context, so
 * randomUUID is simply missing there. getRandomValues still exists, and if
 * even that is gone we fall back to Math.random: these ids identify players
 * on a living-room network, they are not secrets.
 */

const crypto = globalThis.crypto;

export function randomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();

  if (crypto?.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;   // version 4
    b[8] = (b[8] & 0x3f) | 0x80;   // variant
    const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return 'id-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * A short code people can read out loud and type on a phone.
 *
 * No 0/O, 1/I/L - those get mistyped constantly when someone reads a code
 * off a TV across the room.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function roomCode(length = 4) {
  const out = [];
  if (crypto?.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(length));
    for (let i = 0; i < length; i++) out.push(CODE_ALPHABET[b[i] % CODE_ALPHABET.length]);
  } else {
    for (let i = 0; i < length; i++) {
      out.push(CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]);
    }
  }
  return out.join('');
}
