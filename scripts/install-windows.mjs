/**
 * Put PocketJoy where it can be started without a terminal.
 *
 *   npm run install:windows
 *
 * Asks whether to place a shortcut on the desktop and in the start menu,
 * builds PocketJoy.exe if it is not there yet, and creates the shortcuts.
 *
 * The shortcuts point at the exe inside the project folder rather than
 * copying anything: the exe is only a launcher for the code next to it, so a
 * copy somewhere else would be broken. Removing a shortcut is just deleting
 * a file - nothing is registered anywhere, no uninstaller needed.
 *
 * Non-interactive use (for scripts):
 *   node scripts/install-windows.mjs --desktop --startmenu
 *   node scripts/install-windows.mjs --remove
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'PocketJoy.exe');
const NAME = 'PocketJoy.lnk';

if (process.platform !== 'win32') {
  console.error('\n  Dieses Skript ist fuer Windows. Unter Linux/macOS:  npm start\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

/** Ask PowerShell for the real folders - they may be redirected to OneDrive. */
function windowsFolder(which) {
  return execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Environment]::GetFolderPath('${which}')`,
  ], { encoding: 'utf8' }).trim();
}

/**
 * Quote a path for PowerShell.
 *
 * Single quotes, because PowerShell takes them literally. JSON quoting looks
 * right but is wrong here: it escapes every backslash, and PowerShell keeps
 * both of them - the shortcut then carries C:\Users\... as its folder.
 */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function createShortcut(folder, label) {
  const target = path.join(folder, NAME);
  const script = `
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(target)})
    $s.TargetPath = ${psQuote(EXE)}
    $s.WorkingDirectory = ${psQuote(ROOT)}
    $s.Description = 'PocketJoy - phones as game controllers'
    $s.Save()
  `;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`  angelegt   ${label}`);
}

function removeShortcut(folder, label) {
  const target = path.join(folder, NAME);
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    console.log(`  entfernt   ${label}`);
  } else {
    console.log(`  nicht da   ${label}`);
  }
}

const desktop = windowsFolder('Desktop');
const programs = windowsFolder('Programs');

// --- removing -------------------------------------------------------------

if (flag('remove')) {
  console.log('\nVerknuepfungen entfernen\n');
  removeShortcut(desktop, 'Desktop');
  removeShortcut(programs, 'Startmenue');
  console.log('\n  Der Ordner selbst bleibt unangetastet.\n');
  process.exit(0);
}

// --- the executable -------------------------------------------------------

console.log('\nPocketJoy einrichten\n');

if (!fs.existsSync(EXE)) {
  console.log('  PocketJoy.exe fehlt noch - wird gebaut (dauert einen Moment)\n');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-exe.mjs')], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!fs.existsSync(EXE)) {
    console.error('  Bauen fehlgeschlagen. Bitte "npm run build:exe" einzeln ausfuehren.\n');
    process.exit(1);
  }
  console.log('  PocketJoy.exe gebaut\n');
}

// --- asking ---------------------------------------------------------------

let wantDesktop = flag('desktop') || flag('all');
let wantMenu = flag('startmenu') || flag('all');

if (!wantDesktop && !wantMenu) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => {
    const answer = (await rl.question(`  ${question} [J/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'j' || answer === 'y' || answer === 'ja' || answer === 'yes';
  };

  wantDesktop = await ask('Verknuepfung auf dem Desktop anlegen?');
  wantMenu = await ask('Verknuepfung im Startmenue anlegen?');
  rl.close();
  console.log('');
}

if (!wantDesktop && !wantMenu) {
  console.log(`  Keine Verknuepfung angelegt. Starten laesst sich PocketJoy trotzdem:

    Doppelklick auf PocketJoy.exe
    oder:  npm start
`);
  process.exit(0);
}

if (wantDesktop) createShortcut(desktop, 'Desktop');
if (wantMenu) createShortcut(programs, 'Startmenue');

console.log(`
  Fertig. Ein Doppelklick startet den Server und oeffnet die Lobby;
  dort stehen QR-Code und Adresse fuer die Handys.

  Rueckgaengig machen:  npm run install:windows -- --remove
`);
