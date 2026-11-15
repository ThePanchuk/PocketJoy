# Contributing

Thanks for taking a look.

## Getting started

```bash
npm install
npm start          # server on port 3070, lobby at http://localhost:3070/
npm run demo       # opens a 4-player demo game
npm test           # layouts, translations, 108 end-to-end checks
```

No build step, no bundler. Everything is plain ES modules that browsers and
Node both read directly, so you can edit a file and reload the page.

## Before opening a pull request

Run `npm test`. It starts a real server, connects simulated phones and a real
game, and checks the whole chain. If you change layouts or texts, these also
help:

```bash
npm run test:layouts   # nothing overlaps or runs off a narrow phone
npm run test:lang      # every language complete, no lost placeholders
```

## Adding a language

Everything lives in `shared/i18n.js`: add the code to `LANGUAGES`, add the
texts to `STRINGS`. Anything missing falls back to English, so a partial
translation breaks nothing. `npm run test:lang` lists what is still missing.

Right-to-left languages would need mirrored layouts, which is why none are
included yet — a half-done job there is worse than none.

## Adding a layout

Add it to `LAYOUTS` in `shared/protocol.js`: positions in percent of the
landscape area, sizes in percent of its height. Then run
`npm run test:layouts`, which checks it against four phone aspect ratios and
verifies the lobby preview.

## Changing the icon

`web/icon.svg` is the icon; `web/icon-small.svg` is the same thing drawn
more coarsely, used at 16 and 24 px where fine detail turns to mush. Edit the
SVG, then:

```bash
npm run build:icons
```

That rasterizes both files into `web/icons/` - the `.ico` the executable and
the favicon use, plus the PNGs the pages link. The script understands only the
shapes these two files use (rounded rectangles, circles, one gradient, one
stroke); if the icon ever needs paths or text, render it in a browser instead
and commit the result. Afterwards `npm run build:exe` picks the new icon up.

## Style

Code and comments in English; user-facing text goes through `t()`. Comments
should say *why* something is the way it is — several decisions here come from
problems found on real phones, and the reasoning is easy to lose.
