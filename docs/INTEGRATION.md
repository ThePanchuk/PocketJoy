# Integrating PocketJoy into a game

A self-contained guide for adding phone controllers to a browser game. It
assumes nothing beyond the game itself and is written so an assistant can
follow it from this file alone.

Repository: https://github.com/ThePanchuk/PocketJoy

---

## 1. Which mode does this game need?

This is the only decision that matters, and it follows from where the game
will be played — not from the game itself.

| The game is served from | Use | Why |
|---|---|---|
| `https://` on the public web (itch.io, your own site) | **Web mode** | A page on https may not open a `ws://` connection into a local network. Browsers block it. WebRTC is not affected by that rule. |
| A player's own machine (downloaded, or served by PocketJoy itself) | **Local mode** | Simplest path. Also the only one that can expose phones as real system gamepads. |

If unsure: a game uploaded to itch.io as a **web game** needs web mode. A game
uploaded as a **downloadable zip** can use local mode.

---

## 2. Local mode

The PocketJoy server runs on the player's machine next to the game.

### Files to copy

One file: `client/pocketjoy.js`. It has no imports and no dependencies.

### Code

```js
import { PocketJoy } from './pocketjoy.js';

const pj = new PocketJoy({ layout: 'dual-stick', maxPlayers: 4 });
await pj.connect();          // finds the server on port 3070 of this machine
```

### Running it

The player starts PocketJoy (`npm start` in the PocketJoy folder) and opens
the game. If the game is served by PocketJoy itself — put the game folder
inside it and reach it at `/your-game/` — everything comes from one address
and nothing else is needed.

---

## 3. Web mode (itch.io, your own website)

The game page itself manages the players. Phones connect **directly** to it
over WebRTC, introduced by a small signalling service.

### What has to be hosted

You need **one** PocketJoy server reachable over `https://`. It does two
things, and only these:

1. serves `/signal` so a phone and a game can find each other;
2. serves `/pad` — the controller page the phones open.

It never sees input, names or layouts. One instance can serve any number of
games and rooms.

```bash
# On a small server somewhere:
git clone https://github.com/ThePanchuk/PocketJoy
cd PocketJoy && npm install
node server/index.js --port 3070
```

Behind a reverse proxy for HTTPS. With Caddy that is one line:

```
pocketjoy.your-domain.com {
    reverse_proxy localhost:3070
}
```

**Without this, web mode cannot work.** There is no public instance to borrow.

### Getting the library into the game

Two options.

**a) Load it from your PocketJoy host** (simplest — the server sends the
CORS header for `/client/` and `/shared/`):

```js
const { PocketJoyWeb } =
  await import('https://pocketjoy.your-domain.com/client/pocketjoy-web.js');
```

**b) Copy the files** if you would rather not depend on the host at load
time. Six files, and the two folders must stay side by side:

```
your-game/
  client/pocketjoy-web.js
  client/pocketjoy.js
  shared/hub.js
  shared/protocol.js
  shared/ids.js
  shared/rtc.js
```

### Code

```js
const pj = new PocketJoyWeb({
  signaling: 'wss://pocketjoy.your-domain.com/signal',
  layout: 'dual-stick',
  maxPlayers: 4,
});

pj.on('room', (code, padUrl) => {
  showCode(code);        // e.g. "K7M2" - players type this on their phone
  showLink(padUrl);      // or show it as a QR code
});

await pj.connect();
```

Show the room code prominently on screen. That is how players get in: they
open `padUrl` (or the host's `/pad`) and enter the code.

### Players outside the local network

Everyone in the same Wi-Fi connects directly, with no extra service. For a
player on mobile data you need a TURN relay, configured on the **server**:

```bash
POCKETJOY_STUN=stun:stun.your-domain.com:3478 \
POCKETJOY_TURN=turn:turn.your-domain.com:3478 \
POCKETJOY_TURN_SECRET=the-same-secret-as-in-coturn \
node server/index.js
```

Nothing changes in the game. Credentials are generated per connection with a
short expiry and reach both sides automatically.

---

## 4. Reading input — identical in both modes

```js
function frame() {
  for (const p of pj.players) {
    const move = p.dir('left');          // { x, y, len, angle }, deadzone applied
    player[p.slot].x += move.x * speed;

    if (p.pressed('a')) shoot(p);        // true only on the frame it went down
    if (p.down('rt')) accelerate(p);     // true while held
  }

  pj.update();                           // REQUIRED, once per frame
  requestAnimationFrame(frame);
}
```

| Call | Returns |
|---|---|
| `p.down(button)` | held right now |
| `p.pressed(button)` / `p.released(button)` | changed since the last `pj.update()` |
| `p.axis(name)` | single axis, -1…1 (triggers 0…1) |
| `p.stick('left'\|'right')` | `{ x, y }` |
| `p.dir('left', deadzone)` | `{ x, y, len, angle }`, length capped at 1 |
| `p.rumble(ms, strength)` | buzz that phone |
| `p.kick()` | remove that player |
| `p.slot` `p.name` `p.color` | seat (1…8), name, colour |
| `pj.players` `pj.player(slot)` `pj.count` | who is connected |
| `pj.setLayout(id\|layout, lock?)` | change the controller for everyone |
| `pj.rumbleAll(ms)` | buzz all phones |

Events: `pj.on('join'|'leave'|'press'|'release'|'player'|'layout'|'connect'|'disconnect'|'error', fn)`

**Buttons:** `a b x y lb rb lt rt back start ls rs up down left right`
**Axes:** `lx ly rx ry` (-1…1) and `lt rt` (0…1)

---

## 5. Layouts

The game decides what every phone shows. Players choose nothing.

| id | Shows |
|---|---|
| `dual-stick` | two sticks, A/B, shoulder buttons |
| `single-stick` | one stick, two large buttons |
| `platformer` | d-pad left, jump right |
| `racing` | steering slider, accelerator and brake |
| `gamepad` | everything an Xbox pad has |
| `buttons` | four large buttons (party, quiz) |
| `buzzer` | one huge button |

```js
pj.setLayout('racing');              // switch any time, reaches phones at once
pj.setLayout('buttons', true);       // ...and stop the lobby overriding it
```

A game can also bring its own:

```js
pj.setLayout({
  name: 'Fishing',
  controls: [
    { kind: 'stick',  id: 'left', x: 22, y: 55, size: 55 },
    { kind: 'button', id: 'a', x: 72, y: 62, size: 30, label: 'Cast' },
  ],
});
```

`kind`: `stick` (id `left`/`right`), `dpad`, `button` (id = a button name),
`trigger` (id `lt`/`rt`), `steer`. `x`/`y` are percentages of the **landscape**
area, `size` is a percentage of its **height**. `label` overrides the caption.
The server validates every layout: unknown kinds are dropped, out-of-range
values clamped, an unusable layout rejected with an `error` event.

---

## 6. Things that bite

Collected from real devices, not theory.

- **`pj.update()` once per frame.** Without it `pressed()` stays true forever
  and every shot fires continuously.
- **`y = -1` is up**, as in the browser Gamepad API.
- **Store game state by `p.slot`, not on the player object.** Players
  disconnect and come back; the slot is stable, the object is not.
- **Do not assume a fixed number of players.** Phones join and leave
  mid-game. `maxPlayers` is a ceiling, not a promise.
- **Use `p.color`.** It is the colour that phone shows and the lobby shows.
  Matching it in the game makes "which one am I" obvious without explaining.
- **An https page cannot reach `ws://`.** This is the single most common
  mistake; see section 1. The library detects it and throws a clear error.
- **Web mode needs a hosted signalling service.** There is no way around it.
- **The room code is the only barrier in web mode.** No authentication
  exists. Do not use PocketJoy where unwanted participants would matter.
- **Reloading the game page in web mode drops every player** — the player
  management lives in that tab. In local mode the server survives a reload.
- **The d-pad is mirrored onto the left stick**, so reading `stick('left')`
  works with every layout, including `platformer`.

---

## 7. Before releasing

- Tested with a real phone, not just a second browser tab.
- The join link or room code is visible **in the game**, not only in a README.
- The game survives a player leaving mid-round (`pj.on('leave')`).
- Web mode: signalling service reachable over https and actually running.
- Web mode: decide whether players outside the Wi-Fi should work (TURN).
- Layout fits the game — a jump-and-run with `dual-stick` feels wrong.

---

## 8. Quick reminders for an assistant

- The library is **plain ES modules**. No build step, no bundler, no npm
  dependency in the game.
- Local mode: **one file**, `client/pocketjoy.js`.
- Web mode: `PocketJoyWeb` instead of `PocketJoy`, plus a `signaling` URL.
  Everything after `connect()` is identical.
- The phone UI (`web/pad/`) is **not** part of the game. It is served by the
  PocketJoy host.
- Do not reimplement the protocol. If something seems missing, check
  `shared/protocol.js` in the repository first.
