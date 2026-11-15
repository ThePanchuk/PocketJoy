# Security

## What PocketJoy is, and what it is not

PocketJoy is built for a living room: phones on the same Wi-Fi as the
computer running the game. Within that setting it deliberately has **no
access control** — anyone who can reach the server can join as a player.
That is a feature when your friends are sitting next to you, and a problem
anywhere else.

Specifically, there is:

- **no authentication.** The local mode accepts any phone that can open the
  address. The web mode has only the short room code.
- **no encryption of its own.** The local mode uses plain `ws://`. WebRTC
  encrypts its channel, but the signalling service sees who joins which room.
- **no rate limiting per player.** A phone can send as fast as it likes.

A player can switch the layout or remove others only if they are the main
controller (the first one connected); the server enforces that.

## Before exposing it to the internet

Both modes can be put behind a reverse proxy with HTTPS, and the web mode is
designed for it. If you do, please be aware that the room code is a four
character code from a 31 character alphabet — fine against accidents, not
against someone trying. Consider adding your own authentication in front.

TURN credentials, when a relay is configured, are derived per connection from
a shared secret with a short expiry. The secret itself never leaves the
server, and nothing is sent to any third party unless you configure STUN or
TURN yourself.

## Reporting a vulnerability

Please open an issue describing the problem. If you would rather not do that
in public, say so in the issue without details and we will find another way.

This is a hobby project with no security guarantees. Please do not use it
where a compromise would matter.
