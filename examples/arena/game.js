/**
 * PocketJoy demo: Arena.
 *
 * A tiny 4-player twin-stick game - its real job is to show how little code
 * it takes to use PocketJoy. The interesting parts are marked with [POCKETJOY].
 */

import { PocketJoy } from '/client/pocketjoy.js';
import { onLanguageChange, t } from '/shared/i18n.js';

// ------------------------------------------------------- [POCKETJOY] setup

// This page is served by the PocketJoy server itself, so we reuse its port.
// In your own game (e.g. a Vite dev server on another port) just write:
//   new PocketJoy({ layout: 'dual-stick', maxPlayers: 4 })
// and it will look for the server on port 3070 of the same machine.
const pj = new PocketJoy({
  port: location.port || 3070,
  layout: 'dual-stick',
  maxPlayers: 4,
  name: 'Arena-Demo',
});

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');

const W = () => canvas.width;
const H = () => canvas.height;

// --------------------------------------------------------------- game state

const SHIP_R = 17;
const SPEED = 290;        // px per second
const BULLET_SPEED = 560;
const FIRE_DELAY = 0.22;  // seconds
const RESPAWN = 1.4;

/** slot -> ship */
const ships = new Map();
const bullets = [];

function spawnPoint(slot) {
  const pad = 90;
  const spots = [
    [pad, pad], [W() - pad, H() - pad],
    [W() - pad, pad], [pad, H() - pad],
    [W() / 2, pad], [W() / 2, H() - pad],
    [pad, H() / 2], [W() - pad, H() / 2],
  ];
  const [x, y] = spots[(slot - 1) % spots.length];
  return { x, y };
}

function makeShip(player) {
  const p = spawnPoint(player.slot);
  return {
    slot: player.slot,
    name: player.name,
    color: player.color,
    x: p.x, y: p.y,
    aim: player.slot % 2 ? 0 : Math.PI,
    cooldown: 0,
    dead: 0,
    score: 0,
    hitFlash: 0,
  };
}

// --------------------------------------------- [POCKETJOY] players join/leave

pj.on('join', (player) => {
  ships.set(player.slot, makeShip(player));
  updateOverlay();
  player.rumble(120, 0.6);          // say hello on the phone
});

pj.on('leave', (player) => {
  ships.delete(player.slot);
  updateOverlay();
});

pj.on('disconnect', () => {
  ships.clear();
  updateOverlay();
  statusEl.textContent = t('demo.connectionLost');
});

function updateOverlay() {
  const n = ships.size;
  overlay.classList.toggle('hidden', n > 0);
  statusEl.textContent = n === 0 ? t('demo.waiting') : '';
}

// ------------------------------------------------------------- game loop

let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  step(dt);
  draw();

  // [POCKETJOY] End of frame: clears pressed()/released() for the next one.
  pj.update();
  requestAnimationFrame(frame);
}

function step(dt) {
  for (const ship of ships.values()) {
    // [POCKETJOY] read the phone that owns this ship
    const player = pj.player(ship.slot);
    if (!player) continue;

    ship.name = player.name;
    ship.hitFlash = Math.max(0, ship.hitFlash - dt * 3);

    if (ship.dead > 0) {
      ship.dead -= dt;
      if (ship.dead <= 0) Object.assign(ship, spawnPoint(ship.slot));
      continue;
    }

    // move with the left stick
    const move = player.dir('left', 0.12);
    ship.x = clamp(ship.x + move.x * SPEED * dt, SHIP_R, W() - SHIP_R);
    ship.y = clamp(ship.y + move.y * SPEED * dt, SHIP_R, H() - SHIP_R);

    // aim with the right stick, fall back to the direction of travel
    const aimStick = player.dir('right', 0.25);
    if (aimStick.len > 0) ship.aim = aimStick.angle;
    else if (move.len > 0.3) ship.aim = move.angle;

    // fire: A button, right trigger, or simply pushing the aim stick
    ship.cooldown -= dt;
    const wantsToFire = player.down('a') || player.down('rt') || aimStick.len > 0.75;
    if (wantsToFire && ship.cooldown <= 0) {
      ship.cooldown = FIRE_DELAY;
      bullets.push({
        x: ship.x + Math.cos(ship.aim) * (SHIP_R + 4),
        y: ship.y + Math.sin(ship.aim) * (SHIP_R + 4),
        vx: Math.cos(ship.aim) * BULLET_SPEED,
        vy: Math.sin(ship.aim) * BULLET_SPEED,
        from: ship.slot,
        color: ship.color,
        life: 1.6,
      });
      player.rumble(35, 0.35);
    }
  }

  // bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

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
      const shooter = ships.get(b.from);
      if (shooter) shooter.score++;

      // [POCKETJOY] buzz the phone that got hit
      pj.player(ship.slot)?.rumble(260, 1);
      break;
    }
  }
}

// ------------------------------------------------------------------ drawing

function draw() {
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, W(), H());

  // subtle grid
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
    if (ship.dead > 0) {
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(performance.now() / 70);
    }
    ctx.save();
    ctx.translate(ship.x, ship.y);

    // body
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

    // barrel
    ctx.rotate(ship.aim);
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(SHIP_R - 6, -3.5, 14, 7);
    ctx.restore();

    // name
    ctx.globalAlpha = ship.dead > 0 ? 0.4 : 1;
    ctx.fillStyle = '#c8cfdb';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ship.name, ship.x, ship.y - SHIP_R - 9);
    ctx.globalAlpha = 1;
  }

  drawScores();
}

function drawScores() {
  const list = [...ships.values()].sort((a, b) => a.slot - b.slot);
  let x = 22;
  ctx.textAlign = 'left';
  for (const ship of list) {
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

// ---------------------------------------------------------------- plumbing

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Work in CSS pixels everywhere else.
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Show the join URL on the overlay.
fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    document.getElementById('padUrl').textContent = info.padUrl;
    if (info.qr) document.getElementById('qr').src = info.qr;
    else document.getElementById('qr').remove();
  })
  .catch(() => { document.getElementById('padUrl').textContent = t('demo.serverUnreachable'); });

pj.connect().catch((err) => { statusEl.textContent = err.message; });

/** Texts come from i18n so the demo follows the chosen language too. */
function applyTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  document.getElementById('controlsHint').innerHTML =
    t('demo.controls', { key: ' ' }).replace(' ', '<kbd>A</kbd>');
  updateOverlay();
}
applyTranslations();
onLanguageChange(applyTranslations);

updateOverlay();
requestAnimationFrame(frame);
