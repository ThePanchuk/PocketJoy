/**
 * WebRTC transport for PocketJoy.
 *
 * Why this exists: a game served over https cannot open a ws:// connection to
 * a server in the local network - browsers block that outright. WebRTC is not
 * affected by that rule, so a hosted game (itch.io and friends) can still talk
 * to phones in the same room, directly and without anything installed.
 *
 * The signalling server is only used to introduce the two sides. Once the data
 * channel is up, input flows straight from phone to game.
 *
 * Nothing here knows about buttons or layouts: it moves the same JSON messages
 * the WebSocket transport moves, so hub.js and the pad work unchanged.
 */

/** No STUN/TURN by default: inside one WLAN the local candidates suffice,
 *  and we do not want to hand a third party a list of who is playing. */
export const DEFAULT_ICE = [];

/** Data channel settings for input: fast and unordered beats complete. */
const CHANNEL_OPTIONS = { ordered: false, maxRetransmits: 0 };

/**
 * Wrap a data channel so hub.js can treat it like a `ws` socket.
 * (readyState as a number, .on(event, cb), .send(string))
 */
export function asHubSocket(channel) {
  const handlers = { message: [], close: [], error: [] };
  const emit = (event, arg) => {
    for (const cb of handlers[event] || []) {
      try { cb(arg); } catch (err) { console.error('[pocketjoy]', err); }
    }
  };

  channel.addEventListener('message', (e) => emit('message', e.data));
  channel.addEventListener('close', () => emit('close'));
  channel.addEventListener('error', (e) => emit('error', e));

  return {
    get readyState() { return channel.readyState === 'open' ? 1 : 0; },
    send(data) { if (channel.readyState === 'open') channel.send(data); },
    close() { try { channel.close(); } catch { /* already gone */ } },
    on(event, cb) { (handlers[event] ||= []).push(cb); },
  };
}

/**
 * Wrap a data channel so the pad can treat it like a WebSocket.
 * (onopen/onmessage/onclose, numeric readyState)
 */
export function asWebSocketLike(channel) {
  const fake = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    get readyState() { return channel.readyState === 'open' ? 1 : 3; },
    send(data) { if (channel.readyState === 'open') channel.send(data); },
    close() { try { channel.close(); } catch { /* already gone */ } },
  };

  channel.addEventListener('open', () => fake.onopen?.());
  channel.addEventListener('message', (e) => fake.onmessage?.({ data: e.data }));
  channel.addEventListener('close', () => fake.onclose?.());
  channel.addEventListener('error', (e) => fake.onerror?.(e));
  if (channel.readyState === 'open') queueMicrotask(() => fake.onopen?.());

  return fake;
}

/**
 * Which route a connection actually took.
 *
 * Worth showing: a player going through a relay feels noticeably laggier than
 * one in the same WLAN, and without this you are left guessing why.
 *
 * Returns { via, label, rtt } where via is:
 *   'lan'      both sides on the same network - the fast case
 *   'internet' direct, but across networks (via STUN)
 *   'relay'    everything through a TURN server - works always, costs latency
 */
export async function describeConnection(pc) {
  if (!pc || typeof pc.getStats !== 'function') return { via: 'unknown', label: 'unbekannt' };

  let stats;
  try { stats = await pc.getStats(); } catch { return { via: 'unknown', label: 'unbekannt' }; }

  let pair = null;
  stats.forEach((report) => {
    if (report.type !== 'candidate-pair') return;
    if (report.state !== 'succeeded') return;
    if (report.nominated || report.selected || !pair) pair = report;
  });
  if (!pair) return { via: 'unknown', label: 'unbekannt' };

  const local = stats.get?.(pair.localCandidateId);
  const remote = stats.get?.(pair.remoteCandidateId);
  const types = [local?.candidateType, remote?.candidateType];
  const rtt = typeof pair.currentRoundTripTime === 'number'
    ? Math.round(pair.currentRoundTripTime * 1000)
    : null;

  if (types.includes('relay')) return { via: 'relay', label: 'über Relais', rtt };
  if (types.every((t) => t === 'host')) return { via: 'lan', label: 'direkt im WLAN', rtt };
  return { via: 'internet', label: 'direkt über Internet', rtt };
}

/**
 * The side that waits for a phone (the game).
 *
 * @param {object} opts
 * @param {(msg:object)=>void} opts.send        send a signalling message to the peer
 * @param {(channel:RTCDataChannel)=>void} opts.onChannel  called once the channel is open
 * @param {(state:string)=>void} [opts.onState]
 * @param {RTCIceServer[]} [opts.iceServers]
 */
export function createAnsweringPeer({ send, onChannel, onState, iceServers = DEFAULT_ICE }) {
  const pc = new RTCPeerConnection({ iceServers });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) send({ t: 'ice', candidate: e.candidate.toJSON() });
  });
  pc.addEventListener('connectionstatechange', () => onState?.(pc.connectionState));
  pc.addEventListener('datachannel', (e) => {
    const channel = e.channel;
    if (channel.readyState === 'open') onChannel(channel);
    else channel.addEventListener('open', () => onChannel(channel));
  });

  return {
    pc,
    /** Feed a signalling message that arrived for this peer. */
    async handle(msg) {
      if (msg.t === 'offer') {
        await pc.setRemoteDescription(msg.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        send({ t: 'answer', sdp: pc.localDescription.toJSON() });
      } else if (msg.t === 'ice' && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch { /* late candidate */ }
      }
    },
    close() { try { pc.close(); } catch { /* already gone */ } },
  };
}

/**
 * The side that reaches out (the phone).
 * Creates the data channel and sends the offer straight away.
 */
export function createOfferingPeer({ send, onChannel, onState, iceServers = DEFAULT_ICE }) {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel('pocketjoy', CHANNEL_OPTIONS);

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) send({ t: 'ice', candidate: e.candidate.toJSON() });
  });
  pc.addEventListener('connectionstatechange', () => onState?.(pc.connectionState));
  channel.addEventListener('open', () => onChannel(channel));

  const ready = (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send({ t: 'offer', sdp: pc.localDescription.toJSON() });
  })();

  return {
    pc,
    channel,
    ready,
    async handle(msg) {
      if (msg.t === 'answer') {
        // Ignore a stale answer that arrives after we moved on.
        if (pc.signalingState === 'stable') return;
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.t === 'ice' && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch { /* late candidate */ }
      }
    },

    /**
     * Negotiate the route again, keeping the open data channel.
     *
     * This is what rescues a phone that changed network - from WLAN to mobile
     * data, say. The addresses it announced before are gone, so it gathers new
     * ones and both sides agree on a new path. Much cheaper than tearing
     * everything down: the player keeps playing instead of rejoining.
     */
    async restart() {
      if (pc.connectionState === 'closed') return false;
      try {
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
        send({ t: 'offer', sdp: pc.localDescription.toJSON() });
        return true;
      } catch {
        return false;
      }
    },

    close() { try { pc.close(); } catch { /* already gone */ } },
  };
}
