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

test('linked roles: define criteria in Settings; a member sees requirements and progress and earns the role', async ({ browser }) => {
  const B = await newUser(browser, 'Earner');
  try {
    const gid = await guildId(A.page);
    const chatty = await rest(A.page, 'POST', `/guilds/${gid}/roles`, { name: 'Chatterbox', color: 0x3498db });
    await joinViaInvite(B.page, await makeInvite(A.page));
    await openGuildSettings(A.page, 'Mod Lab', 'Linked Roles');
    const dlg = A.page.getByRole('dialog', { name: 'Mod Lab' });
    await dlg.getByRole('button', { name: 'Link a Role' }).click();
    await dlg.getByLabel('Role', { exact: true }).selectOption(chatty.id);
    await dlg.getByLabel('Description (optional)').fill('For people who talk a lot');
    await dlg.getByLabel('Amount').fill('2'); // default requirement: messages
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    const card = dlg.getByTestId('linked-role').filter({ hasText: 'Chatterbox' });
    await expect(card).toContainText('Has sent at least 2 messages here');
    await expect(card).toContainText('For people who talk a lot');
    await closeSettings(A.page);
    // the member sees the requirement and their progress (read-only: no editing controls)
    await B.page.getByRole('button', { name: 'Mod Lab server menu' }).click();
    await clickMenu(B.page, 'Linked Roles');
    const bdlg = B.page.getByRole('dialog', { name: 'Mod Lab' });
    const mine = bdlg.getByTestId('linked-role').filter({ hasText: 'Chatterbox' });
    await expect(mine).toContainText('0 / 2 messages');
    await expect(bdlg.getByRole('button', { name: 'Link a Role' })).toHaveCount(0);
    await closeSettings(B.page);
    await sendMessage(B.page, 'first one'); await expect(msg(B.page, 'first one')).toBeVisible();
    await sendMessage(B.page, 'second one'); await expect(msg(B.page, 'second one')).toBeVisible();
    await B.page.getByRole('button', { name: 'Mod Lab server menu' }).click();
    await clickMenu(B.page, 'Linked Roles');
    await bdlg.getByRole('button', { name: 'Check again' }).click();
    await expect(mine).toContainText('You have this role');
    await expect(mine).toContainText('2 / 2 messages');
    await closeSettings(B.page);
    // everyone sees the role on the member (managers can not hand it out by hand)
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/members/${(await rest(B.page, 'GET', '/users/@me')).id}`)).roles).toContain(chatty.id);
    // unlinking from Settings keeps the role on the member
    await openGuildSettings(A.page, 'Mod Lab', 'Linked Roles');
    await dlg.getByRole('button', { name: /Unlink Chatterbox/ }).click();
    await expect(dlg.getByTestId('linked-role')).toHaveCount(0);
    await closeSettings(A.page);
  } finally { await B.ctx.close(); }
});

test('app directory: list a bot from the Developer Portal; people find it in Discover > Apps and start the add-bot flow', async ({ browser }) => {
  const B = await newUser(browser, 'Shopper');
  try {
    await createServer(B.page, 'Shopper HQ');
    const p = A.page;
    await p.getByRole('button', { name: 'User Settings' }).first().click();
    await p.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'Developer Portal' }).click();
    await p.getByRole('button', { name: 'New Application' }).click();
    await p.getByLabel('Name').fill('Quizzy');
    await p.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(p).toHaveURL(/\/developers\/\d+\/information/);
    const appId = p.url().match(/developers\/(\d+)/)![1]!;
    await p.getByLabel('Description').fill('Hosts trivia nights for your whole server');
    await p.getByRole('button', { name: 'Save Changes' }).click();
    await expect(p.getByText('Application saved')).toBeVisible();
    await p.getByRole('link', { name: 'Bot', exact: true }).click();
    const listing = p.getByTestId('directory-listing');
    await listing.getByLabel(/^Summary/).fill('Trivia nights, scoreboards and streaks');
    await listing.getByLabel('Category', { exact: true }).selectOption('games');
    await listing.getByLabel(/^Tags/).fill('trivia, quiz');
    await listing.getByRole('button', { name: 'List in App Directory' }).click();
    await expect.poll(async () => (await rest(p, 'GET', `/applications/${appId}`)).directory).toMatchObject({ listed: true, category: 'games', tags: ['trivia', 'quiz'] });
    // a shopper finds it
    await B.page.getByRole('button', { name: 'Explore servers' }).click();
    await B.page.getByRole('tab', { name: 'Apps' }).click();
    const dir = B.page.getByTestId('app-directory');
    await dir.getByLabel('Search apps').fill('quizzy');
    const card = dir.locator(`[data-app-card="${appId}"]`);
    await expect(card).toContainText('Trivia nights, scoreboards and streaks');
    await expect(card).toContainText('#trivia');
    await dir.getByRole('button', { name: /^Music/ }).click(); // other category: nothing
    await expect(card).toHaveCount(0);
    await dir.getByRole('button', { name: /^Games/ }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /Add Quizzy to a server/ }).click();
    await expect(B.page).toHaveURL(new RegExp(`/oauth2/authorize\\?client_id=${appId}`));
    await expect(B.page.getByText('Quizzy').first()).toBeVisible();
    // private bots disappear from the directory
    await rest(p, 'PATCH', `/applications/${appId}`, { botPublic: false });
    await B.page.goBack(); await B.page.getByRole('tab', { name: 'Apps' }).click();
    await dir.getByLabel('Search apps').fill('quizzy');
    await expect(dir.getByText('No apps found')).toBeVisible();
  } finally { await B.ctx.close(); }
});
