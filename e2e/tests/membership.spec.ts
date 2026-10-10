import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, msg, sendMessage, hoverMsg, openUserSettings, openGuildSettings, closeSettings, clickMenu, type User } from './helpers';

let A: User, B: User, C: User, D: User, gid: string, general: string, rules: string, inv: string;
test.describe.configure({ mode: 'serial' });
const nav = (p: Page) => p.getByRole('navigation', { name: 'Channels' });
const members = (p: Page) => p.getByRole('complementary', { name: 'Members' });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); C = await newUser(browser, 'Carol'); D = await newUser(browser, 'Dave');
  await createServer(A.page, 'Gate HQ'); gid = await guildId(A.page);
  inv = await makeInvite(A.page); await joinViaInvite(B.page, inv);
  general = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general').id;
});
test.afterAll(async () => { for (const u of [A, B, C, D]) await u?.ctx.close(); });

test('membership screening: owner enables it with a rules channel; new members must accept before chatting', async () => {
  rules = (await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'rules', type: 'text' })).id;
  await rest(A.page, 'POST', `/channels/${rules}/messages`, { content: 'Rule one: be kind to each other' });
  await rest(A.page, 'POST', `/channels/${rules}/messages`, { content: 'Rule two: no spam, please' });
  await openGuildSettings(A.page, 'Gate HQ', 'Overview');
  const dlg = A.page.getByRole('dialog', { name: 'Gate HQ' });
  await expect(dlg.getByRole('switch', { name: 'Membership Screening' })).toBeDisabled();             // needs a rules channel first
  await dlg.getByLabel('Rules Channel').selectOption({ label: '#rules' });
  await dlg.getByRole('switch', { name: 'Membership Screening' }).click();
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}`)).features).toContain('MEMBER_SCREENING');
  await closeSettings(A.page);

  await joinViaInvite(C.page, inv);
  const modal = C.page.getByRole('dialog', { name: 'Review the rules' });
  await expect(modal).toBeVisible();                                   // opened by itself for a pending member
  await expect(modal.getByTestId('screening-rules')).toContainText('Rule one: be kind to each other'); await expect(modal.getByTestId('screening-rules')).toContainText('Rule two: no spam, please');
  await expect(modal.getByRole('button', { name: 'Complete' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Maybe later' }).click();
  // read-only until accepted: composer disabled, banner, server refuses, others see the Pending badge
  await C.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click();
  await expect(C.page.getByRole('textbox', { name: 'Accept the server rules to start chatting.' })).toBeDisabled();
  await expect(C.page.getByTestId('screening-banner')).toContainText('accept the server rules');
  const refused = await rest(C.page, 'POST', `/channels/${general}/messages`, { content: 'let me talk' }).catch((e: Error) => e.message);
  expect(String(refused)).toContain('403');
  await expect(members(A.page).getByTestId('pending-badge')).toHaveCount(1);
  await expect(members(A.page).locator('li').filter({ hasText: 'Carol' }).getByTestId('pending-badge')).toBeVisible();
  // accept through the banner
  await C.page.getByTestId('screening-banner').getByRole('button', { name: 'Review Rules' }).click();
  await C.page.getByRole('dialog', { name: 'Review the rules' }).getByLabel('I have read and agree to the rules').check();
  await C.page.getByRole('dialog', { name: 'Review the rules' }).getByRole('button', { name: 'Complete' }).click();
  await expect(C.page.getByTestId('screening-banner')).toHaveCount(0);
  await sendMessage(C.page, 'hello, I read the rules');
  await expect(msg(A.page, 'hello, I read the rules')).toBeVisible();
  await expect(members(A.page).getByTestId('pending-badge')).toHaveCount(0);       // MEMBER_UPDATE
  const s = await rest(C.page, 'GET', `/guilds/${gid}/screening`); expect(s).toMatchObject({ enabled: true, pending: false, rulesChannelId: rules });
});

test('discoverable servers: join from Discover without an invite (and land in screening)', async () => {
  // not discoverable yet: the endpoint hides the guild
  const hidden = await rest(D.page, 'POST', `/discover/guilds/${gid}/join`).catch((e: Error) => e.message);
  expect(String(hidden)).toContain('404');
  await openGuildSettings(A.page, 'Gate HQ', 'Overview');
  const dlg = A.page.getByRole('dialog', { name: 'Gate HQ' });
  await dlg.getByLabel('Description').fill('A very gated community');
  await dlg.getByRole('switch', { name: 'Enable Discovery' }).click();
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}`)).features).toContain('DISCOVERABLE');
  await closeSettings(A.page);

  await D.page.getByRole('button', { name: 'Explore servers' }).click();
  const c = D.page.locator(`[data-guild-card="${gid}"]`);
  await expect(c).toContainText('A very gated community');
  await c.getByRole('button', { name: 'Join' }).click();
  await expect(D.page).toHaveURL(new RegExp(`/channels/${gid}`));
  await expect(D.page.getByRole('dialog', { name: 'Review the rules' })).toBeVisible();   // screened server: pending
  await expect(members(A.page)).toContainText('Dave');
  expect((await rest(D.page, 'GET', `/guilds/${gid}/screening`)).pending).toBe(true);
  await D.page.getByRole('dialog', { name: 'Review the rules' }).getByRole('button', { name: 'Maybe later' }).click();
  await D.page.getByRole('button', { name: 'Explore servers' }).click();
  await expect(D.page.locator(`[data-guild-card="${gid}"]`).getByRole('button', { name: 'Open' })).toBeVisible();  // already a member
});

test('two-colour profile theme: pick a preset, tune a colour, others see the gradient; clear it', async () => {
  await openUserSettings(A.page, 'Profile');
  const dlg = A.page.getByRole('dialog', { name: 'User Settings' });
  await dlg.getByRole('radio', { name: 'Dusk' }).click();
  await expect(dlg.getByTestId('preview-banner')).toHaveCSS('background-image', /linear-gradient\(135deg, rgb\(240, 85, 43\), rgb\(142, 68, 173\)\)/);
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).themeColors).toEqual(['#f0552b', '#8e44ad']);
  await dlg.getByLabel('Accent colour').fill('#112233'); await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).themeColors).toEqual(['#f0552b', '#112233']);
  await closeSettings(A.page);
  // Bob opens Alice's profile (public)
  await members(B.page).getByRole('button', { name: /Alice/ }).click();
  const card = B.page.getByTestId('profile-card');
  await expect(card).toHaveAttribute('data-theme-pair', 'on');
  await expect(card.locator('[data-banner]')).toHaveAttribute('data-banner', 'theme');
  await expect(card.locator('[data-banner]')).toHaveCSS('background-image', /linear-gradient\(135deg, rgb\(240, 85, 43\), rgb\(17, 34, 51\)\)/);
  await B.page.keyboard.press('Escape');
  // invalid pairs are rejected by the server, clearing works from the UI
  const bad = await rest(A.page, 'PATCH', '/users/@me', { themeColors: ['#fff', '#000'] }).catch((e: Error) => e.message); expect(String(bad)).toContain('400');
  await openUserSettings(A.page, 'Profile'); await A.page.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'Remove gradient' }).click();
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).themeColors ?? null).toBeNull();
  await closeSettings(A.page);
});

test('custom status expiry is sent to the server (and the server clears it live)', async () => {
  await A.page.getByRole('button', { name: 'Set status' }).click(); await clickMenu(A.page, 'Set Custom Status');
  const dlg = A.page.getByRole('dialog', { name: 'Set a custom status' });
  await dlg.getByLabel('Status').fill('In a meeting'); await dlg.getByLabel('Clear after').selectOption({ label: '30 minutes' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => { const s = (await rest(A.page, 'GET', '/users/@me')).customStatus; return s ? Date.parse(s.expiresAt) - Date.now() : 0; }).toBeGreaterThan(29 * 60_000);
  expect(Date.parse((await rest(A.page, 'GET', '/users/@me')).customStatus.expiresAt) - Date.now()).toBeLessThan(31 * 60_000);
  await A.page.getByRole('button', { name: 'Set status' }).click(); await clickMenu(A.page, 'Edit Custom Status');
  await expect(A.page.getByTestId('status-expiry')).toContainText('Clears');
  await A.page.getByRole('dialog', { name: 'Set a custom status' }).getByLabel('Clear after').selectOption({ label: "Don't clear" });
  await A.page.getByRole('dialog', { name: 'Set a custom status' }).getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).customStatus.expiresAt ?? null).toBeNull();
  // a status that expires in a few seconds disappears for everyone without any client timer of Alice's
  await rest(A.page, 'PATCH', '/users/@me', { customStatus: { text: 'brb', emoji: null, expiresAt: new Date(Date.now() + 4000).toISOString() } });
  await expect(members(B.page)).toContainText('brb');
  await expect(members(B.page)).not.toContainText('brb', { timeout: 25_000 });
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me')).customStatus ?? null).toBeNull();
});

test('audit log viewer: new actions have readable labels and the numeric action-type filter works', async () => {
  await sendMessage(B.page, 'a message to pin'); await sendMessage(B.page, 'a message to remove');
  const pin = await hoverMsg(A.page, 'a message to pin'); await pin.getByRole('button', { name: 'Pin' }).click();
  const del = await hoverMsg(A.page, 'a message to remove'); await del.getByRole('button', { name: 'Delete' }).click(); await A.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(msg(A.page, 'a message to remove')).toHaveCount(0);
  await openGuildSettings(A.page, 'Gate HQ', 'Audit Log');
  const dlg = A.page.getByRole('dialog', { name: 'Gate HQ' });
  await expect(dlg.locator('[data-action="MESSAGE_PIN"]')).toContainText('pinned a message');
  await expect(dlg.locator('[data-action="MESSAGE_DELETE"]')).toContainText('deleted a message');
  await expect(dlg.locator('[data-action="MEMBER_UPDATE"], [data-action="BOT_ADD"], [data-action="FORUM_TAG_UPDATE"]')).toHaveCount(0);
  await dlg.getByLabel('Filter by action').selectOption({ label: 'Message pin' });
  await expect(dlg.locator('li[data-action]')).toHaveCount(1); await expect(dlg.locator('li[data-action]')).toHaveAttribute('data-action-type', '74');
  await dlg.getByLabel('Filter by action').selectOption({ label: 'Message delete' });
  await expect(dlg.locator('li[data-action]')).toHaveCount(1); await expect(dlg.locator('li[data-action]')).toHaveAttribute('data-action', 'MESSAGE_DELETE');
  expect((await rest(A.page, 'GET', `/guilds/${gid}/audit-logs?actionType=74`)).every((e: any) => e.actionType === 74)).toBe(true);
  // filter options cover the platform actions
  const opts = await dlg.getByLabel('Filter by action').locator('option').allInnerTexts();
  for (const o of ['Bot add', 'Poll end', 'Forum tag update', 'Thread delete', 'Guild scheduled event create', 'Stage instance create', 'Sticker update', 'Application command permission update']) expect(opts, o).toContain(o);
  await closeSettings(A.page);
});
