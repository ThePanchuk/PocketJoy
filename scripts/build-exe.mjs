/**
 * Build PocketJoy.exe — a Windows executable that starts the server by
 * double-click, with no Node installation needed.
 *
 *   npm run build:exe
 *
 * How it works: Node can turn a script into a "single executable
 * application" — a copy of node.exe with the script injected into it. That
 * copy is ~70 MB because it contains Node itself, which is the price of not
 * requiring an installation.
 *
 * The injected script is small on purpose. It only finds the folder it sits
 * in and hands over to `server/index.js`, so the exe stays a launcher and
 * the actual program is still the normal source next to it. That means a
 * code change does not need a rebuild, and nothing is duplicated.
 *
 * Therefore: the exe belongs IN the project folder. Moving it elsewhere on
 * its own will not work, and it says so when that happens.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'PocketJoy.exe');
const ICON = path.join(ROOT, 'web', 'icons', 'pocketjoy.ico');

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (process.platform !== 'win32') {
  console.error('\n  Dieses Skript baut eine Windows-exe und laeuft nur unter Windows.');
  console.error('  Unter Linux/macOS startet das Tool mit:  npm start\n');
  process.exit(1);
}

const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postject)) {
  console.error('\n  Es fehlt das Paket "postject". Einmalig nachholen:\n');
  console.error('    npm install\n');
  process.exit(1);
}

console.log('\nPocketJoy.exe wird gebaut\n');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

/**
 * The launcher. Has to be CommonJS - that is what a single executable takes -
 * but it may load the ES modules next to it at runtime.
 */
const launcher = `
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.dirname(process.execPath);
const server = path.join(root, 'server', 'index.js');

if (!fs.existsSync(server)) {
  console.error('');
  console.error('  PocketJoy.exe muss im PocketJoy-Ordner liegen.');
  console.error('  Gesucht wurde: ' + server);
  console.error('');
  console.error('  Fuer eine Verknuepfung auf dem Desktop nicht die exe');
  console.error('  verschieben, sondern:  npm run install:windows');
  console.error('');
  setTimeout(() => process.exit(1), 15000);   // Fenster offen lassen zum Lesen
  return;
}

// A single executable gets its own path as argv[0] and nothing as argv[1],
// so the server - which reads argv.slice(2) - needs one placeholder.
process.argv = [process.argv[0], server, ...process.argv.slice(1)];

// Double-clicked with no arguments: open the lobby, that is what people want.
const args = process.argv.slice(2);
if (!args.some((a) => a === '--open' || a === '--demo' || a === '--help' || a === '-h')) {
  process.argv.push('--open');
}

process.chdir(root);
import(pathToFileURL(server).href).catch((err) => {
  console.error('  Start fehlgeschlagen: ' + err.message);
  setTimeout(() => process.exit(1), 15000);
});
`;

fs.writeFileSync(path.join(BUILD, 'launcher.js'), launcher.trimStart());
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
  main: path.join(BUILD, 'launcher.js'),
  output: path.join(BUILD, 'launcher.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));

/**
 * Give the copy of node.exe PocketJoy's icon and name.
 *
 * Without this the file shows Node's icon and calls itself "Node.js
 * JavaScript Runtime" in its properties - confusing for something that sits
 * on a desktop as PocketJoy. Icon and text live in the exe's resource
 * section, which is plain data in the file; resedit rewrites it.
 *
 * The signature is discarded on the way (ignoreCert). It is already void -
 * injecting the program below changes the file either way - and keeping a
 * broken signature is worse than having none.
 */
function applyIcon() {
  if (!fs.existsSync(ICON)) {
    console.log('       Icon fehlt - wird gebaut');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-icons.mjs')], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }

  const exe = NtExecutable.from(fs.readFileSync(OUT), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const icons = Data.IconFile.from(fs.readFileSync(ICON)).icons.map((i) => i.data);

  // Replace whatever icon groups are in there rather than adding one:
  // Explorer shows the group with the lowest id, which would still be Node's.
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length
    ? groups.map((g) => ({ id: g.id, lang: g.lang }))
    : [{ id: 1, lang: 1033 }];
  for (const { id, lang } of targets) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icons);
  }

  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  for (const info of Resource.VersionInfo.fromEntries(res.entries)) {
    info.setFileVersion(major, minor, patch, 0);
    info.setProductVersion(major, minor, patch, 0);
    info.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'PocketJoy',
      FileDescription: 'PocketJoy - phones as game controllers',
      CompanyName: '',
      LegalCopyright: '',
      OriginalFilename: 'PocketJoy.exe',
      InternalName: 'PocketJoy',
    });
    info.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(OUT, Buffer.from(exe.generate()));
}

console.log('  1/4  Startprogramm vorbereiten');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

console.log('  2/4  Node mitkopieren');
try {
  fs.copyFileSync(process.execPath, OUT);
} catch (err) {
  // Windows locks a running exe, so a rebuild while PocketJoy is open fails
  // with a message that says nothing about the actual problem.
  if (err.code === 'EBUSY' || err.code === 'EPERM') {
    console.error(`
  PocketJoy.exe laeuft gerade und laesst sich deshalb nicht ersetzen.
  Das Fenster schliessen (oder im Task-Manager beenden) und nochmal
  "npm run build:exe" ausfuehren.
`);
    fs.rmSync(BUILD, { recursive: true, force: true });
    process.exit(1);
  }
  throw err;
}

console.log('  3/4  Icon und Beschriftung setzen');
applyIcon();

console.log('  4/4  Zusammenfuegen');
execFileSync(process.execPath, [
  postject, OUT, 'NODE_SEA_BLOB', path.join(BUILD, 'launcher.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: ['ignore', 'ignore', 'pipe'] });   // its "signature corrupted" note is expected

fs.rmSync(BUILD, { recursive: true, force: true });

const mb = Math.round(fs.statSync(OUT).size / 1048576);
console.log(`
  Fertig: PocketJoy.exe (${mb} MB)

  Doppelklick startet den Server und oeffnet die Lobby.
  Die exe muss in diesem Ordner bleiben - sie startet den Code daneben.

  Verknuepfung auf dem Desktop oder im Startmenue:

    npm run install:windows

  Hinweis: Weil die exe eine veraenderte Kopie von node.exe ist, stimmt
  deren Code-Signatur nicht mehr. Windows SmartScreen kann deshalb beim
  ersten Start warnen ("Weitere Informationen" -> "Trotzdem ausfuehren").
`);
