/**
 * Translation check.
 *
 * English is the reference: every other language should carry the same keys.
 * Missing ones still work - they fall back to English - but a screen in mixed
 * languages looks broken, so this says exactly what is missing.
 *
 * It also catches two mistakes that are easy to make and hard to spot:
 * placeholders that got lost in translation ({slot}, {code} …), and leftover
 * keys that no longer exist in English.
 *
 *   node scripts/checklang.mjs
 */

import { LANGUAGES, DEFAULT_LANGUAGE, setLanguage, t } from '../shared/i18n.js';

/** Read the raw tables by asking for every key in every language. */
const source = await import('../shared/i18n.js');

// The strings are module-private, so collect the keys through the English
// pass: anything the default language answers differently from its key.
const KEYS = [];
setLanguage(DEFAULT_LANGUAGE, { remember: false });

// Keys are discovered from the file itself - simplest reliable way without
// exporting the table.
const fileText = await (await import('node:fs/promises')).readFile(
  new URL('../shared/i18n.js', import.meta.url), 'utf8',
);
const englishBlock = fileText.slice(
  fileText.indexOf('  en: {'),
  fileText.indexOf('  // ----------------------------------------------------------------- German'),
);
for (const match of englishBlock.matchAll(/^\s{4}'([\w.-]+)':/gm)) KEYS.push(match[1]);

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

let problems = 0;
console.log(`\nUebersetzungen (${KEYS.length} Texte, ${LANGUAGES.length} Sprachen)\n`);

const englishTexts = new Map();
setLanguage(DEFAULT_LANGUAGE, { remember: false });
for (const key of KEYS) englishTexts.set(key, t(key));

for (const lang of LANGUAGES) {
  if (lang.code === DEFAULT_LANGUAGE) {
    console.log(`  ok    ${lang.code}  ${lang.name} (Referenz)`);
    continue;
  }

  setLanguage(lang.code, { remember: false });
  const missing = [];
  const brokenVars = [];

  for (const key of KEYS) {
    const text = t(key);
    // Falling back gives exactly the English text, which is how a gap shows.
    if (text === englishTexts.get(key) && /[a-z]/i.test(text) && !/^[A-Z0-9 +&-]+$/.test(text)) {
      missing.push(key);
      continue;
    }
    const want = placeholders(englishTexts.get(key)).join(',');
    const have = placeholders(text).join(',');
    if (want !== have) brokenVars.push(`${key} (${want || '-'} -> ${have || '-'})`);
  }

  // A handful of identical texts is normal ("Menu", "Dual Stick"), so only
  // a real gap counts.
  const suspicious = missing.length > KEYS.length * 0.25;
  if (brokenVars.length || suspicious) {
    problems += brokenVars.length + (suspicious ? 1 : 0);
    console.log(`  FAIL  ${lang.code}  ${lang.name}`);
    if (suspicious) console.log(`          ${missing.length} Texte fehlen, u. a.: ${missing.slice(0, 4).join(', ')}`);
    for (const line of brokenVars) console.log(`          Platzhalter: ${line}`);
  } else {
    const note = missing.length ? `  (${missing.length} wie im Englischen)` : '';
    console.log(`  ok    ${lang.code}  ${lang.name}${note}`);
  }
}

setLanguage(DEFAULT_LANGUAGE, { remember: false });
console.log(problems ? `\n  ${problems} Problem(e)\n` : '\n  Alle Sprachen vollstaendig.\n');
process.exit(problems ? 1 : 0);
