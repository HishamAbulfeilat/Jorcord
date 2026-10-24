// Generates src/i18n/<id>.ts from scripts/i18n-table-2.tsv (first column = English key, then one column per locale in the header).
// Usage: node scripts/i18n-gen.mjs   (machine-translated starting point; see docs/I18N.md)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const rows = readFileSync(fileURLToPath(new URL('./i18n-table-2.tsv', import.meta.url)), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
const [head, ...body] = rows;
const file = { pt: 'pt', ru: 'ru', hi: 'hi', id: 'id', ja: 'ja', zh: 'zh', ko: 'ko', it: 'it', nl: 'nl', pl: 'pl' };
for (let c = 1; c < head.length; c++) {
  const id = file[head[c]];
  const lines = body.map((r) => { if (!r[c]) throw new Error(`missing ${head[c]} for ${r[0]}`); return `  ${JSON.stringify(r[0])}: ${JSON.stringify(r[c])},`; });
  writeFileSync(fileURLToPath(new URL(`../src/i18n/${id}.ts`, import.meta.url)), `import type { Dict } from './index';\n/** Core UI chrome. MACHINE TRANSLATED: needs review by a native speaker (docs/I18N.md). Missing keys fall back to English. */\nconst d: Dict = {\n${lines.join('\n')}\n};\nexport default d;\n`);
}
console.log('ok', head.length - 1, 'locales', body.length, 'keys');
