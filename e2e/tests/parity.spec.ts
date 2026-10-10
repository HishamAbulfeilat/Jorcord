import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, rest, guildId, type User } from './helpers';

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
