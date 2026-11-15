# PocketJoy

Handys als Spielecontroller im lokalen Netzwerk. Für Couch-Koop-Spiele: alle
sitzen auf dem Sofa, jeder nimmt sein Handy, keiner braucht einen Gamepad.

```
Handy ──┐
Handy ──┼── WLAN ──▶ PocketJoy-Server ──┬──▶ dein Web-Spiel (client/pocketjoy.js)
Handy ──┘                               └──▶ echte System-Gamepads (bridge/)
```

Niemand muss etwas installieren: Die Mitspieler öffnen eine URL im
Handy-Browser und haben Sticks und Knöpfe auf dem Display.

---

## Schnellstart

```bash
npm install
npm start
```

Im Terminal erscheint eine URL samt QR-Code:

```
  Handy-Controller:  http://192.168.0.122:3070/pad
  Lobby (hier):      http://localhost:3070/
  Demo-Spiel:        http://localhost:3070/demo
```

QR-Code scannen oder die URL ins Handy tippen – fertig, das Handy ist
Spieler 1. Weitere Handys werden Spieler 2, 3, 4.

**Ein Handy ist genau ein Spieler.** Öffnet dasselbe Gerät den Controller ein
zweites Mal, übernimmt das neue Fenster den Platz – das alte meldet sich ab,
statt einen zweiten Platz zu belegen. Genau dadurch funktioniert auch der
Wiedereinstieg: Nach einem WLAN-Aussetzer, einem Neuladen oder gesperrtem
Display reicht das erneute Öffnen der URL, und man ist sofort wieder im
eigenen Platz, mit demselben Namen. Niemand muss warten, bis die alte
Verbindung abgelaufen ist.

**Spieler lassen sich entfernen.** In der Lobby hat jede Spielerkarte einen
„Entfernen"-Knopf – praktisch, wenn jemand gegangen ist und seinen Platz noch
blockiert. Der Platz ist sofort frei, und das Handy bleibt draußen, bis es
selbst wieder beitritt (ein Tipp auf „Wieder beitreten"). Aus dem Spiel heraus
geht dasselbe mit `p.kick()`.

**Das erste Handy führt die Runde.** Wer sich zuerst verbindet, wird
*Hauptcontroller* und bekommt im Menü (⋯ unten links) den Punkt
**Übersicht**. Dort sieht er alle Mitspieler, kann einzelne entfernen und für
alle ein anderes Controller-Layout wählen – jeweils mit Vorschaubild. Das
klappt in beiden Betriebsarten; im Web-Modus steht dort zusätzlich der
Raum-Code, weil es dann keine Lobby auf einem Bildschirm gibt.

Verlässt der Hauptcontroller die Runde, übernimmt automatisch das nächste
Handy – niemand bleibt ohne Steuerung zurück. Sich selbst kann er nicht
entfernen, und ein Spiel, das sein Layout festhält (`lockLayout`), hat
weiterhin Vorrang: Dann sind die Layout-Kacheln auch für ihn gesperrt.

**Der Name kommt mit zurück.** Beim Wiedereinstieg steht er schon im
Eingabefeld – auch auf einem Handy, das selbst nichts speichert, denn der
Server merkt sich ausgeschiedene Spieler zehn Minuten lang mitsamt Platz und
Namen.

Zum Testen mehrerer Spieler von **einem** Rechner aus gibt es
`http://localhost:3070/pad?new` – jeder so geöffnete Tab ist ein eigener
Spieler.

Mit `?test` legt das Pad außerdem `window.__pj` offen; damit lässt sich etwa
ein Netzwechsel auslösen (`__pj.simulateNetworkChange()`), ohne dafür mit dem
Handy aus der WLAN-Reichweite laufen zu müssen.

**Das Querformat kommt von selbst.** Hält jemand das Handy aufrecht, dreht
sich der Controller einfach mit – ohne Drehsperre im Handy auszuschalten und
ohne „bitte drehen"-Meldung. Handy nach links kippen, und es passt.

Ausprobieren:

```bash
npm run demo
```

Das startet den Server und öffnet die **Arena** – ein kleines Spiel für vier
Leute. Linker Stick laufen, rechter Stick zielen, A schießen.

Wichtig ist nur: Handy und Rechner im **gleichen WLAN**.

### Ohne Terminal starten (Windows)

```bash
npm run install:windows
```

Baut `PocketJoy.exe` und fragt, ob eine Verknüpfung auf dem Desktop und im
Startmenü angelegt werden soll. Ein Doppelklick startet dann den Server und
öffnet die Lobby.

Die exe enthält Node und läuft deshalb auch auf Rechnern ohne
Node-Installation – dafür ist sie rund 70 MB groß und liegt nicht im
Repository. Sie muss **im Projektordner bleiben**: Sie ist ein Starter für den
Code daneben, keine Kopie davon. Rückgängig mit
`npm run install:windows -- --remove` – es wird nichts registriert, die
Verknüpfungen sind einfache Dateien.

Beim ersten Start kann Windows SmartScreen warnen. Die exe ist eine
veränderte Kopie von `node.exe`, wodurch deren Signatur ungültig wird – ohne
eine kostenpflichtige Code-Signatur nicht vermeidbar.

### Optionen

```bash
node server/index.js --port 3070 --players 4 --layout dual-stick
```

| Option | Bedeutung |
|---|---|
| `--port`, `-p` | Port (Standard 3070) |
| `--players`, `-n` | Maximale Spielerzahl, 1–8 (Standard 4) |
| `--layout`, `-l` | Start-Layout (siehe unten) |
| `--open` / `--demo` | Lobby bzw. Demo im Browser öffnen |

---

## PocketJoy in ein eigenes Projekt einbinden

Für Entwickler, die PocketJoy als Controller-Schicht benutzen wollen. Das
Prinzip: **Der PocketJoy-Server läuft neben deinem Spiel**, die Handys reden
mit ihm, und dein Spiel holt sich die Eingaben über eine kleine Bibliothek ab.
Dein Spiel muss selbst keinen Server betreiben und nichts über WebSockets
wissen.

```
Handys ──▶ PocketJoy-Server (Port 3070) ──▶ dein Spiel (beliebiger Port)
```

### 1. Server verfügbar machen

PocketJoy muss laufen, bevor dein Spiel sich verbinden kann:

```bash
cd Pfad/zu/PocketJoy && npm start
```

Für ein eigenes Projekt lohnt sich ein Eintrag in dessen `package.json`, damit
beides zusammen startet – etwa mit `concurrently`:

```json
"scripts": {
  "dev": "concurrently \"node ../PocketJoy/server/index.js\" \"vite\""
}
```

### 2. Bibliothek einbinden

Kopiere `client/pocketjoy.js` in dein Projekt und importiere es ganz normal.
Die Datei hat keine Abhängigkeiten und ist reines ES-Modul:

```js
import { PocketJoy } from './pocketjoy.js';
```

Alternativ lädst du sie direkt vom laufenden Server – praktisch, wenn du sie
nicht mitversionieren willst:

```js
const { PocketJoy } = await import('http://localhost:3070/client/pocketjoy.js');
```

### 3. Verbinden und loslegen

```js
import { PocketJoy } from './pocketjoy.js';

const pj = new PocketJoy({ layout: 'dual-stick', maxPlayers: 4 });
await pj.connect();

function frame() {
  for (const p of pj.players) {
    const move = p.dir('left');          // { x, y, len, angle }
    spieler[p.slot].x += move.x * 5;
    spieler[p.slot].y += move.y * 5;

    if (p.pressed('a')) schiessen(p);    // nur im Moment des Drückens
    if (p.down('rt')) gasGeben(p);       // solange gehalten
  }

  pj.update();                           // am Ende jedes Frames!
  requestAnimationFrame(frame);
}
```

Läuft dein Spiel auf einem anderen Port (z. B. Vite auf 3040), findet die
Bibliothek den PocketJoy-Server trotzdem – sie sucht standardmäßig auf
Port 3070 desselben Rechners. Anderer Port: `new PocketJoy({ port: 1234 })`.

### Spieler-API

| Aufruf | Ergebnis |
|---|---|
| `p.down('a')` | Knopf ist gerade gedrückt |
| `p.pressed('a')` | Knopf wurde seit dem letzten `pj.update()` gedrückt |
| `p.released('a')` | … losgelassen |
| `p.stick('left')` | `{ x, y }`, jeweils −1 … 1 |
| `p.dir('right')` | wie `stick`, aber mit Totzone und `len` / `angle` |
| `p.axis('rt')` | einzelne Achse |
| `p.rumble(200)` | Handy vibrieren lassen |
| `p.kick()` | Spieler entfernen, Platz freigeben (kein Bann) |
| `p.slot` `p.name` `p.color` | Spielernummer, Name, Farbe |

**Knöpfe:** `a` `b` `x` `y` `lb` `rb` `lt` `rt` `back` `start` `ls` `rs`
`up` `down` `left` `right`

**Achsen:** `lx` `ly` `rx` `ry` (−1 … 1) und `lt` `rt` (0 … 1).
Wie bei der Gamepad-API im Browser ist **`y = −1` oben**.

Das D-Pad wird zusätzlich auf den linken Stick gelegt. Ein Spiel, das
`stick('left')` liest, funktioniert deshalb mit jedem Layout.

Trigger zählen auch als Knöpfe: `p.down('rt')` ist wahr ab halbem Druck.

### Pad-Objekt

| Aufruf | Ergebnis |
|---|---|
| `pj.players` | Alle Spieler, nach Slot sortiert |
| `pj.player(2)` | Spieler in Slot 2 (oder `null`) |
| `pj.count` | Anzahl verbundener Handys |
| `pj.update()` | `pressed()`/`released()` zurücksetzen – einmal pro Frame |
| `pj.setLayout('racing')` | Layout auf allen Handys umschalten |
| `pj.rumbleAll(200)` | Alle vibrieren lassen |

### Ereignisse

```js
pj.on('join',  (p) => console.log(p.name, 'ist dabei'));
pj.on('leave', (p) => spielerEntfernen(p.slot));
pj.on('press', (p, knopf) => { if (knopf === 'start') spielStarten(); });
```

Dazu `release`, `connect`, `disconnect`, `player` (Name geändert), `layout`
und `error` (mit einem Grund, etwa `bad-layout`).

### Typischer Ablauf in einem Spiel

```js
const pj = new PocketJoy({ layout: 'buttons', maxPlayers: 4, lockLayout: true });
await pj.connect();

pj.on('join', (p) => {
  lobbyAnzeigen(p.slot, p.name, p.color);   // Farbe passt zur Handy-Anzeige
  p.rumble(120);                            // kurz spüren: „du bist drin"
});

pj.on('leave', (p) => spielerPausieren(p.slot));

pj.on('press', (p, knopf) => {
  if (knopf === 'start' && !läuft) spielStarten();
});

function spielStarten() {
  pj.setLayout('dual-stick');   // ab jetzt der echte Controller
  läuft = true;
}
```

### Stolpersteine

- **`pj.update()` am Ende jedes Frames** – sonst bleibt `pressed()` dauerhaft
  wahr und jeder Knopfdruck zählt endlos.
- **Spieler verschwinden und kommen wieder.** `p.slot` ist stabil (1–8),
  Objekte aus `pj.players` sind es nicht – merke dir Spielstände unter `slot`,
  nicht am Spieler-Objekt.
- **Die Farbe mitbenutzen.** `p.color` ist dieselbe, die auf dem Handy und in
  der Lobby leuchtet. Wer sie im Spiel übernimmt, macht die Zuordnung ohne
  Erklärung klar.
- **Nicht auf eine feste Spielerzahl bauen.** Handys kommen mitten im Spiel
  dazu oder fallen weg; `maxPlayers` ist eine Obergrenze, keine Garantie.
- **Kein HTTPS.** Eine über `https://` ausgelieferte Seite darf keine
  `ws://`-Verbindung öffnen. Für Couch-Koop im eigenen WLAN ist `http://`
  der richtige Weg.

---

## Sprachen

Die Oberflächen sprechen **acht Sprachen**: Englisch (Standard), Deutsch,
Español, Français, Italiano, Português, Русский und 中文.

Welche Sprache erscheint, entscheidet das Gerät: Jedes Handy richtet sich nach
seinen eigenen Browser-Einstellungen. In einer gemischten Runde sieht also
jeder seine eigene Sprache, ohne dass jemand etwas einstellen muss. Wer eine
andere möchte, wählt sie im Menü (⋯ unten links) oder in der Lobby oben
rechts; die Wahl merkt sich das Gerät. Umgeschaltet wird **sofort**, ohne
Neuladen und ohne die Verbindung zu verlieren – auch mitten im Spiel.

Übersetzt ist alles, was Mitspieler sehen: Controller, Lobby, Demos, die
Layout-Namen und sogar die Tastenbeschriftungen (aus „Gas" wird
„Accélérer", „油门", …).

Die Terminal-Ausgabe des Servers folgt derselben Liste:

```bash
node server/index.js --lang de
```

Standard ist Englisch; alternativ geht `POCKETJOY_LANG=de`. Ob nicht-lateinische
Schrift im Terminal lesbar ankommt, hängt allerdings von dessen Einstellungen
ab – im Browser spielt das keine Rolle.

### Eine Sprache ergänzen

Alles steckt in `shared/i18n.js`: Sprachcode in `LANGUAGES` eintragen, Texte
in `STRINGS` ergänzen. Was fehlt, fällt automatisch auf Englisch zurück –
eine halbfertige Übersetzung macht also nichts kaputt. `npm run test:lang`
sagt, was noch fehlt und ob irgendwo ein Platzhalter wie `{slot}` verloren
ging.

Arabisch und Hebräisch fehlen bewusst: Die brauchen gespiegelte Layouts, und
halbherzig wäre schlechter als gar nicht.

Layouts, die ein **Spiel selbst mitbringt**, behalten ihre eigenen
Beschriftungen – die kennt PocketJoy nicht und kann sie nicht übersetzen.

---

## Layouts

Das Spiel wählt ein Layout, alle Handys zeigen es sofort an.

| ID | Zeigt |
|---|---|
| `dual-stick` | Zwei Sticks, A/B, Schultertasten – Twin-Stick-Shooter |
| `single-stick` | Ein Stick, zwei große Knöpfe |
| `platformer` | D-Pad links, Sprung rechts |
| `racing` | Lenk-Schieber, Gas und Bremse |
| `gamepad` | Alles: zwei Sticks, D-Pad, ABXY, Schultertasten, Trigger |
| `buttons` | Vier große Knöpfe – Party- und Quizspiele |
| `buzzer` | Ein einziger riesiger Knopf |

### Das Spiel bestimmt das Layout

Dein Spiel legt fest, was auf **allen** Handys erscheint – niemand muss etwas
auswählen. Beim Verbinden:

```js
const pj = new PocketJoy({ layout: 'platformer', maxPlayers: 4 });
```

Jedes Handy, das danach dazukommt, bekommt dieses Layout automatisch.

Jederzeit umschalten, etwa beim Wechsel der Spielphase:

```js
pj.setLayout('buttons');     // Menü: nur Knöpfe
pj.setLayout('racing');      // Rennen: Lenkung, Gas, Bremse
pj.setLayout('dual-stick');  // Kampf: zwei Sticks
```

Der Wechsel erreicht alle Handys sofort – ohne Neuladen.

### Layout gegen die Lobby verteidigen

Standardmäßig darf auch die Lobby das Layout umstellen, was beim Ausprobieren
praktisch ist. Wenn dein Spiel das nicht gebrauchen kann, sperrst du es:

```js
const pj = new PocketJoy({ layout: 'racing', lockLayout: true });
```

Solange dein Spiel verbunden ist, sind die Layout-Knöpfe in der Lobby dann
gesperrt und mit einem Hinweis versehen. Dein Spiel selbst darf weiter
wechseln. Trennt es die Verbindung, gibt der Server die Lobby von allein
wieder frei – eine abgestürzte Spielinstanz blockiert also nichts dauerhaft.

Sperre im laufenden Betrieb setzen oder lösen:

```js
pj.setLayout('racing', true);   // setzen und sperren
pj.setLayout('buttons', false); // setzen und wieder freigeben
```

### Eigenes Layout mitbringen

Reicht kein Preset, schickt dein Spiel eine eigene Anordnung. Sie wird genauso
übertragen wie ein Preset – das Handy braucht dafür nichts zu wissen:

```js
pj.setLayout({
  name: 'Angeln',
  hint: 'Auswerfen und kurbeln',
  controls: [
    { kind: 'stick',  id: 'left',  x: 22, y: 55, size: 55 },
    { kind: 'button', id: 'a',     x: 72, y: 62, size: 30, label: 'Werfen' },
    { kind: 'button', id: 'b',     x: 91, y: 30, size: 22, label: 'Kurbeln' },
    { kind: 'button', id: 'start', x: 50, y: 10, size: 13 },
  ],
});
```

Das geht auch direkt beim Verbinden (`new PocketJoy({ layout: { … } })`).

**Die Felder:**

| Feld | Bedeutung |
|---|---|
| `kind` | `stick`, `dpad`, `button`, `trigger` oder `steer` |
| `id` | Bei `stick`: `left`/`right`. Bei `trigger`: `lt`/`rt`. Bei `button`: ein Knopfname (siehe Spieler-API). Bei `dpad`/`steer` egal. |
| `x`, `y` | Mittelpunkt in Prozent der **Querformat**-Fläche (0–100) |
| `size` | Größe in Prozent der **Höhe** – dadurch passt es auf jedes Display |
| `label` | Eigene Beschriftung statt `A`, `B` … (max. 12 Zeichen) |
| `wide` | Bei `button`/`trigger`: breite Schultertasten-Form |

Was dein Spiel ausliest, richtet sich nach `id`, nicht nach der Beschriftung:
Der Knopf mit `label: 'Werfen'` wird mit `p.pressed('a')` abgefragt.

**Der Server prüft jedes Layout**, bevor es auf die Handys geht: Unbekannte
Typen fliegen raus, Werte außerhalb des Bildschirms werden begrenzt, und ein
Layout ohne brauchbares Bedienelement wird komplett abgelehnt (dein Spiel
bekommt dann ein `error`-Ereignis mit `bad-layout`). Ein Tippfehler kann die
Handys also nicht unbedienbar machen.

Vergib für eigene Layouts keine `id`, die schon ein Preset ist – sonst wird
das Preset genommen.

### Eigene Presets dauerhaft hinterlegen

Soll ein Layout fest dazugehören statt vom Spiel geschickt zu werden, kommt es
in `shared/protocol.js` zu `LAYOUTS` dazu. Es steht dann in der Lobby zur
Auswahl und ist per `pj.setLayout('mein-layout')` erreichbar. Pad und Server
lesen dieselbe Datei, mehr ist nicht nötig.

Danach `npm run test:layouts` laufen lassen – das prüft rechnerisch, ob sich
Bedienelemente überlappen oder auf schmalen Handys über den Rand ragen.

---

## Web-Modus: Spiele auf itch.io und anderem Hosting

Für ein Spiel, das **nicht** vom PocketJoy-Server ausgeliefert wird, gibt es
einen zweiten Betriebsmodus. Dabei läuft gar kein Server auf dem Spielrechner:
Die Spielseite betreibt die Spielerverwaltung selbst, und die Handys verbinden
sich **direkt** mit ihr.

```
Handys ──WebRTC, direkt──▶ deine Spielseite (itch.io)
   └── nur zum Kennenlernen ──▶ Signaling-Dienst
```

Nötig ist das, weil eine über `https://` ausgelieferte Seite keine
`ws://`-Verbindung in ein lokales Netz öffnen darf – der Browser blockiert
das:

```
Mixed Content: … attempted to connect to the insecure WebSocket endpoint
'ws://192.168.0.122:3070/ws'. This request has been blocked.
```

WebRTC fällt nicht unter diese Regel. Dadurch funktioniert der Web-Modus aus
einem itch.io-Spiel heraus, ohne dass jemand etwas installiert.

### Verwenden

```js
import { PocketJoyWeb } from './pocketjoy-web.js';

const pj = new PocketJoyWeb({
  signaling: 'wss://pocketjoy.deine-domain.de/signal',
  layout: 'dual-stick',
  maxPlayers: 4,
});

pj.on('room', (code, padUrl) => {
  zeigeCode(code);        // z. B. "K7M2" – das tippen die Spieler ein
  zeigeQrCode(padUrl);    // oder einfach den Link anzeigen
});

await pj.connect();
```

**Ab hier ist alles identisch zum normalen Modus** – `pj.players`, `p.down()`,
`p.stick()`, `pj.update()`, Layouts, Rumble. Derselbe Spielcode läuft in
beiden Betriebsarten; es unterscheiden sich nur Klasse und Einstieg.

Zum Ausprobieren: `npm start`, dann `http://localhost:3070/web` öffnen. Dort
erscheint ein Raum-Code, und das Handy geht auf
`http://<deine-ip>:3070/pad?room=CODE` – oder scannt den QR-Code.

### Den Signaling-Dienst selbst betreiben

Der Dienst vermittelt nur den Verbindungsaufbau und sieht **nie** Eingaben,
Namen oder Layouts. Er steckt im normalen PocketJoy-Server (`/signal`), lässt
sich also mit demselben Befehl betreiben:

```bash
node server/index.js --port 3070
```

Davor ein Reverse-Proxy für https, mehr braucht es nicht:

```
pocketjoy.deine-domain.de {
    reverse_proxy localhost:3070
}
```

Die Last ist winzig: ein paar Nachrichten pro Spieler, danach nichts mehr.

### Spieler außerhalb des WLANs (STUN und TURN)

Sitzen alle im selben WLAN, brauchst du nichts davon – die Geräte finden sich
direkt. Soll jemand über mobile Daten mitspielen, oder sitzt ihr in einem
Gäste-WLAN, das Geräte voneinander abschirmt, kommen zwei Helfer ins Spiel:

- **STUN** sagt einem Gerät nur, wie es von außen aussieht. Damit klappt die
  direkte Verbindung meistens auch über Netzgrenzen hinweg. Keine Spieldaten.
- **TURN** ist der Notnagel: ein Relais, durch das alles fließt. Funktioniert
  immer, kostet aber Latenz – aus 2 ms werden schnell 40 ms.

**Ausgehandelt wird pro Gerät einzeln.** Zwei Leute im WLAN und einer über
Mobilfunk ergibt zwei direkte Verbindungen und eine über das Relais,
gleichzeitig. WebRTC probiert immer zuerst direkt und nimmt das Relais nur,
wenn nichts anderes geht – du musst nichts umschalten.

Eingerichtet wird es über Umgebungsvariablen am Server, nicht im Spielcode:

```bash
POCKETJOY_STUN=stun:stun.deine-domain.de:3478 POCKETJOY_TURN=turn:turn.deine-domain.de:3478 POCKETJOY_TURN_SECRET=dasselbe-geheimnis-wie-im-turn-server node server/index.js
```

Der Signaling-Dienst reicht die Daten dann an **beide** Seiten weiter – auch
an die Handys. Das ist wichtig: Ein Handy im Mobilfunknetz ist die Seite, die
den Relais-Weg anbieten muss, und ohne diese Angaben kann es das nicht.

**Die Zugangsdaten sind zeitlich begrenzt.** PocketJoy erzeugt sie pro
Verbindung aus dem gemeinsamen Geheimnis (das Verfahren, das `coturn` „TURN
REST API" nennt): Der Benutzername enthält ein Ablaufdatum, das Passwort ist
dessen Signatur. Das Geheimnis selbst verlässt den Server nie, und ein
abgefangener Link ist nach ein paar Stunden wertlos – sonst benutzt irgendwann
jemand dein Relais als Gratis-Dienst.

Fehlen bei konfiguriertem TURN die Zugangsdaten, sagt der Server das beim
Start, statt die Verbindungen später still scheitern zu lassen.

Einen eigenen Server betreibst du mit `coturn`; passend dazu gehört dort
`use-auth-secret` mit demselben `static-auth-secret`.

**Welchen Weg ein Spieler genommen hat, kannst du anzeigen:**

```js
pj.on('connection', (player, info) => {
  console.log(player.name, info.label, info.rtt + ' ms');
  // "Anna  direkt im WLAN  1 ms"   oder   "Ben  über Relais  38 ms"
});
```

`info.via` ist `lan`, `internet` oder `relay`. Die Demo unter `/web` blendet
das oben rechts ein – beim Testen mit echten Geräten sieht man damit sofort,
warum einer träger reagiert als die anderen.

### Was dabei zu beachten ist

- **Der Raum-Code ist die einzige Hürde.** Im lokalen Modus schützt das WLAN,
  hier nicht mehr. Wer den Code hat, kann mitspielen.
- **Im selben WLAN ist kein TURN-Server nötig** – PocketJoy fragt
  standardmäßig überhaupt keinen externen Dienst, damit nichts über die
  Mitspieler nach draußen geht. Für Spieler außerhalb des WLANs siehe den
  nächsten Abschnitt.
- **Die Verbindung überlebt den Dienst.** Fällt der Signaling-Dienst aus,
  spielen bereits verbundene Handys weiter – nur neue kommen nicht mehr dazu.
  (Nachgeprüft: Server gestoppt, Spiel lief weiter.)
- **Netzwechsel werden abgefangen.** Wechselt ein Handy mitten im Spiel das
  Netz oder hat kurz Funkloch, zeigt es „Verbindung wackelt" und handelt die
  Strecke neu aus, ohne den Platz zu verlieren – das Spiel merkt nichts
  davon. Erst wenn auch das scheitert, tritt es dem Raum neu bei (und bekommt
  über sein Gerät-Token denselben Platz zurück).
- **Die Gamepad-Bridge gibt es hier nicht**, weil kein lokaler Prozess läuft.
  Echte Windows-/Linux-Gamepads sind dem lokalen Modus vorbehalten.
- **Lokal ist weiterhin der einfachere Weg**: Liegt dein Spiel im
  PocketJoy-Ordner, kommt alles über `http://` vom selben Server und du
  brauchst weder Signaling noch Hosting.

---

## Echte Gamepads (Windows und Linux)

Für Spiele, die nichts von PocketJoy wissen – Steam, Unity, Godot, Emulatoren:

```bash
pip install websockets vgamepad     # Windows
pip install websockets evdev        # Linux
python bridge/pocketjoy_bridge.py
```

Jedes Handy wird dann ein virtueller Xbox-360-Controller. Einrichtung,
Rechte unter Linux und Fehlersuche stehen in [bridge/README.de.md](../bridge/README.de.md).

Vorher ohne Installation ausprobieren: `python bridge/pocketjoy_bridge.py --dry-run`

---

## Projektstruktur

```
server/index.js      Server: HTTP, WebSocket, LAN-IP-Erkennung, QR-Code
server/signaling.js  Vermittlung für den Web-Modus (sieht keine Eingaben)
shared/hub.js        Spieler-Slots, Eingaben verteilen – läuft im Server
                     ODER im Browser des Spiels (Web-Modus)
shared/protocol.js   Knöpfe, Achsen, Layouts – von Server UND Browser genutzt
shared/rtc.js        WebRTC-Transport für den Web-Modus
web/pad/             Die Controller-Oberfläche fürs Handy
web/host/            Lobby auf dem PC
client/pocketjoy.js  Bibliothek für eigene Spiele (lokaler Modus)
client/pocketjoy-web.js  dieselbe API für gehostete Spiele (WebRTC)
examples/arena/      Demo-Spiel für vier Spieler (zugleich Beispielcode)
examples/web-arena/  dasselbe Spiel im Web-Modus
bridge/              Python-Bridge für echte System-Gamepads
scripts/selftest.mjs End-to-End-Test
```

---

## Tests

```bash
npm test
```

Startet einen echten Server, verbindet simulierte Handys und ein echtes Spiel
und prüft 38 Dinge: Slot-Vergabe, Knöpfe, Achsen, Trigger, Rumble,
Layout-Wechsel, Reconnect mit demselben Slot, volle Lobby und dass der Server
keine Dateien außerhalb seiner Ordner ausliefert.

---

## Wenn auf dem Handy etwas nicht geht

**Das Handy meldet seine Fehler an den Server.** Was dort schiefgeht, steht im
Terminal, in dem `npm start` läuft:

```
  [Handy 192.168.0.47] Vollbild nicht moeglich: Permissions check failed
     Mozilla/5.0 (Linux; Android 14; Pixel 8) …
```

So lassen sich Probleme auf einem Gerät finden, an das man keine Konsole
anschließen kann.

**Der Start kommt ohne heikle Browser-Funktionen aus.** Vollbild und
`screen.orientation.lock()` haben auf echten Handys Browser-Tabs abstürzen
lassen, besonders solange die Bildschirmtastatur noch offen war. Ein
`try/catch` hilft dagegen nicht – der Absturz passiert unterhalb von
JavaScript. Deshalb:

- Das **Querformat macht CSS**, nicht der Browser: Das Pad dreht sich selbst.
  Das kann nicht abstürzen und funktioniert auf jedem Gerät, auch auf iOS.
- **Vollbild läuft nie automatisch**, nur über das Menü (⋯ unten links) – und
  dort erst nach einem zweiten, bestätigenden Tipp. Auf manchen Handys beendet
  `requestFullscreen()` den Browser sofort. Passiert das, merkt sich das Pad
  dieses Gerät und bietet Vollbild dort **nie wieder** an. Nötig ist es
  ohnehin nicht: Die Drehung füllt den Bildschirm auch so.
- Jeder Startschritt hinterlässt eine Spur. Stirbt der Browser trotzdem, nennt
  die Seite beim nächsten Öffnen den Schritt im Server-Log und lässt die
  riskanten Teile weg. Ein Gerät, das einmal abstürzt, läuft beim zweiten
  Versuch.

## Gut zu wissen

- **Reconnect:** Verliert ein Handy kurz das WLAN oder lädt die Seite neu,
  bekommt es seinen Spieler-Slot zurück (gemerkt über ein Token im Browser).
- **Display bleibt an:** Das Pad fordert einen Wake-Lock an, damit das Handy
  beim Spielen nicht einschläft.
- **Vibration:** Knöpfe geben ein kurzes Feedback, Spiele können gezielt
  `p.rumble()` auslösen.
- **Verzögerung** liegt im WLAN typischerweise bei wenigen Millisekunden. Das
  Handy sendet bis zu 60 Pakete pro Sekunde und nur geänderte Werte.
- **Verlorene Pakete werden aufgefangen.** Im Web-Modus ist der Datenkanal
  bewusst unzuverlässig – auf ein verlorenes Paket zu warten würde alles
  dahinter aufhalten, und eine veraltete Eingabe nützt niemandem. Da aber nur
  Änderungen übertragen werden, könnte ein verlorenes „Knopf losgelassen"
  den Knopf dauerhaft gedrückt lassen. Dagegen zwei Netze: Der Server merkt
  an der Nummerierung, wenn etwas fehlt, und fordert den vollen Zustand an –
  und sobald kurz nichts gesendet wird, schickt das Handy ihn von selbst.
  Ein falscher Zustand hält damit höchstens Sekundenbruchteile.
- **Kein HTTPS:** Alles läuft unverschlüsselt im lokalen Netz. Wer im selben
  WLAN ist, kann mitspielen – für den Wohnzimmer-Einsatz genau richtig, aber
  nichts, was ins offene Internet gehört.
- **iPhone/Safari:** Vollbild per Knopf funktioniert dort nicht, der Rest
  schon. Vibration gibt es auf iOS nicht.
