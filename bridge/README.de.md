# PocketJoy Bridge – echte Gamepads für Windows und Linux

Normalerweise liest **dein eigenes** Spiel die Handys über
`client/pocketjoy.js`. Dafür brauchst du diese Bridge **nicht**.

Die Bridge ist für den anderen Fall: Sie macht aus jedem verbundenen Handy
einen **echten System-Gamepad**. Dann erkennt *jedes* Spiel auf dem Rechner die
Handys – Steam-Spiele, Unity, Godot, Emulatoren, auch Spiele, die nichts von
PocketJoy wissen.

```
Handy ──WLAN──▶ PocketJoy-Server ──▶ Bridge ──▶ virtueller Xbox-360-Controller
```

Spieler 1 wird Gamepad 1, Spieler 2 wird Gamepad 2, und so weiter.

---

## Erst ohne Treiber ausprobieren

Der Trockenlauf zeigt an, was die Handys senden, ohne irgendetwas zu
installieren. Gut zum Prüfen, ob die Verbindung steht:

```bash
pip install websockets
python bridge/pocketjoy_bridge.py --dry-run
```

Drück ein paar Knöpfe am Handy – es sollte so aussehen:

```
  + Gamepad 1 erstellt  (Stefan)
  P1  bv  ly=-1.00
  P1  b^  ly=+0.00
```

`v` heißt gedrückt, `^` losgelassen.

---

## Windows

```bash
pip install websockets vgamepad
python bridge/pocketjoy_bridge.py
```

`vgamepad` bringt den Treiber **ViGEmBus** mit. Beim ersten Mal fragt Windows
nach Administratorrechten – das ist die Treiberinstallation. Danach einmal neu
starten, falls Spiele den Controller noch nicht sehen.

Prüfen, ob der Treiber bereit ist:

```bash
python bridge/pocketjoy_bridge.py --check
```

Ob Windows die Gamepads sieht: `Win+R` → `joy.cpl`.

**Kraftrückmeldung:** Lässt ein Spiel den Controller vibrieren, leitet die
Bridge das ans Handy weiter – es vibriert tatsächlich mit.

---

## Linux

```bash
pip install websockets evdev
python bridge/pocketjoy_bridge.py
```

Virtuelle Gamepads laufen über `/dev/uinput`. Dafür brauchst du einmalig
Rechte. Entweder schnell mit `sudo python …`, oder sauber und dauerhaft:

```bash
sudo modprobe uinput
echo 'KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/99-pocketjoy.rules
sudo usermod -aG input $USER
```

Danach einmal ab- und wieder anmelden. Prüfen mit:

```bash
python bridge/pocketjoy_bridge.py --check
```

Die Gamepads melden sich als „Microsoft X-Box 360 pad" (Vendor `045e`,
Product `028e`), damit Spiele und Steam sie ohne Extra-Einrichtung erkennen.
Testen lässt sich das mit `evtest` oder `jstest /dev/input/js0`.

**Kraftrückmeldung** gibt es unter Linux (noch) nicht – Vibration vom Spiel
zurück ans Handy funktioniert nur unter Windows.

---

## Optionen

| Option | Bedeutung |
|---|---|
| `--host`, `--port` | Wo der PocketJoy-Server läuft (Standard `localhost:3070`) |
| `--url` | Komplette ws://-Adresse, überschreibt host/port |
| `--dry-run` | Ohne Treiber laufen, nur anzeigen was ankommt |
| `--check` | Nur prüfen, ob der Treiber bereit ist |
| `--keep-pads` | Gamepad behalten, wenn ein Handy die Verbindung verliert |

`--keep-pads` ist nützlich für Spiele, die nervös werden, wenn mitten im Spiel
ein Controller verschwindet (z. B. kurzer WLAN-Aussetzer).

---

## Tastenbelegung

Alles ist auf einen Xbox-360-Controller abgebildet:

| PocketJoy | Xbox / XInput | Linux (evdev) |
|---|---|---|
| `a` `b` `x` `y` | A B X Y | `BTN_SOUTH` `BTN_EAST` `BTN_WEST` `BTN_NORTH` |
| `lb` `rb` | LB RB | `BTN_TL` `BTN_TR` |
| `lt` `rt` | Trigger (analog) | `ABS_Z` `ABS_RZ` |
| `ls` `rs` | Stick-Klicks | `BTN_THUMBL` `BTN_THUMBR` |
| `back` `start` | Back / Start | `BTN_SELECT` `BTN_START` |
| D-Pad | D-Pad | `ABS_HAT0X/Y` |
| `lx` `ly` / `rx` `ry` | Sticks | `ABS_X/Y`, `ABS_RX/RY` |

PocketJoy nutzt wie die Browser-Gamepad-API **„Y nach unten positiv"**.
XInput macht es umgekehrt, deshalb dreht die Bridge unter Windows die
Y-Achsen; unter Linux passt es direkt.

---

## Wenn es nicht läuft

**„Keine Verbindung zum PocketJoy-Server"** – läuft `node server/index.js`?
Standardport ist 3070.

**Das Spiel sieht den Controller nicht** – manche Spiele suchen nur beim Start
nach Controllern. Also zuerst Handys verbinden und Bridge starten, dann das
Spiel.

**Zwei Controller für einen Spieler** – falls ein echter Controller angesteckt
ist, kann die Nummerierung durcheinandergehen. In den Spiel-Einstellungen die
Zuordnung prüfen.

**Steam** erkennt die Pads als Xbox-Controller. Falls die Eingaben doppelt
ankommen, in Steam unter *Controller-Einstellungen* die Xbox-Konfiguration für
das Spiel ausschalten.
