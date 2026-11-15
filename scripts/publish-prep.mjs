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
 *
 * For a folder that already exists - the published repository, after the
 * first release:
 *
 *   node scripts/publish-prep.mjs --update [target folder]
 *
 * That brings it in step with this one: files that changed are written,
 * files that are gone here are removed there, `.git` is left alone. Copying
 * changed files by hand is how a release quietly ships yesterday's version
 * of something.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const update = args.includes('--update');
const target = path.resolve(
  args.find((a) => !a.startsWith('--')) || path.join(ROOT, '..', 'PocketJoy-public'),
);

/** Everything a user or contributor needs. */
const INCLUDE = [
  'server', 'shared', 'client', 'web', 'examples', 'bridge', 'scripts',
  '.github',
  // The whole docs folder, not single files - listing them by name means
  // every new document is silently left out of the next release.
  'docs',
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

/**
 * Bring `to` in step with `from`: write what differs, remove what is gone.
 * Only the entries in INCLUDE are touched, so anything else in the target -
 * `.git` above all - is left exactly as it is.
 */
async function mirror(from, to, changes) {
  const stat = await fs.stat(from);

  if (!stat.isDirectory()) {
    const fresh = await fs.readFile(from);
    const old = await fs.readFile(to).catch(() => null);
    if (old && old.equals(fresh)) return;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    changes.push(`  geaendert  ${path.relative(target, to)}`);
    return;
  }

  await fs.mkdir(to, { recursive: true });
  const wanted = (await fs.readdir(from)).filter((name) => !SKIP.has(name));
  for (const name of wanted) {
    await mirror(path.join(from, name), path.join(to, name), changes);
  }

  // Anything left over here was deleted or renamed on this side.
  const present = await fs.readdir(to).catch(() => []);
  for (const name of present) {
    if (wanted.includes(name)) continue;
    await fs.rm(path.join(to, name), { recursive: true, force: true });
    changes.push(`  entfernt   ${path.relative(target, path.join(to, name))}`);
  }
}

const exists = await fs.access(target).then(() => true, () => false);

// Refuse to overwrite something that is already there - too easy to lose work.
if (exists && !update) {
  console.error(`\n  ${target} gibt es schon.
  Zum Abgleichen:  node scripts/publish-prep.mjs --update "${target}"
  Sonst bitte loeschen oder anderen Pfad angeben.\n`);
  process.exit(1);
}
if (!exists && update) {
  console.error(`\n  ${target} gibt es nicht - --update gleicht einen vorhandenen Ordner ab.\n`);
  process.exit(1);
}

console.log(`\n${update ? 'Abgleichen mit' : 'Vorbereiten in'} ${target}\n`);
let copied = 0;
const changes = [];
for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  try {
    await fs.access(from);
  } catch {
    console.log(`  fehlt   ${entry}`);
    continue;
  }
  if (update) await mirror(from, path.join(target, entry), changes);
  else await copy(from, path.join(target, entry));
  console.log(`  ok      ${entry}`);
  copied++;
}

if (update) {
  console.log(changes.length
    ? `\n${changes.join('\n')}`
    : '\n  Nichts zu tun - die Ordner sind gleich.');
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

if (update) {
  console.log(`
  Naechste Schritte:

    cd "${target}"
    git status
    git add -A
    git commit
    git push
`);
  process.exit(0);
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
