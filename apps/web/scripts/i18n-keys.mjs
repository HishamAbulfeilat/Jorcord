// Lists every translatable source string: t('...'), t("..."), T('...'), tn(n, 'a', 'b').  Usage: node scripts/i18n-keys.mjs [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!p.includes('/i18n')) walk(p); } else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p); } })(root);
const keys = new Set();
const lit = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;
const unesc = (s) => s.replace(/\\(['"\\])/g, '$1');
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.$])[tT]\(\s*` + lit, 'g'))) keys.add(unesc(m[1] ?? m[2]));
  for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.$])tn\([^,]+,\s*` + lit + String.raw`\s*,\s*` + lit, 'g'))) { keys.add(unesc(m[1] ?? m[2])); keys.add(unesc(m[3] ?? m[4])); }
}
const list = [...keys].sort((a, b) => a.localeCompare(b));
if (process.argv.includes('--json')) console.log(JSON.stringify(list, null, 1)); else console.log(list.join('\n'));
