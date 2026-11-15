# PocketJoy Bridge — real gamepads on Windows and Linux

Normally **your own** game reads the phones through `client/pocketjoy.js`.
For that you do **not** need this bridge.

The bridge is for the other case: it turns every connected phone into a real
**system gamepad**. Then *any* game on the machine sees them — Steam games,
Unity, Godot, emulators, anything that has never heard of PocketJoy.

```
Phone ──Wi-Fi──▶ PocketJoy server ──▶ bridge ──▶ virtual Xbox 360 controller
```

Player 1 becomes gamepad 1, player 2 becomes gamepad 2, and so on.

---

## Try it without installing drivers

The dry run shows what the phones are sending without installing anything.
Good for checking that the connection works:

```bash
pip install websockets
python bridge/pocketjoy_bridge.py --dry-run
```

Press a few buttons on the phone and you should see:

```
  + Gamepad 1 erstellt  (Alex)
  P1  bv  ly=-1.00
  P1  b^  ly=+0.00
```

`v` means pressed, `^` released.

---

## Windows

```bash
pip install websockets vgamepad
python bridge/pocketjoy_bridge.py
```

`vgamepad` ships the **ViGEmBus** driver. The first time, Windows will ask
for administrator rights — that is the driver installation. Reboot once if
games do not see the controller yet.

Check whether the driver is ready:

```bash
python bridge/pocketjoy_bridge.py --check
```

To see whether Windows recognises the pads: `Win+R` → `joy.cpl`.

**Force feedback:** when a game makes the controller rumble, the bridge
passes that on to the phone, which actually vibrates.

---

## Linux

```bash
pip install websockets evdev
python bridge/pocketjoy_bridge.py
```

Virtual gamepads go through `/dev/uinput`, which needs permission once.
Either quickly with `sudo python …`, or properly and permanently:

```bash
sudo modprobe uinput
echo 'KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/99-pocketjoy.rules
sudo usermod -aG input $USER
```

Then log out and back in. Verify with:

```bash
python bridge/pocketjoy_bridge.py --check
```

The pads identify as "Microsoft X-Box 360 pad" (vendor `045e`, product
`028e`) so games and Steam recognise them without extra setup. Test with
`evtest` or `jstest /dev/input/js0`.

**Force feedback** is not implemented on Linux yet — rumble from the game
back to the phone works on Windows only.

---

## Options

| Option | Meaning |
|---|---|
| `--host`, `--port` | where the PocketJoy server runs (default `localhost:3070`) |
| `--url` | full ws:// address, overrides host/port |
| `--dry-run` | run without drivers, just show what arrives |
| `--check` | only verify that the driver is ready |
| `--keep-pads` | keep a gamepad when a phone loses its connection |

`--keep-pads` helps with games that get upset when a controller disappears
mid-session (a brief Wi-Fi dropout, for instance).

---

## Button mapping

Everything maps onto an Xbox 360 controller:

| PocketJoy | Xbox / XInput | Linux (evdev) |
|---|---|---|
| `a` `b` `x` `y` | A B X Y | `BTN_SOUTH` `BTN_EAST` `BTN_WEST` `BTN_NORTH` |
| `lb` `rb` | LB RB | `BTN_TL` `BTN_TR` |
| `lt` `rt` | triggers (analog) | `ABS_Z` `ABS_RZ` |
| `ls` `rs` | stick clicks | `BTN_THUMBL` `BTN_THUMBR` |
| `back` `start` | Back / Start | `BTN_SELECT` `BTN_START` |
| d-pad | d-pad | `ABS_HAT0X/Y` |
| `lx` `ly` / `rx` `ry` | sticks | `ABS_X/Y`, `ABS_RX/RY` |

Like the browser Gamepad API, PocketJoy uses **Y positive = down**. XInput
does the opposite, so the bridge flips the Y axes on Windows; on Linux they
line up directly.

---

## Known limitation

This has been verified in dry run only — the connection, the protocol and the
mapping are tested, but never against an actual ViGEmBus or uinput device.
Reports from real setups are welcome.

---

## If it does not work

**"Keine Verbindung zum PocketJoy-Server"** — is `node server/index.js`
running? The default port is 3070.

**The game does not see the controller** — some games only look for
controllers at startup. Connect the phones and start the bridge first, then
the game.

**Two controllers for one player** — if a real controller is plugged in, the
numbering can get confused. Check the game's controller assignment.

**Steam** recognises the pads as Xbox controllers. If input arrives twice,
turn off Steam's Xbox configuration support for that game.
