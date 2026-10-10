/** Visual fidelity review: the same conversation in dark / light / AMOLED on desktop and mobile. Output: e2e/screenshots/theme-*.png (SHOTS=1). */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, rest, guildId, type User } from './helpers';

const OUT = fileURLToPath(new URL('../screenshots', import.meta.url));
let A: User, B: User, M: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); M = await newUser(browser, 'Mia', { mobile: true });
  await createServer(A.page, 'Jorcord HQ'); const gid = await guildId(A.page); const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv); await joinViaInvite(M.page, inv);
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'random', type: 'text' });
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Lounge', type: 'voice' });
  for (const [u, t] of [[A, 'Hey team, welcome to **Jorcord HQ**!'], [A, 'Here is `inline code` and a quote:\n> keep it simple'], [B, 'Thanks Alice, glad to be here :tada:'], [B, 'Anyone up for a call later?'], [A, '@Bob sure, after lunch']] as const) await sendMessage(u.page, t);
});
test.afterAll(async () => { for (const u of [A, B, M]) await u?.ctx.close(); });
async function theme(p: Page, th: string) {
  await p.evaluate((x) => { const k = 'jorcord.prefs.v1'; localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), theme: x })); }, th);
  await p.reload(); await expect(p.getByRole('textbox', { name: /^Message/ })).toBeVisible(); await p.waitForTimeout(500);
}
for (const th of ['dark', 'light', 'amoled']) {
  test(`desktop ${th}`, async () => {
    await theme(A.page, th); await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'random', exact: true }).click(); await A.page.waitForTimeout(400);
    await A.page.screenshot({ path: `${OUT}/theme-desktop-${th}-empty.png` });
    await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click(); await A.page.waitForTimeout(500);
    await A.page.locator('[id^="msg-"]').nth(2).hover(); await A.page.screenshot({ path: `${OUT}/theme-desktop-${th}.png` });
  });
  test(`mobile ${th}`, async () => { await theme(M.page, th); await M.page.screenshot({ path: `${OUT}/theme-mobile-${th}.png` }); });
}
