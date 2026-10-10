import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, rest, guildId, sendMessage, msg, type User } from './helpers';

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
  } finally { await B.ctx.close(); }
});
