#!/usr/bin/env node
/**
 * PocketJoy server - run this on the machine that runs the game.
 *
 * Serves three pages and one WebSocket endpoint:
 *   /        lobby page (shows the join URL + QR code, lists connected phones)
 *   /pad     the controller UI that phones open
 *   /demo    a 4-player demo game to test everything
 *   /ws      WebSocket endpoint for pads, games and the bridge
 *
 * Usage:
 *   node server/index.js [--port 3070] [--players 4] [--layout dual-stick] [--open|--demo]
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

import { Hub } from '../shared/hub.js';
import { SignalingServer } from './signaling.js';
import { readTurnConfig, buildIceServers, describeTurnConfig } from './turn.js';
import { LANGUAGES, setLanguage, t } from '../shared/i18n.js';
import { LAYOUTS, DEFAULT_LAYOUT, MAX_PLAYERS } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------- args

function parseArgs(argv) {
  const out = {
    port: 3070, players: 4, layout: DEFAULT_LAYOUT, open: null, host: '0.0.0.0',
    lang: process.env.POCKETJOY_LANG || 'en',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--players' || a === '-n') out.players = Number(next());
    else if (a === '--layout' || a === '-l') out.layout = next();
    else if (a === '--host') out.host = next();
    else if (a === '--lang') out.lang = next();
    else if (a === '--open') out.open = '/';
    else if (a === '--demo') out.open = '/demo';
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  }
  return out;
}

function usage() {
  console.log(`
PocketJoy - phones as controllers on your local network

  node server/index.js [options]

  --port, -p <n>      port (default: 3070)
  --players, -n <n>   maximum number of players (1-${MAX_PLAYERS}, default: 4)
  --layout, -l <id>   starting layout: ${Object.keys(LAYOUTS).join(', ')}
  --open              open the lobby in a browser
  --demo              open the demo game in a browser
  --host <addr>       bind address (default: 0.0.0.0, i.e. every interface)
  --lang <code>       language of this output and of the web pages'
                      first guess: ${LANGUAGES.map((l) => l.code).join(', ')}
`);
}

// ------------------------------------------------------- network discovery

/** All non-internal IPv4 addresses, most likely LAN address first. */
function lanAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface, address: a.address });
    }
  }
  // Prefer typical home-router ranges, and de-prioritise virtual adapters.
  const score = ({ iface, address }) => {
    let s = 0;
    if (/^192\.168\./.test(address)) s -= 3;
    else if (/^10\./.test(address)) s -= 2;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s -= 1;
    if (/vEthernet|VMware|VirtualBox|Hyper-V|WSL|docker|Loopback|Tailscale|ZeroTier/i.test(iface)) s += 10;
    if (/^169\.254\./.test(address)) s += 20;
    return s;
  };
  return out.sort((a, b) => score(a) - score(b));
}

// -------------------------------------------------------- static file serving

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** Exact routes first, then directory prefixes. */
const FILE_ROUTES = {
  '/': 'web/host/index.html',
  '/pad': 'web/pad/index.html',
  '/p': 'web/pad/index.html',
  '/demo': 'examples/arena/index.html',
  '/icon.svg': 'web/icon.svg',
  '/icon-small.svg': 'web/icon-small.svg',
  '/favicon.ico': 'web/icons/pocketjoy.ico',
  '/web': 'examples/web-arena/index.html',
};
const DIR_ROUTES = [
  ['/icons/', 'web/icons'],
  ['/pad/', 'web/pad'],
  ['/host/', 'web/host'],
  ['/shared/', 'shared'],
  ['/client/', 'client'],
  ['/demo/', 'examples/arena'],
  ['/web/', 'examples/web-arena'],
];

function resolveRequest(pathname) {
  if (FILE_ROUTES[pathname]) return path.join(ROOT, FILE_ROUTES[pathname]);
  for (const [prefix, dir] of DIR_ROUTES) {
    if (pathname.startsWith(prefix)) {
      const rel = decodeURIComponent(pathname.slice(prefix.length));
      const full = path.resolve(ROOT, dir, rel);
      // Never escape the mapped directory.
      if (!full.startsWith(path.resolve(ROOT, dir))) return null;
      return full;
    }
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  const file = resolveRequest(pathname);
  if (!file) return send(res, 404, 'Not found');
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return send(res, 404, 'Not found');
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    };

    // The library has to be loadable from a game hosted elsewhere - itch.io,
    // your own site - otherwise every project has to copy six files and keep
    // them in step. Only the library is opened up: it is public source code
    // anyway, it is read-only, and nothing here is user data.
    if (pathname.startsWith('/client/') || pathname.startsWith('/shared/')) {
      headers['Access-Control-Allow-Origin'] = '*';
    }

    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, obj) {
  send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8');
}

// --------------------------------------------------------------- QR codes

/** qrcode is optional - without it we just print the URL. */
let qrcode = null;
try { qrcode = (await import('qrcode')).default; } catch { /* not installed */ }

async function qrTerminal(url) {
  if (!qrcode) return null;
  try { return await qrcode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }); }
  catch { return null; }
}

async function qrDataUrl(url) {
  if (!qrcode) return null;
  try {
    return await qrcode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  } catch { return null; }
}

// ------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
setLanguage(args.lang, { remember: false });
if (!LAYOUTS[args.layout]) {
  console.error(t('cli.unknownLayout', { id: args.layout, list: Object.keys(LAYOUTS).join(', ') }));
  process.exit(1);
}

const hub = new Hub({
  maxPlayers: args.players,
  layout: args.layout,
  log: (msg) => console.log(`  ${msg}`),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/info') {
    const addrs = lanAddresses();
    const best = addrs[0]?.address || '127.0.0.1';
    const padUrl = `http://${best}:${args.port}/pad`;
    return sendJson(res, {
      port: args.port,
      padUrl,
      qr: await qrDataUrl(padUrl),
      addresses: addrs.map((a) => ({ ...a, padUrl: `http://${a.address}:${args.port}/pad` })),
      layouts: Object.fromEntries(Object.entries(LAYOUTS).map(([id, l]) => [id, { name: l.name, hint: l.hint }])),
      maxPlayersLimit: MAX_PLAYERS,
    });
  }

  if (url.pathname === '/health') return sendJson(res, { ok: true, players: hub.players.size });

  // QR code for any text - the web mode uses it for its room link.
  if (url.pathname === '/api/qr') {
    const text = url.searchParams.get('text') || '';
    if (!qrcode || !text || text.length > 512) return send(res, 404, 'Not found');
    try {
      const png = await qrcode.toBuffer(text, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      return res.end(png);
    } catch {
      return send(res, 500, 'QR failed');
    }
  }

  // Phones report their errors here, so problems on a device you cannot
  // inspect still show up in this terminal.
  if (url.pathname === '/api/log' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4000) req.destroy();
    });
    req.on('end', () => {
      let entry;
      try { entry = JSON.parse(body); } catch { return sendJson(res, { ok: false }); }
      const addr = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '?';
      const what = String(entry.msg || '').slice(0, 300);
      console.log(`  [Handy ${addr}] ${what}`);
      if (entry.ua) console.log(`     ${String(entry.ua).slice(0, 160)}`);
      sendJson(res, { ok: true });
    });
    return;
  }

  return serveStatic(req, res, url.pathname);
});

/**
 * Two WebSocket endpoints on one HTTP server:
 *   /ws      controllers, games and the bridge (the local mode)
 *   /signal  introductions for the WebRTC mode
 *
 * They must be created with `noServer` and routed by hand. Handing both a
 * `server` plus a `path` looks tidier but does not work: whichever one gets
 * the upgrade event first destroys every connection whose path it does not
 * recognise, so the other endpoint never sees anything.
 */
const wss = new WebSocketServer({ noServer: true });
const signalWss = new WebSocketServer({ noServer: true });
const turnConfig = readTurnConfig();
const signaling = new SignalingServer({
  log: (msg) => console.log(`  ${msg}`),
  iceServers: (label) => buildIceServers(turnConfig, label),
});

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { return socket.destroy(); }

  const target = pathname === '/ws' ? wss : pathname === '/signal' ? signalWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

signalWss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  signaling.attach(socket);
});

wss.on('connection', (socket, req) => {
  const addr = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '?';
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  hub.attach(socket, addr);
});

// Drop sockets that stopped answering (phone locked, wifi dropped, ...).
const heartbeat = setInterval(() => {
  for (const socket of [...wss.clients, ...signalWss.clients]) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    try { socket.ping(); } catch { /* ignore */ }
  }
}, 5000);
wss.on('close', () => clearInterval(heartbeat));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
  ${t('cli.portBusy', { port: args.port })}
`);
    process.exit(1);
  }
  throw err;
});

server.listen(args.port, args.host, async () => {
  const addrs = lanAddresses();
  const best = addrs[0]?.address || '127.0.0.1';
  const padUrl = `http://${best}:${args.port}/pad`;

  console.log(`
  ${t('cli.running')}
`);
// Labels differ in length per language, so line the columns up here.
  const labels = [t('cli.controller'), t('cli.lobby'), t('cli.demo')];
  const w = Math.max(...labels.map((l) => l.length));
  console.log(`  ${labels[0].padEnd(w)}  ${padUrl}`);
  console.log(`  ${labels[1].padEnd(w)}  http://localhost:${args.port}/`);
  console.log(`  ${labels[2].padEnd(w)}  http://localhost:${args.port}/demo`);
  console.log(`  ${t('cli.settings', { max: hub.maxPlayers, layout: hub.layout.id })}
`);

  if (addrs.length > 1) {
    console.log(`  ${t('cli.otherAddresses')}`);
    for (const a of addrs.slice(1)) console.log(`    http://${a.address}:${args.port}/pad   (${a.iface})`);
    console.log('');
  }

  const qr = await qrTerminal(padUrl);
  if (qr) console.log(qr);
  else console.log(`  ${t('cli.qrHint')}
`);

  console.log(`  ${t('cli.stop')}
`);
  if (args.open) openBrowser(`http://localhost:${args.port}${args.open}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`
  ${t('cli.stopped')}`);
    server.close();
    process.exit(0);
  });
}
