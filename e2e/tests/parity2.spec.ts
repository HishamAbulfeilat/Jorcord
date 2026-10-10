import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, rest, guildId, makeInvite, joinViaInvite, sendMessage, msg, clickMenu, type User } from './helpers';

let A: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Warden'); });
test.afterAll(async () => { await A?.ctx.close(); });

test('automod: regex + block/alert rule from Settings, sandbox preview, alert embed in the log channel', async ({ browser }) => {
  const B = await newUser(browser, 'Offender');
  try {
    await createServer(A.page, 'Mod Lab');
    const gid = await guildId(A.page);
    const log = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'mod-log', type: 'text' });
    await openGuildSettings(A.page, 'Mod Lab', 'AutoMod');
    const dlg = A.page.getByRole('dialog', { name: 'Mod Lab' });
    await dlg.getByLabel('Name', { exact: true }).fill('No promo');
    await dlg.getByLabel('Trigger').selectOption('regex');
    await dlg.getByLabel('Patterns', { exact: true }).fill('free\\s+nitro');
    await dlg.getByRole('checkbox', { name: 'Send alert' }).check();
    await expect(dlg.getByRole('button', { name: 'Create Rule' })).toBeDisabled(); // alert needs a channel
    await dlg.getByLabel('Alert channel', { exact: true }).selectOption(log.id);
    await dlg.getByRole('button', { name: 'Create Rule' }).click();
    await expect(dlg.getByRole('listitem').filter({ hasText: 'No promo' })).toContainText('Pattern (regex)');
    await dlg.getByLabel('Sample message').fill('get FREE   Nitro now');
    await dlg.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(dlg.getByText('Would trigger: No promo')).toBeVisible();
    await closeSettings(A.page);

    await joinViaInvite(B.page, await makeInvite(A.page));
    await sendMessage(B.page, 'hello friends');
    await expect(msg(B.page, 'hello friends')).toBeVisible();
    await sendMessage(B.page, 'claim free   nitro here');
    await expect(msg(B.page, 'claim free   nitro here')).toHaveCount(0);
    await expect.poll(async () => (await rest(A.page, 'GET', `/channels/${log.id}/messages?limit=10`)).filter((m: any) => m.embeds.length).length).toBe(1);
    await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /mod-log/ }).click();
    const alert = msg(A.page, 'AutoMod: No promo');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('claim free   nitro here');
    await expect(alert).toContainText('blocked message');
  } finally { await B.ctx.close(); }
});

test('boosts: level page with perks and progress, boost + take back, booster role and announcement', async ({ browser }) => {
  const B = await newUser(browser, 'Booster');
  try {
    const gid = await guildId(A.page);
    await joinViaInvite(B.page, await makeInvite(A.page));
    await B.page.getByRole('button', { name: 'Mod Lab server menu' }).click();
    await clickMenu(B.page, 'Server Boost'); // every member can open the boost page
    const dlg = B.page.getByRole('dialog', { name: 'Mod Lab' });
    await expect(dlg.getByTestId('boost-level')).toHaveText('Level 0');
    await expect(dlg.getByTestId('boost-levels').getByRole('region')).toHaveCount(3);
    await expect(dlg.getByRole('region', { name: 'Level 2' })).toContainText('+50 emoji slots (150 total)');
    await expect(dlg.getByRole('progressbar', { name: 'Boost progress' })).toHaveAttribute('aria-valuenow', '0');
    await dlg.getByRole('button', { name: 'Boost This Server' }).click();
    await expect(dlg.getByRole('progressbar', { name: 'Boost progress' })).toHaveAttribute('aria-valuenow', '50');
    await dlg.getByRole('button', { name: 'Boost Again' }).click();
    await expect(dlg.getByTestId('boost-level')).toHaveText('Level 1');
    await expect(dlg.getByTestId('boosters')).toContainText('Booster');
    await expect(dlg.getByTestId('boosters')).toContainText('2 boosts');
    await dlg.getByRole('button', { name: /Remove one of my boosts \(2\)/ }).click();
    await expect(dlg.getByTestId('boost-level')).toHaveText('Level 0');
    await dlg.getByRole('button', { name: 'Boost Again' }).click();
    await expect(dlg.getByTestId('boost-level')).toHaveText('Level 1');
    await closeSettings(B.page);
    // everyone sees the rocket badge in the member list and the announcements
    const members = A.page.getByRole('complementary', { name: 'Members' });
    await expect(members.getByRole('listitem').filter({ hasText: 'Booster' }).getByLabel('Boosting this server')).toBeVisible();
    await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /general/ }).first().click();
    await expect(msg(A.page, /just boosted/).first()).toBeVisible();
    await expect(msg(A.page, /reached Level 1/).first()).toBeVisible();
    expect((await rest(A.page, 'GET', `/guilds/${gid}/boosts`)).level).toBe(1);
    // a manager can switch the booster role off
    await openGuildSettings(A.page, 'Mod Lab', 'Server Boost');
    const adlg = A.page.getByRole('dialog', { name: 'Mod Lab' });
    await adlg.getByRole('switch', { name: 'Booster role' }).click();
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/boosts`)).settings.boosterRoleId).toBeNull();
    await closeSettings(A.page);
  } finally { await B.ctx.close(); }
});
