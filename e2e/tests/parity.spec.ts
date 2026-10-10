import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, rest, guildId, sendMessage, msg, clickMenu, hoverMsg, GIF, type User } from './helpers';

let A: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Parity'); });
test.afterAll(async () => { await A?.ctx.close(); });

test('soundboard: upload a clip in Server Settings, it is listed and can be renamed and removed', async () => {
  await createServer(A.page, 'Sound Lab');
  await openGuildSettings(A.page, 'Sound Lab', 'Soundboard');
  const dlg = A.page.getByRole('dialog', { name: 'Sound Lab' });
  await dlg.getByLabel('Sound name').fill('airhorn');
  await dlg.getByTestId('sound-file').setInputFiles({ name: 'horn.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(800, 3) });
  await expect(dlg.getByText('airhorn', { exact: true })).toBeVisible();
  const gid = await A.page.evaluate(() => location.pathname.match(/channels\/(\d+)/)![1]);
  expect((await rest(A.page, 'GET', `/guilds/${gid}/soundboard-sounds`))).toHaveLength(1);
  await dlg.getByRole('button', { name: 'Delete airhorn' }).click();
  await expect(dlg.getByText('airhorn', { exact: true })).toHaveCount(0);
  await closeSettings(A.page);
});

test('activities: a manual activity shows in the member list and profile for others; the privacy switch hides it', async ({ browser }) => {
  const B = await newUser(browser, 'Watcher');
  try {
    // B joins A's server
    const gid = await guildId(A.page);
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    await openUserSettings(A.page, 'Privacy & Safety');
    const dlg = A.page.getByRole('dialog', { name: 'User Settings' });
    await dlg.getByLabel('Activity name').fill('Chess');
    await dlg.getByLabel('Activity details').fill('Ranked match');
    await dlg.getByRole('button', { name: 'Set activity' }).click();
    const members = B.page.getByRole('complementary', { name: 'Members' });
    await expect(members.getByTestId('activity-line')).toHaveText('Playing Chess');
    await members.getByRole('button', { name: /Parity/ }).click();
    await expect(B.page.getByTestId('activity-cards')).toContainText('Ranked match');
    await B.page.keyboard.press('Escape');
    await dlg.getByRole('switch', { name: 'Share my activity' }).click();
    await expect(members.getByTestId('activity-line')).toHaveCount(0);
    await dlg.getByRole('switch', { name: 'Share my activity' }).click();
    await expect(members.getByTestId('activity-line')).toHaveText('Playing Chess');
    await closeSettings(A.page);
  } finally { await B.ctx.close(); }
});

test('cosmetics: pick a decoration, effect, plate and server tag; others see them in the member list and messages', async ({ browser }) => {
  const B = await newUser(browser, 'Viewer');
  try {
    const gid = await guildId(A.page);
    // owner sets the server tag in Server Settings
    await openGuildSettings(A.page, 'Sound Lab', 'Server Tag');
    const gd = A.page.getByRole('dialog', { name: 'Sound Lab' });
    await gd.getByLabel('Server tag').fill('LAB1');
    await gd.getByRole('radio', { name: 'Flame' }).click();
    await A.page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}`)).tag).toBe('LAB1');
    await closeSettings(A.page);
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    // Alice picks cosmetics in her profile settings
    await openUserSettings(A.page, 'Profile');
    const ud = A.page.getByRole('dialog', { name: 'User Settings' });
    await ud.getByRole('radio', { name: 'Neon Pulse' }).click();
    await ud.getByRole('radio', { name: 'Snowfall' }).click();
    await ud.getByRole('radio', { name: 'Gold Leaf' }).click();
    await ud.getByRole('radio', { name: /Sound Lab tag LAB1/ }).click();
    await expect(ud.getByTestId('preview-name')).toContainText('LAB1');
    await A.page.getByRole('button', { name: 'Save Changes' }).click();
    await closeSettings(A.page);
    const members = B.page.getByRole('complementary', { name: 'Members' });
    await expect(members.locator('[data-deco="neon"]')).toHaveCount(1);
    await expect(members.getByTestId('server-tag')).toHaveText('LAB1');
    await expect(members.locator('.plate-gold')).toHaveCount(1);
    await members.getByRole('button', { name: /Parity/ }).click();
    await expect(B.page.getByTestId('profile-card').locator('[data-effect="snowfall"]')).toHaveCount(1);
    await B.page.keyboard.press('Escape');
    await sendMessage(A.page, 'tagged hello');
    await expect(msg(B.page, 'tagged hello').getByTestId('server-tag')).toHaveText('LAB1');
  } finally { await B.ctx.close(); }
});

test('safety: Safety Setup applies a preset; verification level blocks an unverified member and invites can be paused', async ({ browser }) => {
  const B = await newUser(browser, 'Newbie');
  try {
    const gid = await guildId(A.page);
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    await openGuildSettings(A.page, 'Sound Lab', 'Safety Setup');
    const dlg = A.page.getByRole('dialog', { name: 'Sound Lab' });
    await expect(dlg.getByTestId('safety-score')).toHaveText('20%');
    await dlg.getByRole('button', { name: /Recommended/ }).click();
    await expect(dlg.getByTestId('safety-score')).toHaveText('80%');
    await dlg.getByRole('radio', { name: 'Low' }).click();
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/safety`)).verificationLevel).toBe(1);
    // the unverified newcomer cannot talk
    await sendMessage(B.page, 'can I talk?');
    await expect(B.page.getByText(/verified email/i).first()).toBeVisible();
    await expect(msg(B.page, 'can I talk?')).toHaveCount(0);
    // pausing invites refuses new joiners
    await dlg.getByRole('switch', { name: 'Pause invites' }).click();
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/safety`)).invitesPausedUntil).toBeTruthy();
    const C = await newUser(browser, 'Late');
    await C.page.goto(`/invite/${code}`);
    await C.page.getByRole('button', { name: /Accept Invite/ }).click();
    await expect(C.page.getByText(/paused/i).first()).toBeVisible();
    await C.ctx.close();
    await closeSettings(A.page);
    await rest(A.page, 'PATCH', `/guilds/${gid}/safety`, { pauseInvites: false, verificationLevel: 0 }); // leave the server open for later tests
  } finally { await B.ctx.close(); }
});

test('onboarding: newcomers answer questions, get the role and only their opted-in channels; Hide Muted Channels works', async ({ browser }) => {
  const B = await newUser(browser, 'Joiner');
  try {
    const gid = await guildId(A.page);
    const games = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'games-chat', type: 'text' });
    const art = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'art-chat', type: 'text' });
    const general = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general');
    const gamer = await rest(A.page, 'POST', `/guilds/${gid}/roles`, { name: 'gamer' });
    await rest(A.page, 'PUT', `/guilds/${gid}/onboarding`, { enabled: true, defaultChannelIds: [general.id], prompts: [{ title: 'What are you into?', required: true, options: [{ title: 'Games', emoji: '🎮', channelIds: [games.id], roleIds: [gamer.id] }, { title: 'Art', channelIds: [art.id], roleIds: [] }] }] });
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    const dlg = B.page.getByRole('dialog', { name: 'Channels & Roles' });
    await expect(dlg.getByTestId('onboarding-questions')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Save' })).toBeDisabled(); // required question
    await dlg.getByRole('checkbox', { name: /Games/ }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    const nav = B.page.getByRole('navigation', { name: 'Channels' });
    await expect(nav.getByRole('button', { name: /games-chat/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /art-chat/ })).toHaveCount(0);
    await B.page.getByTestId('browse-channels').click();
    await expect(nav.getByRole('button', { name: /art-chat/ })).toBeVisible();
    await B.page.getByTestId('browse-channels').click();
    const me = await rest(B.page, 'GET', '/users/@me');
    const mem = (await rest(A.page, 'GET', `/guilds/${gid}/members?limit=100`)).find((m: any) => m.user.id === me.id);
    expect(mem.roles).toContain(gamer.id);
    // Hide Muted Channels
    await nav.getByRole('button', { name: /games-chat/ }).click({ button: 'right' });
    await clickMenu(B.page, 'Mute Channel');
    await expect(nav.getByRole('button', { name: /games-chat/ })).toBeVisible(); // still shown until asked
    await nav.getByRole('button', { name: /general/ }).click(); // leave the muted channel so it is not "the open one"
    await B.page.getByRole('button', { name: /server menu/ }).click();
    await clickMenu(B.page, 'Hide Muted Channels');
    await expect(nav.getByRole('button', { name: /games-chat/ })).toHaveCount(0);
    await rest(A.page, 'PUT', `/guilds/${gid}/onboarding`, { enabled: false }); // later tests join this server too
  } finally { await B.ctx.close(); }
});

test('announcements: follow a channel into your own server, publish, and the copy arrives with its origin', async ({ browser }) => {
  const B = await newUser(browser, 'Follower');
  try {
    const gid = await guildId(A.page);
    const ann = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'news', type: 'announcement' });
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    await createServer(B.page, 'Follower HQ');
    const bGuild = await guildId(B.page);
    const bGeneral = (await rest(B.page, 'GET', `/guilds/${bGuild}/channels`)).find((c: any) => c.name === 'general');
    // follow from the announcement channel's header
    await B.page.goto(`/channels/${gid}/${ann.id}`);
    await B.page.getByRole('button', { name: 'Follow Channel' }).click();
    const dlg = B.page.getByRole('dialog', { name: 'Follow Channel' });
    await dlg.getByLabel('Deliver to').selectOption(bGeneral.id);
    await dlg.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(B.page.getByText(/Following!/)).toBeVisible();
    // Alice publishes
    await A.page.goto(`/channels/${gid}/${ann.id}`);
    await sendMessage(A.page, 'Release 2.0 is out');
    await (await hoverMsg(A.page, 'Release 2.0 is out')).getByRole('button', { name: 'Publish' }).click();
    await expect(msg(A.page, 'Release 2.0 is out').getByTestId('published-mark')).toBeVisible();
    await B.page.goto(`/channels/${bGuild}/${bGeneral.id}`);
    const copy = msg(B.page, 'Release 2.0 is out');
    await expect(copy).toBeVisible();
    await expect(copy.getByTestId('crosspost-origin')).toContainText('Sound Lab');
    await expect(copy.getByTestId('crosspost-origin')).toContainText('#news');
    // unfollow from the channel's settings
    await rest(B.page, 'GET', `/channels/${bGeneral.id}/follows`).then((l) => expect(l).toHaveLength(1));
  } finally { await B.ctx.close(); }
});

test('server template link creates a copy, the widget is public, insights show activity', async ({ browser }) => {
  const B = await newUser(browser, 'Cloner');
  try {
    const gid = await guildId(A.page);
    // template
    await openGuildSettings(A.page, 'Sound Lab', 'Server Template');
    const dlg = A.page.getByRole('dialog', { name: 'Sound Lab' });
    await dlg.getByLabel('Template name').fill('Lab Kit');
    await dlg.getByRole('button', { name: 'Generate Template Link' }).click();
    const link = await dlg.getByLabel('Template link').inputValue();
    expect(link).toMatch(/\/template\/[A-Za-z0-9]{12}$/);
    await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'after-sync', type: 'text' });
    await A.page.getByRole('button', { name: 'Server Overview' }).or(dlg.getByRole('button', { name: 'Overview' })).first().click();
    await dlg.getByRole('button', { name: 'Server Template' }).click();
    await expect(dlg.getByTestId('template-dirty')).toBeVisible();
    await dlg.getByRole('button', { name: 'Sync Template' }).click();
    await expect(dlg.getByTestId('template-dirty')).toHaveCount(0);
    // B uses it
    await B.page.goto(new URL(link).pathname);
    await expect(B.page.getByTestId('template-page')).toContainText('Lab Kit');
    await B.page.getByLabel('Server Name').fill('Cloned Lab');
    await B.page.getByRole('button', { name: 'Create Server' }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    await expect(B.page.getByRole('button', { name: 'Cloned Lab server menu' })).toBeVisible();
    await expect(B.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /after-sync/ })).toBeVisible();
    // widget
    await dlg.getByRole('button', { name: 'Widget' }).click();
    await dlg.getByRole('switch', { name: 'Enable server widget' }).click();
    await expect(dlg.getByTestId('widget-preview')).toBeVisible();
    const w = await A.page.evaluate(async (id) => (await fetch(`/api/v1/guilds/${id}/widget.json`)).json(), gid);
    expect(w.name).toBe('Sound Lab');
    expect(await dlg.getByTestId('widget-preview').evaluate((i: HTMLImageElement) => new Promise<number>((res) => (i.complete ? res(i.naturalWidth) : (i.onload = () => res(i.naturalWidth)))))).toBeGreaterThan(0);
    // insights
    await dlg.getByRole('button', { name: 'Insights' }).click();
    await expect(dlg.getByTestId('insights-tab')).toBeVisible();
    await expect(dlg.getByTestId('insight-members')).not.toHaveText('0');
    await dlg.getByRole('radio', { name: '30 days' }).click();
    await expect(dlg.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
    // vanity invite link
    await dlg.getByRole('button', { name: 'Overview' }).first().click();
    const vanity = `soundlab-${Math.random().toString(36).slice(2, 7)}`;
    await dlg.getByLabel('Custom invite link').fill(vanity);
    await dlg.getByRole('button', { name: 'Claim' }).click();
    await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}`)).vanityUrl).toBe(vanity);
    await closeSettings(A.page);
  } finally { await B.ctx.close(); }
});

test('GIF favorites: save an image from chat, find it under Favorites in the picker, remove it', async () => {
  const gid = await guildId(A.page);
  const general = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general');
  await A.page.goto(`/channels/${gid}/${general.id}`);
  await A.page.locator('input[type=file]').first().setInputFiles({ name: 'dancing.gif', mimeType: 'image/gif', buffer: GIF });
  const box = A.page.getByRole('textbox', { name: /^Message/ });
  await box.fill('dancing gif time'); await box.press('Enter');
  const m = msg(A.page, 'dancing gif time');
  await expect(m).toBeVisible();
  await m.click({ button: 'right', position: { x: 300, y: 10 } });
  await clickMenu(A.page, 'Add to GIF Favorites');
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me/gif-favorites')).length).toBe(1);
  await A.page.getByRole('button', { name: 'Choose emoji or GIF' }).click();
  await A.page.getByRole('button', { name: 'GIFs' }).click();
  await A.page.getByRole('tab', { name: 'Favorites' }).click();
  const grid = A.page.getByTestId('gif-grid');
  await expect(grid.getByRole('button', { name: /dancing/ }).first()).toBeVisible();
  await grid.getByRole('button', { name: 'Remove from favorites' }).first().click({ force: true });
  await expect.poll(async () => (await rest(A.page, 'GET', '/users/@me/gif-favorites')).length).toBe(0);
  await expect(grid.getByText(/No favorites yet/)).toBeVisible();
  await A.page.keyboard.press('Escape');
});

test('connections: add a link, others see it on the profile, hiding removes it', async ({ browser }) => {
  const B = await newUser(browser, 'Looker');
  try {
    const gid = await guildId(A.page);
    const code = (await rest(A.page, 'POST', `/guilds/${gid}/invites`, {})).code;
    await B.page.goto(`/invite/${code}`);
    await B.page.getByRole('button', { name: /Accept Invite/ }).click();
    await B.page.waitForURL(/\/channels\/\d+/);
    await openUserSettings(A.page, 'Connections');
    const dlg = A.page.getByRole('dialog', { name: 'User Settings' });
    await dlg.getByLabel('Service').selectOption('github');
    await dlg.getByLabel('Connection handle').fill('octo-cat');
    await dlg.getByRole('button', { name: 'Add connection' }).click();
    const row = dlg.getByTestId('connection-row');
    await expect(row).toContainText('octo-cat'); await expect(row).toContainText('Not verified');
    await expect(row.getByTestId('verify-code')).toContainText('jorcord-verify=');
    await B.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Parity/ }).click();
    const link = B.page.getByTestId('profile-connections').getByRole('link', { name: /GitHub/ });
    await expect(link).toHaveAttribute('href', 'https://github.com/octo-cat');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await dlg.getByRole('switch', { name: 'Show on profile: GitHub' }).click();
    await B.page.reload();
    await B.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Parity/ }).click();
    await expect(B.page.getByTestId('profile-card')).toBeVisible();
    await expect(B.page.getByTestId('profile-connections')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Remove GitHub' }).click();
    await expect(dlg.getByTestId('connection-row')).toHaveCount(0);
    await closeSettings(A.page);
  } finally { await B.ctx.close(); }
});
