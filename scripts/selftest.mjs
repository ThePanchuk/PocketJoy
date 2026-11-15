/**
 * PocketJoy end-to-end self test.
 *
 * Starts a real server on a test port, connects a fake phone (raw WebSocket)
 * and a real game (client/pocketjoy.js), and checks that input, slots,
 * reconnects, layout switches and rumble all work.
 *
 *   node scripts/selftest.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { PocketJoy } from '../client/pocketjoy.js';
import { readTurnConfig, buildIceServers } from '../server/turn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// A fresh port per run: a server left behind by an aborted run would other-
// wise answer instead of ours, and the whole suite would test the wrong thing.
const PORT = 3100 + Math.floor(Math.random() * 800);

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy, or give up. */
async function until(fn, timeout = 2500, step = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

/** A fake phone: raw WebSocket speaking the pad side of the protocol. */
class FakePad {
  constructor(port) {
    this.port = port;
    this.messages = [];
    this.welcome = null;
    this.layout = null;
    this.rumbles = [];
    this.takenOver = false;
    this.kicked = false;
    this.resyncs = 0;
    this.isHost = null;
    this.overview = null;
    this.seq = 0;
  }

  connect(token, name, fresh = true) {
    // Every fake phone connects from 127.0.0.1, so without `fresh` they would
    // all count as the SAME device - which is exactly what the device tests
    // below check. Ordinary tests pass fresh so they get their own slot.
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', role: 'pad', token, name, fresh }));
      });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        if (msg.t === 'welcome') { this.welcome = msg; this.layout = msg.layout; resolve(msg); }
        if (msg.t === 'layout') this.layout = msg;
        if (msg.t === 'rumble') this.rumbles.push(msg);
        if (msg.t === 'full') resolve(msg);
        if (msg.t === 'takeover') this.takenOver = true;
        if (msg.t === 'kicked') this.kicked = true;
        if (msg.t === 'resync') this.resyncs++;
        if (msg.t === 'host') this.isHost = msg.isHost;
        if (msg.t === 'overview') this.overview = msg;
      });
      this.ws.on('error', reject);
    });
  }

  manage(msg) { this.ws.send(JSON.stringify(msg)); }

  input(btn, ax) {
    this.ws.send(JSON.stringify({ t: 'input', seq: this.seq++, btn, ax }));
  }

  /** Pretend a packet never made it: the next one jumps the numbering. */
  dropOne() { this.seq++; }

  /** The answer to a resync request: everything at once. */
  fullState(btn, ax) {
    this.ws.send(JSON.stringify({ t: 'input', seq: this.seq++, full: true, btn, ax }));
  }

  close() { this.ws.close(); }
}

// --------------------------------------------------------------------- run

console.log('\nPocketJoy Selbsttest\n');

const server = spawn(
  process.execPath,
  [path.join(ROOT, 'server', 'index.js'), '--port', String(PORT), '--players', '4'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d.toString(); });
server.stderr.on('data', (d) => { serverOut += d.toString(); });

const stop = () => { try { server.kill(); } catch { /* ignore */ } };
process.on('exit', stop);

try {
  const up = await until(async () => {
    if (/belegt|EADDRINUSE/.test(serverOut)) return 'busy';
    if (server.exitCode !== null) return 'dead';
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      return r.ok;
    } catch { return false; }
  }, 8000);
  check('Server startet', up === true, up === 'busy'
    ? `Port ${PORT} ist belegt - laeuft noch ein Server aus einem frueheren Lauf?`
    : serverOut.slice(-300));
  if (up !== true) throw new Error('server did not start');

  // --- game connects ------------------------------------------------------
  const pj = new PocketJoy({ host: '127.0.0.1', port: PORT, layout: 'gamepad', maxPlayers: 4, name: 'selftest' });
  await pj.connect();
  check('Spiel verbindet sich', pj.connected);
  check('Spiel setzt Layout', pj.layout?.id === 'gamepad', `war: ${pj.layout?.id}`);

  // --- the main controller ------------------------------------------------
  // The first phone in runs the round from its own screen: it can remove
  // players and pick the layout for everyone. Nobody else may.
  const chef = new FakePad(PORT);
  const wChef = await chef.connect(undefined, 'Chef');
  await until(() => chef.isHost !== null);
  check('Erstes Handy wird Hauptcontroller', chef.isHost === true, `isHost=${chef.isHost}`);
  await until(() => chef.overview);
  check('Hauptcontroller bekommt die Uebersicht', Array.isArray(chef.overview?.players));

  const gast = new FakePad(PORT);
  const wGast = await gast.connect(undefined, 'Gast');
  await sleep(250);
  check('Zweites Handy ist kein Hauptcontroller', gast.isHost !== true, `isHost=${gast.isHost}`);
  check('Uebersicht waechst mit', chef.overview.players.length >= 2,
        `${chef.overview?.players?.length} Spieler`);
  check('Uebersicht kennzeichnet den Hauptcontroller',
        chef.overview.players.find((p) => p.slot === wChef.slot)?.isHost === true);

  // An ordinary player must not be able to manage anything.
  const layoutVorher = pj.layout?.id;
  gast.manage({ t: 'layout', layout: 'buzzer' });
  await sleep(250);
  check('Normaler Spieler darf das Layout nicht setzen', pj.layout?.id === layoutVorher,
        `${layoutVorher} -> ${pj.layout?.id}`);

  gast.manage({ t: 'kick', slot: wChef.slot });
  await sleep(250);
  check('Normaler Spieler darf niemanden entfernen', !!pj.player(wChef.slot));

  // The main controller may.
  chef.manage({ t: 'layout', layout: 'buzzer' });
  await until(() => pj.layout?.id === 'buzzer');
  check('Hauptcontroller setzt das Layout fuer alle', pj.layout?.id === 'buzzer');
  check('Layout erreicht auch die anderen Handys', gast.layout?.id === 'buzzer');

  chef.manage({ t: 'kick', slot: wChef.slot });
  await sleep(250);
  check('Hauptcontroller kann sich nicht selbst entfernen', !!pj.player(wChef.slot));

  chef.manage({ t: 'kick', slot: wGast.slot });
  await until(() => gast.kicked);
  check('Hauptcontroller entfernt einen Spieler', gast.kicked === true);

  // Hand-over: when the main controller leaves, the next one takes charge.
  const nachfolger = new FakePad(PORT);
  await nachfolger.connect(undefined, 'Nachfolger');
  await sleep(250);
  check('Nachfolger ist zunaechst kein Hauptcontroller', nachfolger.isHost !== true);
  chef.close();
  await until(() => nachfolger.isHost === true, 3000);
  check('Rolle geht weiter, wenn der Hauptcontroller geht', nachfolger.isHost === true);
  check('Nachfolger bekommt die Uebersicht', !!nachfolger.overview);

  nachfolger.close();
  gast.close();
  await until(() => pj.count === 0, 3000);
  check('Lobby ist danach wieder leer', pj.count === 0, `${pj.count} Spieler uebrig`);

  // Put the layout back the way the game wanted it, so the next tests see
  // the state they expect.
  pj.setLayout('gamepad');
  await until(() => pj.layout?.id === 'gamepad');

  // --- phone joins --------------------------------------------------------
  const pad1 = new FakePad(PORT);
  const w1 = await pad1.connect(undefined, 'Anna');
  check('Handy bekommt Slot 1', w1.slot === 1, `war: ${w1.slot}`);
  check('Handy bekommt Token', typeof w1.token === 'string' && w1.token.length > 10);
  check('Handy bekommt Layout vom Spiel', pad1.layout?.id === 'gamepad', `war: ${pad1.layout?.id}`);
  check('Handy bekommt Namen', w1.name === 'Anna', `war: ${w1.name}`);
  check('Gewaehlter Name ist als solcher markiert', w1.named === true);

  await until(() => pj.count === 1);
  check('Spiel sieht den Spieler', pj.count === 1);
  check('Spielername kommt an', pj.player(1)?.name === 'Anna');

  // --- buttons ------------------------------------------------------------
  pad1.input({ a: true }, null);
  await until(() => pj.player(1)?.down('a'));
  check('Button-Druck kommt an', pj.player(1).down('a') === true);
  check('pressed() ist wahr im selben Frame', pj.player(1).pressed('a') === true);

  pj.update();
  check('update() loescht pressed()', pj.player(1).pressed('a') === false);
  check('down() bleibt wahr nach update()', pj.player(1).down('a') === true);

  pad1.input({ a: false }, null);
  await until(() => !pj.player(1).down('a'));
  check('Button-Loslassen kommt an', pj.player(1).down('a') === false);
  check('released() ist wahr', pj.player(1).released('a') === true);
  pj.update();

  // --- an event per press, not per packet --------------------------------
  // A phone sends up to 60 packets a second, so several usually arrive
  // between two frames. Reporting everything collected so far would fire the
  // same press again with every one of them.
  let presseEreignisse = 0;
  const zaehlen = (p, knopf) => { if (knopf === 'x') presseEreignisse++; };
  pj.on('press', zaehlen);

  pad1.input({ x: true }, null);
  await until(() => pj.player(1)?.down('x'));
  // More packets follow without update() in between - as in a real frame.
  pad1.input(null, { lx: 0.1 });
  pad1.input(null, { lx: 0.2 });
  pad1.input(null, { lx: 0.3 });
  await sleep(250);
  check('Ein Druck meldet genau ein Ereignis', presseEreignisse === 1,
        `${presseEreignisse} Ereignisse`);

  pad1.input({ x: false }, null);
  await until(() => !pj.player(1).down('x'));
  pj.off('press', zaehlen);
  pj.update();

  // --- axes ---------------------------------------------------------------
  pad1.input(null, { lx: 0.5, ly: -1 });
  await until(() => pj.player(1).axis('lx') === 0.5);
  const st = pj.player(1).stick('left');
  check('Achsen kommen an', st.x === 0.5 && st.y === -1, `war: ${JSON.stringify(st)}`);

  const d = pj.player(1).dir('left');
  check('dir() normalisiert', Math.abs(Math.hypot(d.x, d.y) - 1) < 0.001, `len ${d.len}`);

  // --- triggers behave like buttons --------------------------------------
  pad1.input(null, { rt: 1 });
  await until(() => pj.player(1).down('rt'));
  check('Trigger zaehlt als Button', pj.player(1).down('rt') === true);
  check('Trigger erzeugt pressed()', pj.player(1).pressed('rt') === true);
  pj.update();

  // --- a second phone -----------------------------------------------------
  const pad2 = new FakePad(PORT);
  const w2 = await pad2.connect();
  check('Zweites Handy bekommt Slot 2', w2.slot === 2, `war: ${w2.slot}`);
  check('Platzhalter-Name gilt nicht als gewaehlt', w2.named === false, `war: ${w2.named}`);
  await until(() => pj.count === 2);
  check('Spiel sieht zwei Spieler', pj.count === 2);
  check('Spieler haben verschiedene Farben', pj.player(1).color !== pj.player(2).color);

  // inputs must not bleed between players
  pad2.input({ b: true }, null);
  await until(() => pj.player(2).down('b'));
  check('Spieler sind getrennt', pj.player(2).down('b') === true && pj.player(1).down('b') === false);
  pj.update();

  // --- rumble reaches the phone ------------------------------------------
  pj.player(1).rumble(200, 1);
  await until(() => pad1.rumbles.length > 0);
  check('Rumble erreicht das Handy', pad1.rumbles[0]?.ms === 200);

  // --- layout switch reaches the phones ----------------------------------
  pj.setLayout('racing');
  await until(() => pad1.layout?.id === 'racing');
  check('Layout-Wechsel erreicht Handys', pad1.layout?.id === 'racing' && pad2.layout?.id === 'racing');

  // --- disconnect / reconnect keeps the slot -----------------------------
  pad1.close();
  await until(() => pj.count === 1);
  check('Spiel merkt Verbindungsabbruch', pj.count === 1 && !pj.player(1));

  const pad1b = new FakePad(PORT);
  const w1b = await pad1b.connect(w1.token, 'Anna', false);
  check('Reconnect bekommt denselben Slot', w1b.slot === 1, `war: ${w1b.slot}`);
  await until(() => pj.count === 2);
  check('Spiel sieht den Spieler wieder', pj.count === 2);

  // --- a game decides the layout -----------------------------------------
  // Preset by name.
  pj.setLayout('platformer');
  await until(() => pad2.layout?.id === 'platformer');
  check('Spiel setzt ein Preset', pad2.layout?.id === 'platformer', pad2.layout?.id);

  // A layout the game brings itself.
  pj.setLayout({
    name: 'Angeln',
    hint: 'Werfen und kurbeln',
    controls: [
      { kind: 'stick', id: 'left', x: 22, y: 55, size: 55 },
      { kind: 'button', id: 'a', x: 78, y: 60, size: 30, label: 'Werfen' },
    ],
  });
  await until(() => pad2.layout?.custom);
  check('Spiel setzt ein eigenes Layout', pad2.layout?.name === 'Angeln', pad2.layout?.name);
  check('Eigenes Layout kommt vollstaendig an', pad2.layout?.controls?.length === 2);
  check('Eigenes Layout behaelt die Beschriftung',
        pad2.layout?.controls?.[1]?.label === 'Werfen');

  // Nonsense must not reach the phones.
  const layoutBefore = pad2.layout;
  pj.setLayout({ name: 'Kaputt', controls: [{ kind: 'raumschiff', id: 'x' }] });
  await sleep(250);
  check('Unbrauchbares Layout wird abgewiesen', pad2.layout === layoutBefore);

  pj.setLayout({
    name: 'Grenzwerte',
    controls: [{ kind: 'button', id: 'a', x: 999, y: -40, size: 0 }],
  });
  await until(() => pad2.layout?.name === 'Grenzwerte');
  const fixed = pad2.layout.controls[0];
  check('Werte ausserhalb des Rahmens werden begrenzt',
        fixed.x === 100 && fixed.y === 0 && fixed.size >= 4,
        JSON.stringify(fixed));

  // --- the game may keep the lobby out -----------------------------------
  const lobby = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => lobby.on('open', r));
  lobby.send(JSON.stringify({ t: 'hello', role: 'host', name: 'Testlobby' }));
  await sleep(200);

  pj.setLayout('racing', true);           // lock it
  await until(() => pad2.layout?.id === 'racing');

  lobby.send(JSON.stringify({ t: 'layout', layout: 'buzzer' }));
  await sleep(300);
  check('Lobby kann gesperrtes Layout nicht aendern', pad2.layout?.id === 'racing',
        pad2.layout?.id);

  pj.setLayout('buttons');                // the game itself still may
  await until(() => pad2.layout?.id === 'buttons');
  check('Spiel darf sein gesperrtes Layout selbst wechseln', pad2.layout?.id === 'buttons');

  pj.setLayout('dual-stick', false);      // release the lock
  await sleep(200);
  lobby.send(JSON.stringify({ t: 'layout', layout: 'buzzer' }));
  await until(() => pad2.layout?.id === 'buzzer');
  check('Nach Freigabe darf die Lobby wieder', pad2.layout?.id === 'buzzer');
  lobby.close();

  // --- one device = one player -------------------------------------------
  const deviceA = new FakePad(PORT);
  const wA = await deviceA.connect('token-geraet-a', 'Geraet A', false);
  await until(() => pj.player(wA.slot));
  const countWithA = pj.count;   // this device is now one player

  // Same device opens the controller a second time (another tab, or a
  // reconnect after the wifi dropped). It must take its slot over, not get
  // a second one.
  const deviceAagain = new FakePad(PORT);
  const wA2 = await deviceAagain.connect('token-geraet-a', undefined, false);
  await sleep(250);

  check('Zweites Fenster bekommt denselben Platz', wA2.slot === wA.slot, `${wA.slot} -> ${wA2.slot}`);
  check('Kein zusaetzlicher Spieler', pj.count === countWithA, `${countWithA} -> ${pj.count}`);
  check('Erstes Fenster wird abgemeldet', deviceA.takenOver === true);
  check('Name bleibt beim Uebernehmen erhalten', pj.player(wA.slot)?.name === 'Geraet A',
        pj.player(wA.slot)?.name);
  // The pad pre-fills its name field from this, so a phone that stores
  // nothing itself still sees its name again.
  check('Reconnect bekommt den Namen zurueck', wA2.name === 'Geraet A', `war: ${wA2.name}`);
  check('Reconnect weiss, dass der Name gewaehlt war', wA2.named === true);

  // Input from the new connection must arrive for that same player.
  deviceAagain.input({ y: true }, null);
  await until(() => pj.player(wA.slot)?.down('y'));
  check('Uebernommene Verbindung steuert weiter', pj.player(wA.slot).down('y') === true);
  pj.update();

  // Fully disconnected (phone reloads the page, wifi drops) and back again:
  // slot AND name must survive, even though the player was already removed.
  deviceAagain.close();
  await until(() => !pj.player(wA.slot));
  const deviceAback = new FakePad(PORT);
  const wA3 = await deviceAback.connect('token-geraet-a', undefined, false);
  check('Nach Trennung kommt derselbe Platz zurueck', wA3.slot === wA.slot, `war: ${wA3.slot}`);
  check('Nach Trennung kommt der Name zurueck', wA3.name === 'Geraet A', `war: ${wA3.name}`);
  check('Name bleibt als gewaehlt markiert', wA3.named === true);

  deviceA.close();
  deviceAback.close();
  await until(() => pj.count === countWithA - 1);

  // --- lost packets --------------------------------------------------
  // Over WebRTC packets can vanish. Since only changes are sent, a lost one
  // would leave the server believing a button is still held.
  const lossy = new FakePad(PORT);
  const wLossy = await lossy.connect(undefined, 'Verlust');
  await until(() => pj.player(wLossy.slot));
  const lossySlot = wLossy.slot;

  lossy.input({ a: true }, null);
  await until(() => pj.player(lossySlot)?.down('a'));
  check('Knopf gedrueckt angekommen', pj.player(lossySlot).down('a') === true);
  pj.update();

  // This is the packet that gets lost - the one saying "released".
  lossy.dropOne();
  lossy.input({ b: true }, null);
  await until(() => pj.player(lossySlot)?.down('b'));

  check('Luecke wird bemerkt', lossy.resyncs > 0, `resyncs=${lossy.resyncs}`);
  // Without the request the server would still think 'a' is held.
  check('Server haengt noch am alten Zustand', pj.player(lossySlot).down('a') === true);

  // The phone answers with everything it really holds - 'a' is long released.
  const alleAus = {};
  for (const b of ['a', 'b', 'x', 'y']) alleAus[b] = false;
  lossy.fullState(alleAus, { lx: 0, ly: 0 });
  await until(() => !pj.player(lossySlot)?.down('a'));
  check('Vollzustand raeumt den haengenden Knopf auf',
        pj.player(lossySlot).down('a') === false);
  check('Vollzustand wird uebernommen', pj.player(lossySlot).down('b') === false);
  pj.update();

  // Repeated gaps must not produce a request per packet.
  const vorher = lossy.resyncs;
  for (let i = 0; i < 6; i++) { lossy.dropOne(); lossy.input({ x: i % 2 === 0 }, null); }
  await sleep(250);
  check('Anfragen werden gebremst', lossy.resyncs - vorher <= 2,
        `${lossy.resyncs - vorher} Anfragen bei 6 Luecken`);

  lossy.close();
  await until(() => !pj.player(lossySlot));

  // --- the host can remove a player --------------------------------------
  const guest = new FakePad(PORT);
  const wGuest = await guest.connect('token-gast', 'Gast', false);
  await until(() => pj.player(wGuest.slot));
  check('Gast ist verbunden', !!pj.player(wGuest.slot));

  pj.player(wGuest.slot).kick();
  await until(() => guest.kicked);
  check('Entferntes Handy wird benachrichtigt', guest.kicked === true);
  await until(() => !pj.player(wGuest.slot));
  check('Platz wird sofort frei', !pj.player(wGuest.slot));

  // Joining again by hand must work - removing frees a seat, it is no ban.
  const guestBack = new FakePad(PORT);
  const wBack = await guestBack.connect('token-gast', undefined, false);
  check('Entfernter Spieler darf wieder beitreten', wBack.t !== 'full' && !!wBack.slot);
  // ... but comes back as a newcomer: the server forgot the removed player,
  // so no old name is restored.
  check('Entfernter Spieler kommt ohne alten Namen zurueck', wBack.named !== true,
        `named=${wBack.named}, name=${wBack.name}`);
  guestBack.close();
  await sleep(200);

  // --- the server is full ------------------------------------------------
  const extra = [];
  for (let i = 0; i < 2; i++) {
    const p = new FakePad(PORT);
    await p.connect();
    extra.push(p);
  }
  const padFull = new FakePad(PORT);
  const res = await padFull.connect();
  check('5. Handy wird abgewiesen (max 4)', res.t === 'full', `war: ${res.t}`);

  // --- /api/info ----------------------------------------------------------
  const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
  check('/api/info liefert Pad-URL', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pad$/.test(info.padUrl), info.padUrl);
  check('/api/info liefert QR-Code', typeof info.qr === 'string' && info.qr.startsWith('data:image/'));
  check('/api/info listet Layouts', Object.keys(info.layouts || {}).length >= 5);

  // --- static files -------------------------------------------------------
  for (const [name, url] of [
    ['Lobby', '/'],
    ['Pad', '/pad'],
    ['Pad-Script', '/pad/pad.js'],
    ['Protokoll', '/shared/protocol.js'],
    ['Client-Lib', '/client/pocketjoy.js'],
    ['Icon', '/icon.svg'],
    ['Favicon', '/favicon.ico'],
    ['Icon-PNG', '/icons/icon-180.png'],
  ]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`);
    check(`${name} wird ausgeliefert`, r.ok, `HTTP ${r.status}`);
  }

  // directory traversal must not work
  const evil = await fetch(`http://127.0.0.1:${PORT}/shared/../package.json`);
  check('Kein Zugriff ausserhalb der Ordner', evil.status === 404, `HTTP ${evil.status}`);

  // --- signalling for the web mode ---------------------------------------
  // Only the introduction is tested here; the WebRTC channel itself needs
  // two real browsers and is checked by hand.
  const signalConn = (name) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal`);
    const inbox = [];
    const waitFor = (type, ms = 2500) => new Promise((res) => {
      const found = inbox.find((m) => m.t === type);
      if (found) return res(found);
      const deadline = Date.now() + ms;
      const tick = setInterval(() => {
        const hit = inbox.find((m) => m.t === type);
        if (hit || Date.now() > deadline) { clearInterval(tick); res(hit || null); }
      }, 20);
    });
    ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    const open = new Promise((res) => ws.on('open', res));
    return { ws, inbox, waitFor, open, send: (m) => ws.send(JSON.stringify(m)) };
  };

  const host = signalConn('host');
  await host.open;
  host.send({ t: 'host' });
  const roomMsg = await host.waitFor('room');
  check('Signaling vergibt einen Raum-Code', !!roomMsg?.code && roomMsg.code.length >= 4,
        roomMsg?.code);
  check('Raum-Code ist gut lesbar (kein O/0/I/1)', !/[O0I1L]/.test(roomMsg?.code || 'O'),
        roomMsg?.code);

  const padA = signalConn('pad');
  await padA.open;
  padA.send({ t: 'join', code: roomMsg.code.toLowerCase() });   // Kleinschreibung muss gehen
  const joined = await padA.waitFor('joined');
  check('Handy tritt dem Raum bei', !!joined?.peer, JSON.stringify(joined));
  const peerSeen = await host.waitFor('peer-joined');
  check('Spiel erfaehrt vom neuen Handy', peerSeen?.peer === joined?.peer);

  // Signalling messages must reach the other side, in both directions.
  padA.send({ t: 'signal', data: { t: 'offer', sdp: 'test-offer' } });
  const relayed = await host.waitFor('signal');
  check('Angebot erreicht das Spiel', relayed?.data?.sdp === 'test-offer' && relayed?.from === joined.peer);

  host.send({ t: 'signal', to: joined.peer, data: { t: 'answer', sdp: 'test-answer' } });
  const back = await padA.waitFor('signal');
  check('Antwort erreicht das Handy', back?.data?.sdp === 'test-answer' && back?.from === 'host');

  // A wrong code must not open a room.
  const padB = signalConn('pad2');
  await padB.open;
  padB.send({ t: 'join', code: 'XXXX' });
  const noRoom = await padB.waitFor('no-room');
  check('Falscher Raum-Code wird abgewiesen', !!noRoom);

  padA.ws.close(); padB.ws.close(); host.ws.close();
  await sleep(200);

  // --- TURN configuration -------------------------------------------------
  // Nothing configured is the normal case: inside one WLAN no external
  // service is needed, and none should be contacted.
  const leer = buildIceServers(readTurnConfig({}), 'x');
  check('Ohne Konfiguration keine ICE-Server', leer.servers.length === 0);

  const nurStun = buildIceServers(readTurnConfig({
    POCKETJOY_STUN: 'stun:stun.example.com:3478',
  }), 'x');
  check('STUN allein wird uebernommen',
        nurStun.servers.length === 1 && !nurStun.servers[0].username);

  const mitSecret = buildIceServers(readTurnConfig({
    POCKETJOY_TURN: 'turn:turn.example.com:3478',
    POCKETJOY_TURN_SECRET: 'testgeheimnis',
    POCKETJOY_TURN_TTL: '600',
  }), 'spieler1');
  const cred = mitSecret.servers[0];
  check('TURN bekommt Zugangsdaten', !!cred?.username && !!cred?.credential);

  // Username is "<expiry>:<label>" - the point is that it stops working.
  const [stamp, label] = String(cred.username).split(':');
  const gueltigBis = Number(stamp) - Math.floor(Date.now() / 1000);
  check('Zugangsdaten laufen ab', gueltigBis > 500 && gueltigBis <= 600,
        `noch ${gueltigBis}s gueltig`);
  check('Zugangsdaten sind pro Spieler verschieden', label === 'spieler1');

  const zweiter = buildIceServers(readTurnConfig({
    POCKETJOY_TURN: 'turn:turn.example.com:3478',
    POCKETJOY_TURN_SECRET: 'testgeheimnis',
  }), 'spieler2');
  check('Anderer Spieler, andere Zugangsdaten',
        zweiter.servers[0].credential !== cred.credential);

  // The secret itself must never travel.
  check('Das Geheimnis selbst wird nicht ausgeliefert',
        !JSON.stringify(mitSecret.servers).includes('testgeheimnis'));

  const ohneDaten = buildIceServers(readTurnConfig({
    POCKETJOY_TURN: 'turn:turn.example.com:3478',
  }), 'x');
  check('TURN ohne Zugangsdaten warnt', !!ohneDaten.warning);

  // --- the signalling service hands them to both sides --------------------
  const iceHost = signalConn('ice-host');
  await iceHost.open;
  iceHost.send({ t: 'host' });
  const iceRoom = await iceHost.waitFor('room');
  check('Spiel bekommt ICE-Konfiguration', Array.isArray(iceRoom?.iceServers));

  const icePad = signalConn('ice-pad');
  await icePad.open;
  icePad.send({ t: 'join', code: iceRoom.code });
  const iceJoined = await icePad.waitFor('joined');
  // This is the bit that decides whether a phone on mobile data can play.
  check('Handy bekommt ICE-Konfiguration', Array.isArray(iceJoined?.iceServers));
  iceHost.ws.close(); icePad.ws.close();
  await sleep(150);

  // --- how the client picks its address ----------------------------------
  // A page over https cannot reach a ws:// server, so there the library must
  // use the page's own origin (reverse proxy) instead of port 3070.
  const realLocation = globalThis.location;
  globalThis.location = { protocol: 'https:', hostname: 'spiel.example.com',
                          host: 'spiel.example.com', port: '' };
  check('https nutzt wss ueber dieselbe Adresse',
        new PocketJoy({}).url === 'wss://spiel.example.com/ws',
        new PocketJoy({}).url);
  check('https mit festem Port bleibt beim Port',
        new PocketJoy({ port: 3070 }).url === 'wss://spiel.example.com:3070/ws');

  globalThis.location = { protocol: 'http:', hostname: '192.168.0.122',
                          host: '192.168.0.122:3040', port: '3040' };
  check('http sucht den Server auf Port 3070',
        new PocketJoy({}).url === 'ws://192.168.0.122:3070/ws',
        new PocketJoy({}).url);

  // The https/ws mix must fail with a clear message instead of silence.
  globalThis.location = { protocol: 'https:', hostname: 'spiel.example.com',
                          host: 'spiel.example.com', port: '' };
  let mixedError = null;
  await new PocketJoy({ url: 'ws://192.168.0.122:3070/ws', autoReconnect: false })
    .connect().catch((e) => { mixedError = e; });
  check('https zu ws:// meldet einen verstaendlichen Fehler',
        !!mixedError && /https/.test(mixedError.message),
        mixedError?.message?.slice(0, 60));

  if (realLocation === undefined) delete globalThis.location;
  else globalThis.location = realLocation;

  // A server that is simply not there must make connect() fail, not hang.
  let deadError = null;
  await new PocketJoy({ host: '127.0.0.1', port: 3199, autoReconnect: false })
    .connect().catch((e) => { deadError = e; });
  check('Nicht erreichbarer Server laesst connect() scheitern', !!deadError,
        deadError?.message?.slice(0, 50));

  pj.disconnect();
  for (const p of [pad1b, pad2, padFull, ...extra]) { try { p.close(); } catch { /* ignore */ } }
} catch (err) {
  failed++;
  console.log(`\n  ABBRUCH: ${err.message}\n${serverOut.slice(-500)}`);
}

stop();
await sleep(150);

console.log(`\n  ${passed} ok, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
