// Screenshots of the static /demo route. Usage: node scripts/screenshots.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || './screenshots';
const base = process.argv[3] || 'http://localhost:4173';
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const shots = [
  ['desktop-dark', { viewport: { width: 1440, height: 900 } }, '/demo'],
  ['desktop-light', { viewport: { width: 1440, height: 900 } }, '/demo?theme=light'],
  ['desktop-amoled', { viewport: { width: 1440, height: 900 } }, '/demo?theme=amoled'],
  ['desktop-friends', { viewport: { width: 1440, height: 900 } }, '/demo/channels/@me'],
  ['desktop-forum', { viewport: { width: 1440, height: 900 } }, '/demo/channels/2001/4014'],
  ['desktop-switcher', { viewport: { width: 1440, height: 900 } }, '/demo?open=switcher'],
  ['desktop-settings', { viewport: { width: 1440, height: 900 } }, '/demo?open=settings&tab=appearance'],
  ['desktop-guild-roles', { viewport: { width: 1440, height: 900 } }, '/demo?open=guild&tab=roles'],
  ['mobile-chat', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '/demo'],
  ['mobile-drawer', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '/demo?open=drawer'],
  ['mobile-members', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '/demo?open=members'],
  ['mobile-friends', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '/demo/channels/@me'],
  ['mobile-settings', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '/demo?open=settings'],
];
const only = process.env.ONLY?.split(',');
for (const [name, ctxOpts, path] of shots) {
  if (only && !only.includes(name)) continue;
  const ctx = await b.newContext(ctxOpts); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(base + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(900);
  await p.screenshot({ path: `${out}/${name}.png` });
  console.log(name, errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ') : 'ok');
  await ctx.close();
}
await b.close();
