#!/usr/bin/env python3
"""
PocketJoy system bridge.

Turns every phone connected to the PocketJoy server into a real virtual
gamepad, so that ANY game on this machine sees it - Steam games, Unity,
Godot, emulators, whatever.

    Windows:  needs ViGEmBus (installed automatically with `vgamepad`)
    Linux:    needs /dev/uinput (needs permission, see bridge/README.md)

Usage:
    python pocketjoy_bridge.py                 # connects to localhost:3070
    python pocketjoy_bridge.py --port 3070
    python pocketjoy_bridge.py --check         # only test the driver setup

Each phone keeps its virtual pad for as long as it is connected. Player 1
becomes gamepad 1, player 2 gamepad 2, and so on.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import sys

IS_WINDOWS = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")

# Axis/button names come from shared/protocol.js and are Xbox-standard.
BUTTONS = [
    "a", "b", "x", "y",
    "lb", "rb",
    "back", "start",
    "ls", "rs",
    "up", "down", "left", "right",
]


# --------------------------------------------------------------- base class


class VirtualPad:
    """One virtual gamepad. Subclasses do the platform-specific work."""

    def __init__(self, slot: int, name: str = ""):
        self.slot = slot
        self.name = name or f"Spieler {slot}"

    def set_button(self, button: str, pressed: bool) -> None:
        raise NotImplementedError

    def set_axis(self, axis: str, value: float) -> None:
        raise NotImplementedError

    def flush(self) -> None:
        """Send the accumulated state to the OS."""
        raise NotImplementedError

    def close(self) -> None:
        pass


# ------------------------------------------------------------------ windows


class WindowsPad(VirtualPad):
    """Virtual Xbox 360 controller via ViGEmBus."""

    def __init__(self, slot: int, name: str = "", on_rumble=None):
        super().__init__(slot, name)
        import vgamepad as vg

        self._vg = vg
        self.pad = vg.VX360Gamepad()
        self._on_rumble = on_rumble

        self._map = {
            "a": vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
            "b": vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
            "x": vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
            "y": vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
            "lb": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
            "rb": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
            "back": vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
            "start": vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
            "ls": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
            "rs": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
            "up": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
            "down": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
            "left": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
            "right": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
        }

        self._lx = self._ly = self._rx = self._ry = 0.0

        # Force feedback from the game goes back to the phone as vibration.
        if on_rumble is not None:
            try:
                self.pad.register_notification(callback_function=self._notification)
            except Exception:
                pass  # not fatal, just no rumble back

        self.pad.reset()
        self.pad.update()

    def _notification(self, client, target, large_motor, small_motor, led_number, user_data):
        strength = max(large_motor, small_motor) / 255.0
        if self._on_rumble and strength > 0:
            self._on_rumble(self.slot, strength)

    def set_button(self, button: str, pressed: bool) -> None:
        btn = self._map.get(button)
        if btn is None:
            return
        if pressed:
            self.pad.press_button(button=btn)
        else:
            self.pad.release_button(button=btn)

    def set_axis(self, axis: str, value: float) -> None:
        if axis == "lt":
            self.pad.left_trigger_float(value_float=clamp(value, 0.0, 1.0))
        elif axis == "rt":
            self.pad.right_trigger_float(value_float=clamp(value, 0.0, 1.0))
        elif axis in ("lx", "ly"):
            if axis == "lx":
                self._lx = clamp(value, -1.0, 1.0)
            else:
                self._ly = clamp(value, -1.0, 1.0)
            # XInput has +Y pointing up, PocketJoy has +Y pointing down.
            self.pad.left_joystick_float(x_value_float=self._lx, y_value_float=-self._ly)
        elif axis in ("rx", "ry"):
            if axis == "rx":
                self._rx = clamp(value, -1.0, 1.0)
            else:
                self._ry = clamp(value, -1.0, 1.0)
            self.pad.right_joystick_float(x_value_float=self._rx, y_value_float=-self._ry)

    def flush(self) -> None:
        self.pad.update()

    def close(self) -> None:
        try:
            self.pad.reset()
            self.pad.update()
        except Exception:
            pass


# -------------------------------------------------------------------- linux


class LinuxPad(VirtualPad):
    """Virtual Xbox 360 controller via /dev/uinput."""

    def __init__(self, slot: int, name: str = "", on_rumble=None):
        super().__init__(slot, name)
        from evdev import UInput, AbsInfo, ecodes as e

        self._e = e
        self._dirty = False

        stick = AbsInfo(value=0, min=-32768, max=32767, fuzz=16, flat=128, resolution=0)
        trig = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)
        hat = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)

        caps = {
            e.EV_KEY: [
                e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                e.BTN_TL, e.BTN_TR,
                e.BTN_SELECT, e.BTN_START, e.BTN_MODE,
                e.BTN_THUMBL, e.BTN_THUMBR,
            ],
            e.EV_ABS: [
                (e.ABS_X, stick), (e.ABS_Y, stick),
                (e.ABS_RX, stick), (e.ABS_RY, stick),
                (e.ABS_Z, trig), (e.ABS_RZ, trig),
                (e.ABS_HAT0X, hat), (e.ABS_HAT0Y, hat),
            ],
        }

        # Identify as an Xbox 360 pad so games recognise it without extra setup.
        self.ui = UInput(
            caps,
            name=f"PocketJoy Controller {slot}",
            vendor=0x045E,
            product=0x028E,
            version=0x0110,
            bustype=e.BUS_USB,
        )

        self._keys = {
            "a": e.BTN_SOUTH, "b": e.BTN_EAST, "x": e.BTN_WEST, "y": e.BTN_NORTH,
            "lb": e.BTN_TL, "rb": e.BTN_TR,
            "back": e.BTN_SELECT, "start": e.BTN_START,
            "ls": e.BTN_THUMBL, "rs": e.BTN_THUMBR,
        }
        self._dpad = {"up": False, "down": False, "left": False, "right": False}

    def set_button(self, button: str, pressed: bool) -> None:
        e = self._e
        if button in self._keys:
            self.ui.write(e.EV_KEY, self._keys[button], 1 if pressed else 0)
            self._dirty = True
        elif button in self._dpad:
            self._dpad[button] = pressed
            self.ui.write(e.EV_ABS, e.ABS_HAT0X,
                          (1 if self._dpad["right"] else 0) - (1 if self._dpad["left"] else 0))
            self.ui.write(e.EV_ABS, e.ABS_HAT0Y,
                          (1 if self._dpad["down"] else 0) - (1 if self._dpad["up"] else 0))
            self._dirty = True

    def set_axis(self, axis: str, value: float) -> None:
        e = self._e
        if axis in ("lt", "rt"):
            code = e.ABS_Z if axis == "lt" else e.ABS_RZ
            self.ui.write(e.EV_ABS, code, int(clamp(value, 0.0, 1.0) * 255))
        else:
            code = {"lx": e.ABS_X, "ly": e.ABS_Y, "rx": e.ABS_RX, "ry": e.ABS_RY}.get(axis)
            if code is None:
                return
            # evdev uses +Y = down, same as PocketJoy - no flip needed here.
            self.ui.write(e.EV_ABS, code, int(clamp(value, -1.0, 1.0) * 32767))
        self._dirty = True

    def flush(self) -> None:
        if self._dirty:
            self.ui.syn()
            self._dirty = False

    def close(self) -> None:
        try:
            self.ui.close()
        except Exception:
            pass


# ------------------------------------------------------------- dry run pad


class PrintPad(VirtualPad):
    """
    No driver, no system gamepad - just prints what would happen.

    Useful to check that the server connection and the mapping work before
    installing anything, and to see what a phone actually sends.
    """

    def __init__(self, slot: int, name: str = "", on_rumble=None):
        super().__init__(slot, name)
        self.buttons: dict[str, bool] = {}
        self.axes: dict[str, float] = {}
        self._changes: list[str] = []

    def set_button(self, button: str, pressed: bool) -> None:
        if self.buttons.get(button) == pressed:
            return
        self.buttons[button] = pressed
        self._changes.append(f"{button}{'v' if pressed else '^'}")

    def set_axis(self, axis: str, value: float) -> None:
        if abs(self.axes.get(axis, 0.0) - value) < 0.01:
            return
        self.axes[axis] = value
        self._changes.append(f"{axis}={value:+.2f}")

    def flush(self) -> None:
        if not self._changes:
            return
        print(f"  P{self.slot}  " + "  ".join(self._changes))
        self._changes.clear()


# ----------------------------------------------------------------- helpers


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def driver_check() -> tuple[bool, str]:
    """Is a virtual gamepad driver usable on this machine?"""
    if IS_WINDOWS:
        try:
            import vgamepad  # noqa: F401
        except ImportError:
            return False, (
                "Das Paket 'vgamepad' fehlt.\n"
                "    pip install vgamepad\n"
                "Beim ersten Import installiert es den ViGEmBus-Treiber "
                "(Windows fragt nach Administratorrechten)."
            )
        try:
            import vgamepad as vg
            pad = vg.VX360Gamepad()
            del pad
            return True, "ViGEmBus ist bereit."
        except Exception as err:
            return False, (
                f"ViGEmBus antwortet nicht ({err}).\n"
                "Installiere den Treiber von https://github.com/nefarius/ViGEmBus/releases "
                "und starte danach den Rechner neu."
            )

    if IS_LINUX:
        try:
            from evdev import UInput
        except ImportError:
            return False, "Das Paket 'evdev' fehlt.\n    pip install evdev"
        try:
            ui = UInput()
            ui.close()
            return True, "/dev/uinput ist beschreibbar."
        except PermissionError:
            return False, (
                "Keine Rechte fuer /dev/uinput.\n"
                "Entweder mit sudo starten, oder dauerhaft freigeben:\n"
                "    sudo modprobe uinput\n"
                "    echo 'KERNEL==\"uinput\", MODE=\"0660\", GROUP=\"input\", OPTIONS+=\"static_node=uinput\"' "
                "| sudo tee /etc/udev/rules.d/99-pocketjoy.rules\n"
                "    sudo usermod -aG input $USER     # danach neu anmelden"
            )
        except Exception as err:
            return False, f"/dev/uinput laesst sich nicht oeffnen: {err}"

    return False, (
        f"Virtuelle Gamepads werden auf {platform.system()} nicht unterstuetzt.\n"
        "Deine eigenen Web-Spiele funktionieren trotzdem - dafuer brauchst du "
        "die Bridge gar nicht, nur client/pocketjoy.js."
    )


def make_pad(slot: int, name: str, on_rumble, dry_run: bool = False) -> VirtualPad:
    if dry_run:
        return PrintPad(slot, name, on_rumble)
    if IS_WINDOWS:
        return WindowsPad(slot, name, on_rumble)
    if IS_LINUX:
        return LinuxPad(slot, name, on_rumble)
    raise RuntimeError(f"Keine Unterstuetzung fuer {platform.system()}")


# -------------------------------------------------------------------- main


class Bridge:
    def __init__(self, url: str, keep_pads: bool = False, dry_run: bool = False):
        self.url = url
        self.keep_pads = keep_pads
        self.dry_run = dry_run
        self.pads: dict[int, VirtualPad] = {}
        self.ws = None
        self.loop = None

    # Called from the ViGEm notification thread, so hop back onto the loop.
    def _rumble_back(self, slot: int, strength: float):
        if self.ws is None or self.loop is None:
            return
        msg = json.dumps({"t": "rumble", "slot": slot, "ms": 180, "strength": round(strength, 2)})
        try:
            asyncio.run_coroutine_threadsafe(self.ws.send(msg), self.loop)
        except Exception:
            pass

    def ensure_pad(self, slot: int, name: str = "") -> VirtualPad:
        pad = self.pads.get(slot)
        if pad is None:
            pad = make_pad(slot, name, self._rumble_back, self.dry_run)
            self.pads[slot] = pad
            print(f"  + Gamepad {slot} erstellt  ({pad.name})")
        return pad

    def drop_pad(self, slot: int) -> None:
        if self.keep_pads:
            return
        pad = self.pads.pop(slot, None)
        if pad is not None:
            pad.close()
            print(f"  - Gamepad {slot} entfernt")

    def close_all(self) -> None:
        for pad in self.pads.values():
            pad.close()
        self.pads.clear()

    async def run(self) -> int:
        import websockets

        self.loop = asyncio.get_running_loop()
        print(f"\nPocketJoy Bridge\n  Server: {self.url}")

        try:
            async with websockets.connect(self.url, max_queue=64) as ws:
                self.ws = ws
                await ws.send(json.dumps({"t": "hello", "role": "bridge", "name": "system-gamepads"}))
                print("  Verbunden. Jedes verbundene Handy wird zu einem Gamepad.")
                print("  Strg+C beendet die Bridge.\n")

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    self.handle(msg)
        except KeyboardInterrupt:
            pass
        except OSError as err:
            print(f"\n  Keine Verbindung zum PocketJoy-Server: {err}")
            print("  Laeuft der Server? (node server/index.js)\n")
            return 1
        finally:
            self.close_all()
            print("\n  Bridge beendet.\n")
        return 0

    def handle(self, msg: dict) -> None:
        kind = msg.get("t")

        if kind == "welcome":
            for p in msg.get("players", []):
                pad = self.ensure_pad(p["slot"], p.get("name", ""))
                state = p.get("state") or {}
                for btn, down in (state.get("buttons") or {}).items():
                    pad.set_button(btn, bool(down))
                for ax, val in (state.get("axes") or {}).items():
                    pad.set_axis(ax, float(val))
                pad.flush()

        elif kind == "join":
            p = msg.get("player", {})
            self.ensure_pad(p.get("slot"), p.get("name", ""))

        elif kind == "leave":
            self.drop_pad(msg.get("slot"))

        elif kind == "input":
            slot = msg.get("slot")
            pad = self.pads.get(slot) or self.ensure_pad(slot)
            for btn, down in (msg.get("btn") or {}).items():
                pad.set_button(btn, bool(down))
            for ax, val in (msg.get("ax") or {}).items():
                try:
                    pad.set_axis(ax, float(val))
                except (TypeError, ValueError):
                    pass
            pad.flush()


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Macht aus jedem verbundenen Handy einen echten Gamepad (Windows/Linux).",
    )
    ap.add_argument("--host", default="localhost", help="Adresse des PocketJoy-Servers")
    ap.add_argument("--port", type=int, default=3070, help="Port des PocketJoy-Servers")
    ap.add_argument("--url", default=None, help="Vollstaendige ws://-URL (ueberschreibt host/port)")
    ap.add_argument("--keep-pads", action="store_true",
                    help="Gamepads behalten, wenn ein Handy die Verbindung verliert")
    ap.add_argument("--check", action="store_true", help="Nur die Treiber-Einrichtung pruefen")
    ap.add_argument("--dry-run", action="store_true",
                    help="Ohne Treiber laufen und nur anzeigen, was die Handys senden")
    args = ap.parse_args()

    if args.dry_run:
        print("\n  Trockenlauf: es wird KEIN echter Gamepad erstellt.")
    else:
        ok, message = driver_check()
        print(f"\n  Treiber: {message}")
        if args.check:
            return 0 if ok else 1
        if not ok:
            return 1

    try:
        import websockets  # noqa: F401
    except ImportError:
        print("\n  Das Paket 'websockets' fehlt.\n    pip install websockets\n")
        return 1

    url = args.url or f"ws://{args.host}:{args.port}/ws"
    bridge = Bridge(url, keep_pads=args.keep_pads, dry_run=args.dry_run)
    try:
        return asyncio.run(bridge.run())
    except KeyboardInterrupt:
        bridge.close_all()
        print("\n  Bridge beendet.\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
