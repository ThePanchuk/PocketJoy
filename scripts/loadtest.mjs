/**
 * How many controllers can one round actually carry?
 *
 * Simulates phones that behave like real ones: input at 60 Hz, only changed
 * values, plus the periodic full state. Measures what matters for a
 * controller - how long an input needs to reach the game, and whether that
 * holds up under load.
 *
 *   node scripts/loadtest.mjs            # 4, 8, 16, 24, 32 controllers
 *   node scripts/loadtest.mjs 64         # one specific number
 *
 * Measured against the local (WebSocket) mode. The web mode adds one WebRTC
 * connection per phone inside the game's browser tab, which costs more.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { PocketJoy } from '../client/pocketjoy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3400 + Math.floor(Math.random() * 100);
const SECONDS = 3;
const RATE_HZ = 60;

const counts = process.argv[2]
  ? [Number(process.argv[2])]
  : [4, 8, 16, 32, 48];
const MOST = Math.max(...counts);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  process.execPath,
  [path.join(ROOT, 'server', 'index.js'), '--port', String(PORT), '--players', String(Math.min(MOST, 64))],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
process.on('exit', () => server.kill());

// Wait for it to come up.
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
  } catch { /* not yet */ }
  await sleep(100);
}

console.log(`\nLasttest - ${SECONDS}s je Stufe, ${RATE_HZ} Pakete/s pro Controller\n`);
console.log('  Controller   Pakete/s   Verzoegerung (Median / 95% / max)   Verloren');
console.log('  (Pakete/s = tatsaechlich erreicht; die Sendeschleife schafft');
console.log('   unter Windows keine vollen 60 Hz pro Controller)');

for (const count of counts) {
  const pads = [];
  const game = new PocketJoy({ host: '127.0.0.1', port: PORT, name: 'last', maxPlayers: Math.min(MOST, 64) });
  await game.connect();

  const latencies = [];
  let sent = 0;
  let received = 0;

  // Each phone stamps its packet; the game reads the stamp back out.
  game.on('press', (player) => {
    const stamp = pads[player.slot - 1]?.stamp;
    if (stamp) { latencies.push(performance.now() - stamp); received++; }
  });

  // Connect them all at once - one after another takes minutes at 32.
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const pad = { ws, seq: 0, slot: null, stamp: 0 };
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ t: 'hello', role: 'pad', fresh: true, name: `L${i + 1}` }));
    const antwort = await new Promise((res) => {
      const timer = setTimeout(() => res('timeout'), 5000);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'welcome') { pad.slot = m.slot; clearTimeout(timer); res('ok'); }
        if (m.t === 'full') { clearTimeout(timer); res('full'); }
      });
    });
    // Refused (MAX_PLAYERS) or silent - do not wait forever for it.
    if (antwort !== 'ok') { try { ws.close(); } catch { /* ignore */ } return; }
    pads.push(pad);
  }));

  pads.sort((a, b) => a.slot - b.slot);
  if (pads.length < count) {
    console.log(`  ${String(count).padStart(8)}   nur ${pads.length} zugelassen (MAX_PLAYERS)`);
    game.disconnect();
    for (const pad of pads) { try { pad.ws.close(); } catch { /* ignore */ } }
    await sleep(400);
    continue;
  }

  const stop = Date.now() + SECONDS * 1000;
  let tick = 0;

  while (Date.now() < stop) {
    for (const pad of pads) {
      if (pad.ws.readyState !== 1) continue;
      const angle = (tick / 30) + pad.slot;
      const body = { t: 'input', seq: pad.seq++, ax: { lx: +Math.cos(angle).toFixed(3), ly: +Math.sin(angle).toFixed(3) } };
      // Only an actual press is timed. Stamping on the release too would
      // measure the gap until the NEXT press - which is what made the first
      // version of this report nonsense (360 ms instead of ~1 ms).
      if (tick % 40 === 0) {
        pad.stamp = performance.now();
        body.btn = { a: true };
        sent++;
      } else if (tick % 40 === 20) {
        body.btn = { a: false };
      }
      pad.ws.send(JSON.stringify(body));
    }
    tick++;
    await sleep(1000 / RATE_HZ);
  }

  await sleep(400);
  latencies.sort((a, b) => a - b);
  const at = (p) => (latencies.length ? latencies[Math.floor(latencies.length * p)] : NaN);
  const lost = sent ? Math.max(0, Math.round((1 - received / sent) * 100)) : 0;
  const perSecond = Math.round((tick * count) / SECONDS);

  console.log(
    `  ${String(count).padStart(8)}   ${String(perSecond).padStart(8)}   `
    + `${at(0.5).toFixed(1).padStart(6)} ms / ${at(0.95).toFixed(1).padStart(6)} ms / ${at(0.999).toFixed(1).padStart(6)} ms   `
    + `${String(lost).padStart(5)} %`,
  );

  for (const pad of pads) { try { pad.ws.close(); } catch { /* ignore */ } }
  game.disconnect();
  await sleep(600);
}

console.log('\n  Gemessen auf diesem Rechner, alles auf localhost - im WLAN kommt');
console.log('  die Funkstrecke dazu (typisch 1-5 ms, bei vollem Netz mehr).\n');
server.kill();
process.exit(0);
