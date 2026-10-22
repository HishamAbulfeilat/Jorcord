import { test, expect } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, guildId, rest, openUserSettings, openGuildSettings, closeSettings } from './helpers';

test('ban appeals: banned user appeals from settings, moderator approves in server settings', async ({ browser }) => {
  const owner = await newUser(browser, 'ApO');
  const bad = await newUser(browser, 'ApB');
  await createServer(owner.page, 'Appeal Land');
  const gid = await guildId(owner.page);
  await joinViaInvite(bad.page, await makeInvite(owner.page));
  const badId = (await rest(bad.page, 'GET', '/users/@me')).id as string;
  await rest(owner.page, 'PUT', `/guilds/${gid}/bans/${badId}`, { reason: 'spamming' });

  // banned user: Privacy & Safety lists the ban and lets them appeal once
  await bad.page.goto('/channels/@me');
  await openUserSettings(bad.page, /Privacy/);
  const row = bad.page.getByTestId('my-bans');
  await expect(row.getByText('Appeal Land')).toBeVisible();
  await row.getByRole('button', { name: 'Appeal ban' }).click();
  await bad.page.getByLabel('Appeal message').fill('Please unban me, it was a misunderstanding.');
  await bad.page.getByRole('button', { name: 'Send appeal' }).click();
  await expect(row.getByText('Appeal pending')).toBeVisible();

  // moderator sees it in the Appeals queue and approves
  await openGuildSettings(owner.page, 'Appeal Land', 'Appeals');
  await expect(owner.page.getByTestId('appeal-message')).toHaveText('Please unban me, it was a misunderstanding.');
  await owner.page.getByLabel('Decision reason').fill('Welcome back');
  await owner.page.getByRole('button', { name: 'Approve & Unban' }).click();
  await expect(owner.page.getByTestId('appeal-list')).toHaveCount(1);
  await expect(owner.page.getByRole('button', { name: 'Approve & Unban' })).toHaveCount(0);
  expect(await rest(owner.page, 'GET', `/guilds/${gid}/bans`)).toHaveLength(0);
  await closeSettings(owner.page);

  // the former appellant is no longer banned and can see the verdict via the API
  expect(await rest(bad.page, 'GET', '/users/@me/bans')).toHaveLength(0);
  await owner.ctx.close(); await bad.ctx.close();
});
