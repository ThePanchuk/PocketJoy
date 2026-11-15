/**
 * Build a folder that is ready to become a public repository.
 *
 * Why not just push this one: the history carries a private email address in
 * every commit, and PROGRESS.md is a working diary, not documentation.
 * Rewriting history is fiddly and easy to get wrong, so this copies the files
 * that should be public into a fresh folder, ready for `git init`.
 *
 *   node scripts/publish-prep.mjs [target folder]
 *
 * Afterwards it prints the exact commands, including the one that keeps your
 * address out of the new history.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] || path.join(ROOT, '..', 'PocketJoy-public'));

/** Everything a user or contributor needs. */
const INCLUDE = [
  'server', 'shared', 'client', 'web', 'examples', 'bridge', 'scripts',
  '.github',
  'docs/screenshots', 'docs/README.de.md',
  'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', 'package-lock.json', '.gitignore',
];

/** Never copy these, wherever they turn up. */
const SKIP = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.DS_Store',
  'PROGRESS.md',          // working diary, stays private
  '.claude',              // local editor settings
]);

async function copy(from, to) {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) {
      if (SKIP.has(entry)) continue;
      await copy(path.join(from, entry), path.join(to, entry));
    }
  } else {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

// Refuse to overwrite something that is already there - too easy to lose work.
try {
  await fs.access(target);
  console.error(`\n  ${target} gibt es schon. Bitte loeschen oder anderen Pfad angeben.\n`);
  process.exit(1);
} catch { /* good, it does not exist */ }

console.log(`\nVorbereiten in ${target}\n`);
let copied = 0;
for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  try {
    await fs.access(from);
  } catch {
    console.log(`  fehlt   ${entry}`);
    continue;
  }
  await copy(from, path.join(target, entry));
  console.log(`  ok      ${entry}`);
  copied++;
}

// A last look for things that should not become public.
const problems = [];
const scan = async (dir) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scan(full); continue; }
    if (!/\.(js|mjs|json|md|py|ya?ml|html|css)$/.test(entry.name)) continue;
    const text = await fs.readFile(full, 'utf8');
    // The address only belongs in commits you deliberately sign.
    if (/[\w.+-]+@(?!example\.|users\.noreply)[\w-]+\.[a-z]{2,}/i.test(text)) {
      problems.push(`${path.relative(target, full)}: sieht nach einer E-Mail-Adresse aus`);
    }
    if (/POCKETJOY_TURN_SECRET\s*=\s*["'][^"']+["']/.test(text)) {
      problems.push(`${path.relative(target, full)}: TURN-Geheimnis im Klartext`);
    }
  }
};
await scan(target);

console.log(`\n  ${copied} Eintraege kopiert.`);
if (problems.length) {
  console.log('\n  Bitte vorher ansehen:');
  for (const p of problems) console.log(`    - ${p}`);
} else {
  console.log('  Keine E-Mail-Adressen oder Geheimnisse in den Dateien gefunden.');
}

console.log(`
  Naechste Schritte:

    cd "${target}"
    git init -b main

    # Diese Zeile haelt deine private Adresse aus der neuen Historie.
    # Die noreply-Adresse steht in GitHub unter Settings -> Emails.
    git config user.email "<dein-name>@users.noreply.github.com"
    git config user.name "<dein Name>"

    git add -A
    git commit -m "PocketJoy 1.0.0"
    gh repo create PocketJoy --public --source . --push

  Danach auf GitHub: Beschreibung und Themen setzen (gamepad, couch-coop,
  local-multiplayer, webrtc), damit das Projekt gefunden wird.
`);
