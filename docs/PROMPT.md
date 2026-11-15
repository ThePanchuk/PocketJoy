# Prompt for a new chat

Paste one of these into a fresh conversation. Both point the assistant at the
full guide, so nothing has to be explained twice.

---

## For a game on itch.io or a website (web mode)

```
Ich baue ein Browser-Spiel, das auf itch.io (bzw. meiner Website) laufen
soll, und möchte PocketJoy als Controller einbinden: Mitspieler nutzen ihr
Handy als Gamepad.

PocketJoy ist mein eigenes Open-Source-Projekt:
https://github.com/ThePanchuk/PocketJoy

Lies bitte zuerst die Integrationsanleitung, dort steht alles Nötige:
https://raw.githubusercontent.com/ThePanchuk/PocketJoy/main/docs/INTEGRATION.md

Wichtig für meinen Fall: Weil das Spiel über https ausgeliefert wird, kommt
nur der Web-Modus infrage (PocketJoyWeb + Signaling-Dienst), nicht der lokale
Modus. Sag mir bitte, falls dafür noch etwas von mir gebraucht wird.
```

---

## For a game that runs on the player's own machine (local mode)

```
Ich baue ein Couch-Koop-Spiel, das lokal läuft, und möchte PocketJoy
einbinden: Mitspieler nutzen ihr Handy als Gamepad, alle im selben WLAN.

PocketJoy ist mein eigenes Open-Source-Projekt:
https://github.com/ThePanchuk/PocketJoy

Lies bitte zuerst die Integrationsanleitung:
https://raw.githubusercontent.com/ThePanchuk/PocketJoy/main/docs/INTEGRATION.md

Für meinen Fall reicht der lokale Modus: eine einzige Datei
(client/pocketjoy.js), der PocketJoy-Server läuft neben dem Spiel.
```

---

## If the assistant cannot open links

Some chats have no web access. Then paste the guide itself — it is written to
stand alone:

```
https://raw.githubusercontent.com/ThePanchuk/PocketJoy/main/docs/INTEGRATION.md
```

Open that URL yourself, copy the text, and paste it into the conversation
with a sentence like "Hier ist die Anleitung zu PocketJoy, dem Controller-
Tool, das ich einbinden will."

---

## What to add on top

The guide covers PocketJoy. Your game still needs its own description —
worth saying in the same message:

- what kind of game it is and which **layout** fits (`dual-stick`,
  `platformer`, `racing`, `buttons`, …);
- how many players;
- which framework or engine the game uses (plain Canvas, Phaser, Three.js, …);
- for web mode: the address of your PocketJoy host, or that you still need
  to set one up.
