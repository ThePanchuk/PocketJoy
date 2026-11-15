/**
 * PocketJoy web mode demo.
 *
 * Same game as /demo, but nothing runs on the player's machine: this page
 * hosts the hub itself and the phones connect straight to it over WebRTC.
 * That is what makes it work from a hosted site like itch.io, where a
 * ws:// connection into the local network is forbidden.
 *
 * The only difference in the game code is the class and the room code:
 *
 *   new PocketJoyWeb({ signaling: 'wss://…/signal', layout: 'dual-stick' })
 *
 * Everything after that - players, sticks, buttons, update() - is identical
 * to the normal mode.
 */

import { PocketJoyWeb } from '/client/pocketjoy-web.js';
import { onLanguageChange, t } from '/shared/i18n.js';

const pj = new PocketJoyWeb({
  // Served from the PocketJoy server here, so the default (/signal on this
  // host) is right. A game on itch.io would name its own signalling service:
  //   signaling: 'wss://pocketjoy.deine-domain.de/signal',
  layout: 'dual-stick',
  maxPlayers: 4,
  lockLayout: true,
  name: 'Web-Arena',
});

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');

const W = () => canvas.width;
const H = () => canvas.height;

const SHIP_R = 17;
const SPEED = 290;
const BULLET_SPEED = 560;
const FIRE_DELAY = 0.22;
const RESPAWN = 1.4;

const ships = new Map();
const bullets = [];

function spawnPoint(slot) {
  const pad = 90;
  const spots = [
    [pad, pad], [W() - pad, H() - pad], [W() - pad, pad], [pad, H() - pad],
    [W() / 2, pad], [W() / 2, H() - pad], [pad, H() / 2], [W() - pad, H() / 2],
  ];
  const [x, y] = spots[(slot - 1) % spots.length];
  return { x, y };
}

function makeShip(player) {
  const p = spawnPoint(player.slot);
  return {
    slot: player.slot, name: player.name, color: player.color,
    x: p.x, y: p.y, aim: player.slot % 2 ? 0 : Math.PI,
    cooldown: 0, dead: 0, score: 0, hitFlash: 0,
  };
}

pj.on('join', (player) => {
  ships.set(player.slot, makeShip(player));
  updateOverlay();
  player.rumble(120, 0.6);
});
pj.on('leave', (player) => { ships.delete(player.slot); updateOverlay(); zeigeVerbindungen(); });

// How each phone actually got here. In one WLAN everything says "direkt im
// WLAN"; a player on mobile data shows "über Relais" and will feel slower.
pj.on('connection', zeigeVerbindungen);
pj.on('player', zeigeVerbindungen);   // Name geändert

function zeigeVerbindungen() {
  const box = document.getElementById('verbindungen');
  box.innerHTML = '';
  for (const p of pj.players) {
    const info = p.connection || pj.connectionOf(p.slot);
    if (!info) continue;
    const row = document.createElement('div');
    row.className = `v ${info.via}`;
    const dot = document.createElement('span');
    dot.className = 'punkt';
    dot.style.background = p.color;
    const wer = document.createElement('span');
    wer.textContent = p.name;
    const wie = document.createElement('span');
    wie.className = 'wie';
    wie.textContent = t(`demo.via${info.via.charAt(0).toUpperCase()}${info.via.slice(1)}`)
      + (info.rtt != null ? ` · ${info.rtt} ms` : '');
    row.append(dot, wer, wie);
    box.appendChild(row);
  }
}

function updateOverlay() {
  overlay.classList.toggle('hidden', ships.size > 0);
}

// ---------------------------------------------------------------- game loop

let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  draw();
  pj.update();
  requestAnimationFrame(frame);
}

function step(dt) {
  for (const ship of ships.values()) {
    const player = pj.player(ship.slot);
    if (!player) continue;

    ship.name = player.name;
    ship.hitFlash = Math.max(0, ship.hitFlash - dt * 3);

    if (ship.dead > 0) {
      ship.dead -= dt;
      if (ship.dead <= 0) Object.assign(ship, spawnPoint(ship.slot));
      continue;
    }

    const move = player.dir('left', 0.12);
    ship.x = clamp(ship.x + move.x * SPEED * dt, SHIP_R, W() - SHIP_R);
    ship.y = clamp(ship.y + move.y * SPEED * dt, SHIP_R, H() - SHIP_R);

    const aimStick = player.dir('right', 0.25);
    if (aimStick.len > 0) ship.aim = aimStick.angle;
    else if (move.len > 0.3) ship.aim = move.angle;

    ship.cooldown -= dt;
    const wantsToFire = player.down('a') || player.down('rt') || aimStick.len > 0.75;
    if (wantsToFire && ship.cooldown <= 0) {
      ship.cooldown = FIRE_DELAY;
      bullets.push({
        x: ship.x + Math.cos(ship.aim) * (SHIP_R + 4),
        y: ship.y + Math.sin(ship.aim) * (SHIP_R + 4),
        vx: Math.cos(ship.aim) * BULLET_SPEED,
        vy: Math.sin(ship.aim) * BULLET_SPEED,
        from: ship.slot, color: ship.color, life: 1.6,
      });
      player.rumble(35, 0.35);
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.y < -20 || b.x > W() + 20 || b.y > H() + 20) {
      bullets.splice(i, 1);
      continue;
    }
    for (const ship of ships.values()) {
      if (ship.slot === b.from || ship.dead > 0) continue;
      if (Math.hypot(ship.x - b.x, ship.y - b.y) > SHIP_R) continue;
      bullets.splice(i, 1);
      ship.dead = RESPAWN;
      ship.hitFlash = 1;
      ships.get(b.from) && ships.get(b.from).score++;
      pj.player(ship.slot)?.rumble(260, 1);
      break;
    }
  }
}

function draw() {
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, W(), H());

  ctx.strokeStyle = '#141924';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W(); x += 60) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H()); }
  for (let y = 0; y < H(); y += 60) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W(), y + 0.5); }
  ctx.stroke();

  for (const b of bullets) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const ship of ships.values()) {
    if (ship.dead > 0) ctx.globalAlpha = 0.25 + 0.2 * Math.sin(performance.now() / 70);
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.fillStyle = ship.color;
    ctx.beginPath();
    ctx.arc(0, 0, SHIP_R, 0, Math.PI * 2);
    ctx.fill();
    if (ship.hitFlash > 0) {
      ctx.strokeStyle = `rgba(255,255,255,${ship.hitFlash})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, SHIP_R + 5 + (1 - ship.hitFlash) * 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.rotate(ship.aim);
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(SHIP_R - 6, -3.5, 14, 7);
    ctx.restore();

    ctx.globalAlpha = ship.dead > 0 ? 0.4 : 1;
    ctx.fillStyle = '#c8cfdb';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ship.name, ship.x, ship.y - SHIP_R - 9);
    ctx.globalAlpha = 1;
  }

  let x = 22;
  ctx.textAlign = 'left';
  for (const ship of [...ships.values()].sort((a, b) => a.slot - b.slot)) {
    ctx.fillStyle = ship.color;
    ctx.beginPath();
    ctx.arc(x + 7, 29, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8ebf0';
    ctx.font = '600 15px system-ui, sans-serif';
    const label = `${ship.name}  ${ship.score}`;
    ctx.fillText(label, x + 21, 34);
    x += 21 + ctx.measureText(label).width + 26;
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --------------------------------------------------------------- start up

pj.on('room', (code, padUrl) => {
  document.getElementById('code').textContent = code;
  document.getElementById('padUrl').textContent = padUrl;
  statusEl.textContent = t('demo.ready');

  // The QR code is drawn by the PocketJoy server here; a game hosted
  // elsewhere would generate it itself or just show the link.
  const img = document.getElementById('qr');
  img.src = `/api/qr?text=${encodeURIComponent(padUrl)}`;
  img.onerror = () => img.remove();
});

pj.on('signaling-lost', () => {
  statusEl.textContent = t('demo.signalingLost');
});

pj.connect().catch((err) => {
  statusEl.textContent = err.message;
  document.getElementById('raum').style.display = 'none';
});

function applyTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  document.getElementById('controlsHint').innerHTML =
    t('demo.controls', { key: ' ' }).replace(' ', '<kbd>A</kbd>');
  if (!pj.room) statusEl.textContent = t('demo.signalingWait');
  zeigeVerbindungen();
}
applyTranslations();
onLanguageChange(applyTranslations);

updateOverlay();
requestAnimationFrame(frame);
