import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, sendMessage, type User } from './helpers';

let A: User;
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Axe'); await createServer(A.page, 'Axe HQ'); await sendMessage(A.page, 'hello accessibility'); });
test.afterAll(async () => { await A?.ctx.close(); });

async function scan(page: Page, label: string) {
  await page.waitForTimeout(400); // let pop/slide-in animations settle: mid-flight opacity skews contrast
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? '')).join(' | ')}`);
  expect.soft(bad, `axe violations on ${label}`).toEqual([]);
}
async function setTheme(page: Page, theme: string) {
  await page.evaluate((th) => { const k = 'jorcord.prefs.v1'; localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), theme: th })); }, theme);
  await page.goto('/channels/@me'); await expect(page.getByRole('navigation', { name: 'Servers' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Axe HQ' }).click(); await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

for (const theme of ['dark', 'light', 'amoled']) {
  test(`axe: chat screen, ${theme}`, async () => { await setTheme(A.page, theme); await scan(A.page, `chat ${theme}`); });
  test(`axe: user settings, ${theme}`, async () => { await openUserSettings(A.page); await scan(A.page, `user settings ${theme}`); await closeSettings(A.page); });
}
test('axe: server settings (roles, command permissions), add-server modal, friends home', async () => {
  await setTheme(A.page, 'dark');
  await openGuildSettings(A.page, 'Axe HQ', 'Roles'); await scan(A.page, 'roles');
  await A.page.getByRole('dialog', { name: 'Axe HQ' }).getByRole('button', { name: 'Command Permissions' }).click();
  await expect(A.page.getByRole('heading', { name: 'Command Permissions' })).toBeVisible(); await scan(A.page, 'command permissions');
  await closeSettings(A.page);
  await A.page.getByRole('button', { name: 'Add a Server' }).click(); await scan(A.page, 'add server modal');
  await A.page.keyboard.press('Escape');
  await A.page.goto('/channels/@me'); await expect(A.page.getByRole('navigation', { name: 'Servers' })).toBeVisible(); await scan(A.page, 'friends home');
});
test('axe: mobile chat', async ({ browser }) => {
  const M = await newUser(browser, 'AxeM', { mobile: true });
  await scan(M.page, 'mobile home'); await M.ctx.close();
});
test('axe: login page', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:5273', serviceWorkers: 'block' }); const p = await ctx.newPage();
  await p.goto('/login'); await expect(p.getByLabel('Email').or(p.getByLabel(/username/i)).first()).toBeVisible(); await scan(p, 'login'); await ctx.close();
});

test('keyboard: roving tabindex in the server rail and channel list, menus open/close with focus restore', async () => {
  const p = A.page; await setTheme(p, 'dark');
  const rail = p.getByRole('navigation', { name: 'Servers' });
  await expect(rail.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(rail.locator('button[tabindex="-1"]').first()).toBeAttached();
  await rail.locator('button[tabindex="0"]').focus(); await p.keyboard.press('ArrowDown');
  await expect(rail.locator('button:focus')).toHaveCount(1);
  await p.keyboard.press('Home'); const first = await rail.locator('button:focus').getAttribute('aria-label'); await p.keyboard.press('End');
  expect(await rail.locator('button:focus').getAttribute('aria-label')).not.toBe(first);
  const chans = p.getByRole('navigation', { name: 'Channels' });
  await expect(chans.locator('[data-channel] > div > button[tabindex="0"]')).toHaveCount(1);
  // server menu: keyboard open, arrow navigation, Escape restores focus to the trigger
  const trig = p.getByRole('button', { name: 'Axe HQ server menu' }); await trig.focus(); await p.keyboard.press('Enter');
  await expect(p.getByRole('menu')).toBeVisible(); await expect(p.getByRole('menuitem').first()).toBeFocused();
  await p.keyboard.press('ArrowDown'); await expect(p.getByRole('menuitem').nth(1)).toBeFocused();
  await p.keyboard.press('Escape'); await expect(p.getByRole('menu')).toHaveCount(0); await expect(trig).toBeFocused();
});
test('keyboard: modal traps focus and restores it; messages live region is a polite log', async () => {
  const p = A.page; const add = p.getByRole('button', { name: 'Add a Server' }); await add.focus(); await p.keyboard.press('Enter');
  const dlg = p.getByRole('dialog'); await expect(dlg).toBeVisible();
  for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true); }
  await p.keyboard.press('Escape'); await expect(dlg).toHaveCount(0); await expect(add).toBeFocused();
  await expect(p.getByRole('log')).toHaveAttribute('aria-live', 'polite');
});
test('reduced motion + 200% zoom: no horizontal page scroll, animations are disabled', async () => {
  const p = A.page; await p.emulateMedia({ reducedMotion: 'reduce' });
  const dur = await p.evaluate(() => getComputedStyle(document.querySelector('main')!).transitionDuration); expect(parseFloat(dur)).toBeLessThan(0.01);
  await p.setViewportSize({ width: 640, height: 450 }); // 1280x900 at 200%
  await expect.poll(() => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(p.getByRole('textbox', { name: /^Message/ })).toBeVisible(); await scan(p, 'chat at 200% zoom');
  await p.setViewportSize({ width: 1440, height: 900 });
});
