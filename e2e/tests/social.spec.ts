import { test, expect } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, rest, type User } from './helpers';

let A: User, B: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); });
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('inbox lists my mentions and jumps to the message; profile has a private note', async () => {
  await createServer(A.page, 'Social HQ');
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv);
  const bob = await rest(B.page, 'GET', '/users/@me');
  const alice = await rest(A.page, 'GET', '/users/@me');
  await sendMessage(A.page, `hello <@${bob.id}> check the inbox`);
  await sendMessage(A.page, 'unrelated chatter');
  // Bob goes home (away from the channel) and opens the inbox
  await B.page.goto('/channels/@me');
  await B.page.getByRole('button', { name: 'Inbox' }).click();
  const inbox = B.page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox.getByText('check the inbox')).toBeVisible();
  await expect(inbox.getByText('unrelated chatter')).toHaveCount(0);
  await inbox.getByText('check the inbox').click();
  await expect(B.page.getByRole('dialog', { name: 'Inbox' })).toHaveCount(0);
  await expect(msg(B.page, 'check the inbox')).toBeVisible();

  // private note: Bob writes one on Alice's profile; it persists and Alice cannot see it
  await B.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Alice/ }).click();
  const note = B.page.getByTestId('profile-card').getByTestId('user-note');
  await note.fill('met in the lobby'); await note.blur();
  await expect.poll(async () => (await rest(B.page, 'GET', `/users/${alice.id}`)).note).toBe('met in the lobby');
  expect((await rest(A.page, 'GET', `/users/${bob.id}`)).note).toBeNull();
  await B.page.keyboard.press('Escape');
  await B.page.reload();
  await B.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Alice/ }).click();
  await expect(B.page.getByTestId('profile-card').getByTestId('user-note')).toHaveValue('met in the lobby');
});
