// Renders public/favicon.svg to PNG icons. Usage: node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const svg = readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
for (const size of [192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: fileURLToPath(new URL(`../public/icon-${size}.png`, import.meta.url)), omitBackground: true });
}
await b.close();
