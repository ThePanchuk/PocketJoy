/**
 * PocketJoy lobby - runs on the PC.
 *
 * Shows the join URL and QR code, lists connected phones with a live input
 * preview (handy for checking that a phone really works), and lets you switch
 * the controller layout for everyone.
 */

import { BUTTON_LABELS, LAYOUTS, emptyState } from '/shared/protocol.js';
import { layoutPreviewSvg } from '/shared/layout-preview.js';
import {
  LANGUAGES, getLanguage, layoutText, onLanguageChange, setLanguage, t,
} from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);

const el = {
  qr: $('qr'), qrFallback: $('qrFallback'), padUrl: $('padUrl'),
  addrList: $('addrList'), moreAddrs: $('moreAddrs'),
  players: $('players'), count: $('count'),
  layouts: $('layouts'), layoutNote: $('layoutNote'), status: $('status'),
  langSelect: $('langSelect'), bridgeHint: $('bridgeHint'),
  rumbleAll: $('rumbleAll'),
};

/** slot -> { info, state, node, refs } */
const players = new Map();
let layoutId = null;
let layoutCatalog = {};
let layoutLocked = false;
let customLayout = null;
let maxPlayers = 4;
let ws = null;

// A compact set of buttons for the preview - enough to see that it works.
const VIZ_BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'up', 'down', 'left', 'right', 'start'];

// ------------------------------------------------------------- server info

async function loadInfo() {
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    el.padUrl.textContent = info.padUrl;
    if (info.qr) {
      el.qr.src = info.qr;
    } else {
      el.qr.classList.add('hidden');
      el.qrFallback.classList.remove('hidden');
    }
    layoutCatalog = info.layouts || {};
    renderLayouts();

    const others = (info.addresses || []).slice(1);
    if (others.length) {
      el.addrList.innerHTML = others
        .map((a) => `<li><code>${a.padUrl}</code> <span>(${escapeHtml(a.iface)})</span></li>`)
        .join('');
    } else {
      el.moreAddrs.classList.add('hidden');
    }
  } catch {
    el.padUrl.textContent = t('lobby.infoFailed');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------- layouts

function renderLayouts() {
  el.layouts.innerHTML = '';

  // A layout the game brought itself is not in the preset list - show it as
  // its own entry so you can see what the phones are displaying.
  if (customLayout) {
    const own = document.createElement('div');
    own.className = 'layout-btn active';
    own.innerHTML = `<div class="preview">${layoutPreviewSvg(customLayout, { color: '#3d8bfd' })}</div>`
      + `<strong>${escapeHtml(customLayout.name || t('lobby.ownLayout'))}</strong>`
      + `<span>${escapeHtml(customLayout.hint || t('lobby.fromGame'))}</span>`;
    el.layouts.appendChild(own);
  }

  for (const [id, def] of Object.entries(layoutCatalog)) {
    const btn = document.createElement('button');
    btn.className = 'layout-btn' + (id === layoutId ? ' active' : '');
    btn.dataset.id = id;
    btn.disabled = layoutLocked;
    const name = layoutText({ id, ...def }, 'name');
    const hint = layoutText({ id, ...def }, 'hint');
    // The preview is drawn from the real layout data, so it always matches
    // what the phones will actually show.
    const preview = LAYOUTS[id]
      ? `<div class="preview">${layoutPreviewSvg(LAYOUTS[id], { color: id === layoutId ? '#3d8bfd' : '#6f7a8b' })}</div>`
      : '';
    btn.innerHTML = preview
      + `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(hint)}</span>`;
    btn.addEventListener('click', () => send({ t: 'layout', layout: id }));
    el.layouts.appendChild(btn);
  }
}

function renderLayoutLock() {
  el.layoutNote.textContent = t(layoutLocked ? 'lobby.layoutLocked' : 'lobby.layoutFree');
  renderLayouts();
}

function markLayout(layout) {
  const id = typeof layout === 'string' ? layout : layout?.id;
  layoutId = id;
  customLayout = (layout && layout.custom) ? layout : null;
  renderLayouts();
}

// ---------------------------------------------------------------- players

function updateCount() {
  el.count.textContent = `${players.size} / ${maxPlayers}`;
  const empty = el.players.querySelector('.empty');
  if (players.size === 0) {
    if (!empty) {
      el.players.innerHTML = `<p class="muted empty">${escapeHtml(t('lobby.noPlayers'))}</p>`;
    }
  } else if (empty) {
    empty.remove();
  }
}

function addPlayer(info, initialState) {
  removePlayer(info.slot);

  const node = document.createElement('div');
  node.className = 'player';
  node.style.setProperty('--pc', info.color);
  node.innerHTML = `
    <div class="row">
      <span class="pname"></span>
      <span class="pslot">${escapeHtml(t('lobby.player', { slot: info.slot }))}</span>
    </div>
    <button class="kick" title="${escapeHtml(t('lobby.removeTitle'))}">${escapeHtml(t('lobby.remove'))}</button>
    <div class="viz">
      <div class="pad-dot" title="${escapeHtml(t('lobby.leftStick'))}"><i></i></div>
      <div class="pad-dot" title="${escapeHtml(t('lobby.rightStick'))}"><i></i></div>
      <div class="btns"></div>
    </div>`;
  node.querySelector('.pname').textContent = info.name;

  const btnWrap = node.querySelector('.btns');
  const btnRefs = {};
  for (const b of VIZ_BUTTONS) {
    const span = document.createElement('span');
    span.className = 'b';
    span.textContent = BUTTON_LABELS[b] || b.toUpperCase();
    btnWrap.appendChild(span);
    btnRefs[b] = span;
  }

  // Removing frees the seat; that phone can join again on its own.
  node.querySelector('.kick').addEventListener('click', () => {
    send({ t: 'kick', slot: info.slot });
  });

  const dots = node.querySelectorAll('.pad-dot i');
  const entry = {
    info,
    state: initialState || emptyState(),
    node,
    refs: { name: node.querySelector('.pname'), left: dots[0], right: dots[1], btns: btnRefs },
  };

  players.set(info.slot, entry);

  // Keep the grid ordered by slot.
  const after = [...players.keys()].sort((a, b) => a - b).find((s) => s > info.slot);
  if (after !== undefined) el.players.insertBefore(node, players.get(after).node);
  else el.players.appendChild(node);

  updateCount();
  paint(entry);
}

function removePlayer(slot) {
  const entry = players.get(slot);
  if (!entry) return;
  entry.node.remove();
  players.delete(slot);
  updateCount();
}

function paint(entry) {
  const { axes, buttons } = entry.state;
  entry.refs.left.style.transform = `translate(${axes.lx * 15}px, ${axes.ly * 15}px)`;
  entry.refs.right.style.transform = `translate(${axes.rx * 15}px, ${axes.ry * 15}px)`;
  for (const [b, node] of Object.entries(entry.refs.btns)) {
    node.classList.toggle('on', !!buttons[b]);
  }
  // Triggers show up as LB/RB-style lights too.
  entry.refs.btns.lb?.classList.toggle('on', !!buttons.lb || axes.lt > 0.5);
  entry.refs.btns.rb?.classList.toggle('on', !!buttons.rb || axes.rt > 0.5);
}

// -------------------------------------------------------------- networking

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function setStatus(text, cls = '') {
  el.status.textContent = text;
  el.status.className = 'status ' + cls;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    setStatus(t('lobby.serverConnected'), 'ok');
    send({ t: 'hello', role: 'host', name: 'Lobby' });
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case 'welcome':
        maxPlayers = msg.maxPlayers;
        layoutLocked = !!msg.layoutLocked;
        markLayout(msg.layout);
        renderLayoutLock();
        for (const [slot] of [...players]) removePlayer(slot);
        for (const p of msg.players || []) addPlayer(p, p.state);
        updateCount();
        break;
      case 'join':
        addPlayer(msg.player);
        break;
      case 'leave':
        removePlayer(msg.slot);
        break;
      case 'player': {
        const entry = players.get(msg.player.slot);
        if (entry) { entry.info = msg.player; entry.refs.name.textContent = msg.player.name; }
        break;
      }
      case 'input': {
        const entry = players.get(msg.slot);
        if (!entry) break;
        Object.assign(entry.state.buttons, msg.btn || {});
        Object.assign(entry.state.axes, msg.ax || {});
        paint(entry);
        break;
      }
      case 'layout':
        markLayout(msg);
        break;
      case 'config':
        if (msg.maxPlayers) { maxPlayers = msg.maxPlayers; updateCount(); }
        if (msg.layoutLocked !== undefined) {
          layoutLocked = !!msg.layoutLocked;
          renderLayoutLock();
        }
        break;
      default: break;
    }
  };

  ws.onclose = () => {
    setStatus(t('lobby.serverLost'), 'err');
    setTimeout(connect, 1200);
  };
}

el.rumbleAll.addEventListener('click', () => send({ t: 'rumble', slot: 'all', ms: 250, strength: 1 }));

/** Fill in everything that carries text, and redraw on a language change. */
function applyTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-alt]')) {
    node.alt = t(node.dataset.i18nAlt);
  }
  el.bridgeHint.innerHTML = escapeHtml(t('lobby.bridgeHint', { file: ' ' }))
    .replace(' ', '<code>bridge/README.md</code>');

  renderLayoutLock();
  updateCount();
  // Player cards carry translated text, so draw them again.
  for (const entry of players.values()) {
    entry.node.querySelector('.pslot').textContent = t('lobby.player', { slot: entry.info.slot });
    const kick = entry.node.querySelector('.kick');
    kick.textContent = t('lobby.remove');
    kick.title = t('lobby.removeTitle');
  }
  setStatus(ws?.readyState === 1 ? t('lobby.serverConnected') : t('lobby.serverLost'),
            ws?.readyState === 1 ? 'ok' : 'err');
}

function buildLanguageMenu() {
  el.langSelect.innerHTML = '';
  for (const lang of LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.name;
    el.langSelect.appendChild(option);
  }
  el.langSelect.value = getLanguage();
  el.langSelect.addEventListener('change', () => setLanguage(el.langSelect.value));
}

buildLanguageMenu();
applyTranslations();
onLanguageChange(applyTranslations);

loadInfo();
connect();
