import { test, expect } from '@playwright/test';
import { clickMenu, newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, rest, guildId, openUserSettings, openGuildSettings, closeSettings, PNG, GIF, type User } from './helpers';

let A: User, B: User, gid: string;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Feature HQ'); gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

const drag = async (page: any, from: any, to: any, where: 'center' | 'top' = 'center') => {
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, where === 'top' ? b.y + 3 : b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
};

test('stickers: upload in settings, send from picker, other user sees it', async () => {
  await openGuildSettings(A.page, 'Feature HQ', 'Stickers');
  await A.page.getByLabel('Sticker image').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: PNG });
  await A.page.getByLabel('Sticker name').fill('party');
  await A.page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(A.page.locator('[data-sticker]')).toHaveCount(1);
  await closeSettings(A.page);
  await A.page.getByRole('button', { name: 'Choose emoji or GIF' }).click();
  await A.page.getByRole('button', { name: 'Stickers' }).click();
  await A.page.getByRole('gridcell', { name: 'party' }).click();
  await expect(B.page.locator('[id^="msg-"] img[alt="party"]').first()).toBeVisible();
});

test('webhooks: create in channel settings, execute, delete', async () => {
  const row = A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /general/ }).first();
  await row.hover(); await A.page.getByRole('button', { name: 'Edit Channel' }).first().click({ force: true });
  await A.page.getByRole('dialog').getByRole('button', { name: 'Integrations' }).click();
  await A.page.getByLabel('Webhook name').fill('Captain Hook');
  await A.page.getByRole('button', { name: 'New Webhook' }).click();
  const w = A.page.locator('[data-webhook]'); await expect(w).toHaveCount(1);
  const url = (await w.locator('.font-mono').innerText()).trim();
  const r = await A.page.request.post(url, { data: { content: 'hello from the hook', username: 'CI Bot' } }); expect(r.ok()).toBeTruthy();
  await expect(msg(B.page, 'hello from the hook')).toBeVisible();
  await A.page.getByRole('button', { name: 'Delete Captain Hook' }).click(); await A.page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(w).toHaveCount(0);
  await A.page.keyboard.press('Escape');
});

test('role icon shows next to the author name', async () => {
  const role = await rest(A.page, 'POST', `/guilds/${gid}/roles`, { name: 'Captain', color: 0 });
  await openGuildSettings(A.page, 'Feature HQ', 'Roles');
  await A.page.getByRole('button', { name: 'Captain', exact: true }).click();
  await A.page.locator('input[type=file]').last().setInputFiles({ name: 'i.png', mimeType: 'image/png', buffer: PNG });
  await expect(A.page.getByRole('img').filter({ has: A.page.locator('img[src*="files"]') }).first().or(A.page.locator('img[src*="files"]').first())).toBeVisible();
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/roles`)).find((r: any) => r.id === role.id)?.icon).toBeTruthy();
  const me = await rest(A.page, 'GET', '/users/@me');
  await rest(A.page, 'PATCH', `/guilds/${gid}/members/${me.id}`, { roles: [role.id] });
  await closeSettings(A.page);
  await sendMessage(A.page, 'iconic');
  await expect(msg(A.page, 'iconic').getByTestId('role-icon')).toBeVisible();
  await expect(msg(B.page, 'iconic').getByTestId('role-icon')).toBeVisible();
});

test('drag to reorder channels and categories persists', async () => {
  const chans = await rest(A.page, 'GET', `/guilds/${gid}/channels`);
  const cat = chans.find((c: any) => c.type === 'category' && /text/i.test(c.name));
  for (const n of ['alpha', 'beta']) await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: n, type: 'text', parentId: cat.id });
  const nav = A.page.getByRole('navigation', { name: 'Channels' });
  const li = (n: string) => nav.locator('li[data-channel]').filter({ hasText: new RegExp(`^${n}$`) });
  await expect(li('beta')).toBeVisible();
  await drag(A.page, li('beta'), li('general'), 'top');
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'beta').position).toBe(0);
  await A.page.reload(); await expect(li('beta')).toBeVisible();
  const order = await nav.locator('li[data-channel]').allInnerTexts();
  expect(order.findIndex((t) => /^beta/.test(t.trim()))).toBeLessThan(order.findIndex((t) => /^general/.test(t.trim())));
  // category order
  const catHeads = nav.locator('section[data-category]');
  await drag(A.page, catHeads.nth(1).locator('div').first(), catHeads.nth(0).locator('div').first(), 'top');
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).filter((c: any) => c.type === 'category').sort((a: any, b: any) => a.position - b.position)[0].name).toMatch(/voice/i);
});

test('server rail: reorder, folders by dropping a server on another, persists', async () => {
  await createServer(A.page, 'Second'); await createServer(A.page, 'Third');
  const rail = A.page.getByRole('navigation', { name: 'Servers' });
  const g = (n: string) => rail.locator('[data-guild]').filter({ has: A.page.getByRole('button', { name: n }) });
  await drag(A.page, g('Third'), g('Feature HQ'), 'top');
  await expect.poll(async () => (await rail.locator('[data-guild]').first().getByRole('button').getAttribute('aria-label'))).toContain('Third');
  // merge: drop Second onto the centre of Third
  await drag(A.page, g('Second'), g('Third'), 'center');
  const folder = rail.locator('[data-folder]'); await expect(folder).toHaveCount(1);
  const fb = folder.getByRole('button').first(); if ((await fb.getAttribute('aria-expanded')) !== 'true') await fb.click();
  await expect(folder.locator('[data-guild]')).toHaveCount(2);
  await A.page.waitForTimeout(1200); await A.page.reload();
  await expect(rail.locator('[data-folder]')).toHaveCount(1);
  await rail.locator('[data-folder]').first().click({ button: 'right' });
  await clickMenu(A.page, 'Ungroup Servers');
  await expect(rail.locator('[data-folder]')).toHaveCount(0);
});

test('pins: channel pin shows in panel and for others, unpin; thread pins work too', async () => {
  await A.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Feature HQ' }).click();
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /^general$/ }).click();
  await sendMessage(A.page, 'pin me');
  const m = msg(A.page, 'pin me').first(); await m.hover(); await m.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(msg(B.page, 'pin me').getByTestId('pinned-mark')).toBeVisible();
  await A.page.getByRole('button', { name: 'Pinned Messages' }).click();
  await expect(A.page.locator('[data-pinned]')).toHaveCount(1);
  await A.page.locator('[data-pinned]').hover(); await A.page.getByRole('button', { name: 'Unpin' }).click();
  await expect(A.page.locator('[data-pinned]')).toHaveCount(0);
  const mid = (await rest(A.page, 'GET', `/channels/${(await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general').id}/messages?limit=5`)).find((x: any) => x.content === 'pin me');
  const th = await rest(A.page, 'POST', `/channels/${mid.channelId}/messages/${mid.id}/threads`, { name: 'side' });
  const tm = await rest(A.page, 'POST', `/channels/${th.id}/messages`, { content: 'in thread' });
  await rest(A.page, 'PUT', `/channels/${th.id}/pins/${tm.id}`, {});
  expect((await rest(A.page, 'GET', `/channels/${th.id}/pins`)).length).toBe(1);
});

test('onboarding: rules screening for a new member', async ({ browser }) => {
  await createServer(A.page, 'Rules HQ'); const rg = await guildId(A.page);
  const rules = await rest(A.page, 'POST', `/guilds/${rg}/channels`, { name: 'rules', type: 'text' });
  await rest(A.page, 'POST', `/channels/${rules.id}/messages`, { content: 'No spam please' });
  await rest(A.page, 'PATCH', `/guilds/${rg}`, { description: 'A tidy place', rulesChannelId: rules.id });
  const inv = await rest(A.page, 'POST', `/guilds/${rg}/invites`, {});
  const C = await newUser(browser, 'Cleo');
  await joinViaInvite(C.page, `/invite/${inv.code}`);
  await expect(C.page.getByRole('heading', { name: 'Welcome to Rules HQ' })).toBeVisible();
  await C.page.getByRole('button', { name: 'Next' }).click();
  await expect(C.page.getByText('No spam please')).toBeVisible();
  const done = C.page.getByRole('button', { name: 'Complete' }); await expect(done).toBeDisabled();
  await C.page.getByLabel('I have read and agree to the rules').check(); await done.click();
  await expect(C.page.getByRole('dialog')).toHaveCount(0);
  await C.page.reload(); await expect(C.page.getByRole('heading', { name: 'Welcome to Rules HQ' })).toHaveCount(0);
  // discovery
  await rest(A.page, 'PATCH', `/guilds/${rg}`, { discoverable: true, vanityUrl: 'rules-hq' });
  const D = await newUser(browser, 'Dora');
  await D.page.goto('/discover');
  const card = D.page.locator('[data-guild-card]').filter({ hasText: 'Rules HQ' }); await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Join' }).click();
  await expect(D.page).toHaveURL(new RegExp(`/channels/${rg}`));
  await C.ctx.close(); await D.ctx.close();
});

test('profile: theme, animated avatar and banner are saved and visible to others', async () => {
  await openUserSettings(A.page, 'Profile');
  await A.page.getByRole('radio', { name: 'Sunset' }).click();
  await A.page.getByRole('button', { name: 'Avatar image' }).locator('xpath=following-sibling::input').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: GIF });
  await A.page.locator('input[type=file]').filter({ hasNot: A.page.locator('x') }).last().setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG });
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).accentColor).toBe('#f0552b');
  const me = await rest(A.page, 'GET', '/users/@me'); expect(me.avatar).toMatch(/\.gif/i); expect(me.banner).toBeTruthy();
  await closeSettings(A.page);
  await B.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Feature HQ' }).click();
  await B.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Alice/ }).click();
  await expect(B.page.getByTestId('profile-card')).toBeVisible();
  await expect(B.page.getByTestId('profile-card').locator('[data-banner="image"]')).toBeVisible();
  await expect(B.page.getByTestId('profile-card').locator('[data-animated]')).toBeVisible();
  await B.page.keyboard.press('Escape');
});

test('custom status with emoji, visible to others, then cleared', async () => {
  await A.page.getByRole('button', { name: 'Set status' }).click();
  await clickMenu(A.page, 'Set Custom Status');
  await A.page.getByLabel('Select emoji').click(); await A.page.getByRole('gridcell').first().click();
  await A.page.getByLabel('Status', { exact: true }).fill('in a meeting');
  await A.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(B.page.getByRole('complementary', { name: 'Members' })).toContainText('in a meeting');
  await A.page.getByRole('button', { name: 'Set status' }).click(); await clickMenu(A.page, 'Clear Custom Status');
  await expect(B.page.getByRole('complementary', { name: 'Members' })).not.toContainText('in a meeting');
});

test('keyboard shortcut help modal', async () => {
  await A.page.keyboard.press('Control+/');
  const d = A.page.getByRole('dialog', { name: 'Keyboard Shortcuts' }); await expect(d).toBeVisible();
  await d.getByLabel('Search shortcuts').fill('mute'); await expect(d.getByText('Toggle mute')).toBeVisible(); await expect(d.getByText('Quick switcher')).toHaveCount(0);
  await A.page.keyboard.press('Escape'); await expect(d).toHaveCount(0);
});

test('streamer mode masks private info; Go Live from the channel menu auto-enables it', async () => {
  await openUserSettings(A.page, 'Streamer Mode');
  await A.page.getByRole('switch', { name: 'Enable Streamer Mode' }).click();
  await A.page.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'My Account' }).click();
  await expect(A.page.getByTestId('account-email')).toContainText('•');
  await closeSettings(A.page);
  await expect(A.page.getByTestId('streamer-badge')).toBeVisible();
  await A.page.getByRole('button', { name: 'Streamer Mode' }).first().isVisible().catch(() => {});
  await openUserSettings(A.page, 'Streamer Mode'); await A.page.getByRole('switch', { name: 'Enable Streamer Mode' }).click(); await closeSettings(A.page);
  await expect(A.page.getByTestId('streamer-badge')).toHaveCount(0);
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click({ button: 'right' });
  await clickMenu(A.page, 'Go Live');
  await expect(A.page.getByTestId('share-popover')).toBeVisible();
  await A.page.getByTestId('share-popover').getByRole('button', { name: 'Go Live' }).click();
  await expect(A.page.getByTestId('streamer-badge')).toBeVisible();
  await A.page.getByRole('button', { name: 'Stop Streaming' }).first().click();
  await A.page.getByRole('button', { name: 'Disconnect' }).first().click();
});

test('notification settings: server level + timed mute are stored on the server', async () => {
  await A.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Feature HQ/ }).click();
  await A.page.getByRole('button', { name: 'Feature HQ server menu' }).click();
  await clickMenu(A.page, 'Notification Settings');
  await A.page.getByRole('radio', { name: 'Only @mentions' }).check();
  await A.page.getByRole('switch', { name: 'Suppress @everyone and @here' }).click();
  await A.page.getByLabel('Mute duration').selectOption({ label: 'For 1 Hour' });
  await A.page.getByRole('switch', { name: 'Mute Server' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me/notification-settings')).guilds.find((x: any) => x.guildId === gid)).toMatchObject({ level: 'mentions', suppressEveryone: true, muted: true });
  const row = (await rest(A.page, 'GET', '/users/@me/notification-settings')).guilds.find((x: any) => x.guildId === gid);
  expect(new Date(row.mutedUntil).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  await A.page.getByRole('switch', { name: 'Mute Server' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me/notification-settings')).guilds.find((x: any) => x.guildId === gid).muted).toBe(false);
  await A.page.keyboard.press('Escape');
});

test('web push: enable/disable on this device registers with the server', async ({ browser }) => {
  const U = await newUser(browser, 'Pushy');
  await U.ctx.grantPermissions(['notifications']);
  await U.page.addInitScript(() => {
    const sub = { endpoint: 'https://push.example.test/send/' + Math.random().toString(36).slice(2), expirationTime: null, toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }; }, unsubscribe: async () => true };
    const reg = { pushManager: { getSubscription: async () => null, subscribe: async () => sub } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
  });
  await U.page.reload();
  await openUserSettings(U.page, 'Notifications');
  await U.page.getByRole('switch', { name: 'Push on this device' }).click();
  await expect.poll(async () => (await rest(U.page, 'GET', '/users/@me/push-devices')).map((d: any) => d.platform)).toEqual(['web']);
  await expect(U.page.locator('[data-device]')).toHaveCount(1);
  await U.page.getByRole('switch', { name: 'Push on this device' }).click();
  await expect.poll(async () => (await rest(U.page, 'GET', '/users/@me/push-devices')).length).toBe(0);
  await U.page.getByRole('switch', { name: 'Receive push notifications' }).click();
  await expect.poll(async () => (await rest(U.page, 'GET', '/users/@me/notification-settings')).pushEnabled).toBe(false);
  await U.ctx.close();
});

test('i18n: Spanish strings and Arabic RTL layout', async () => {
  await openUserSettings(A.page, 'Language');
  await A.page.getByRole('radio', { name: 'Español' }).check();
  await expect(A.page.getByRole('button', { name: 'Mi cuenta' })).toBeVisible();
  await A.page.getByRole('radio', { name: 'العربية' }).check();
  await expect(A.page.locator('html')).toHaveAttribute('dir', 'rtl');
  await closeSettings(A.page);
  const rail = A.page.getByRole('navigation', { name: 'الخوادم' }); await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.x).toBeGreaterThan(700);
  expect(await A.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await A.page.screenshot({ path: new URL('../screenshots/desktop-rtl-arabic.png', import.meta.url).pathname });
  await A.page.getByRole('button', { name: 'إعدادات المستخدم' }).click();
  await A.page.getByRole('button', { name: 'اللغة' }).click(); await A.page.getByRole('radio', { name: 'English (US)' }).check();
  await expect(A.page.locator('html')).toHaveAttribute('dir', 'ltr'); await closeSettings(A.page);
});
