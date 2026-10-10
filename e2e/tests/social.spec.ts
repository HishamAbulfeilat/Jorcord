import { test, expect } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, rest, openUserSettings, closeSettings, clickMenu, type User } from './helpers';

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

test.describe('privacy and message requests', () => {
  let C: User;
  test.beforeAll(async ({ browser }) => { C = await newUser(browser, 'Carol'); });
  test.afterAll(async () => { await C?.ctx.close(); });

  test('a DM from a non-friend arrives as a quiet message request; accepting moves it to Direct Messages', async () => {
    // Alice (server owner) and Bob already share "Social HQ"
    await A.page.goto('/channels/@me');
    const bob = await rest(B.page, 'GET', '/users/@me');
    const dm = await rest(A.page, 'POST', '/users/@me/channels', { recipientIds: [bob.id] });
    await rest(A.page, 'POST', `/channels/${dm.id}/messages`, { content: 'hello from a stranger' });
    await B.page.goto('/channels/@me');
    const sidebar = B.page.getByRole('button', { name: /Message Requests/ });
    await expect(sidebar).toBeVisible();
    await expect(B.page.getByRole('list', { name: 'Message Requests' })).toHaveCount(0);
    await sidebar.click();
    const row = B.page.getByTestId('message-requests').getByRole('button', { name: /Alice/ });
    await expect(row).toBeVisible();
    // not in the regular list, and no unread badge on the server rail Home button
    await expect(B.page.getByRole('navigation', { name: 'Servers' }).getByLabel(/mentions/)).toHaveCount(0);
    await row.click();
    await expect(msg(B.page, 'hello from a stranger')).toBeVisible();
    const banner = B.page.getByTestId('message-request-banner');
    await expect(banner).toContainText('is not on your friends list');
    await banner.getByRole('button', { name: 'Accept' }).click();
    await expect(banner).toHaveCount(0);
    await expect(B.page.getByRole('button', { name: /Message Requests/ })).toHaveCount(0);
    await expect.poll(async () => (await rest(B.page, 'GET', '/users/@me/channels')).length).toBeGreaterThan(0);
  });

  test('Privacy & Safety switches are enforced: no DMs or friend requests when switched off', async () => {
    await openUserSettings(B.page, 'Privacy & Safety');
    const dlg = B.page.getByRole('dialog', { name: 'User Settings' });
    await dlg.getByRole('switch', { name: 'Allow direct messages from server members' }).click();
    await expect.poll(async () => (await rest(B.page, 'GET', '/users/@me')).privacy.allowDmsFromServerMembers).toBe(false);
    for (const n of ['Everyone', 'Friends of friends', 'Server members']) await dlg.getByRole('switch', { name: n, exact: true }).click();
    await expect.poll(async () => (await rest(B.page, 'GET', '/users/@me')).privacy.friendRequests).toEqual({ everyone: false, friendsOfFriends: false, serverMembers: false });
    await closeSettings(B.page);
    // Carol joins the shared server and tries both
    await A.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Social HQ' }).click();
    await joinViaInvite(C.page, await makeInvite(A.page));
    const bob = await rest(B.page, 'GET', '/users/@me');
    await expect(rest(C.page, 'POST', '/users/@me/channels', { recipientIds: [bob.id] })).rejects.toThrow(/DM_DISABLED/);
    await expect(rest(C.page, 'PUT', `/users/@me/relationships/${bob.id}`, { type: 'friend' })).rejects.toThrow(/FRIEND_REQUEST_BLOCKED/);
    // through the UI: Carol opens Bob's profile card and presses Message -> error toast, no DM created
    await C.page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Bob/ }).click();
    await C.page.getByTestId('profile-card').getByRole('button', { name: 'Message' }).click();
    await expect(C.page.getByText(/does not accept direct messages/)).toBeVisible();
  });
});

test('forward a message into a DM: snapshot with a Forwarded label and a jump link back', async () => {
  await B.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Social HQ' }).click();
  await msg(B.page, 'unrelated chatter').first().click({ button: 'right' });
  await clickMenu(B.page, 'Forward');
  const dlg = B.page.getByRole('dialog', { name: 'Forward Message' });
  await expect(dlg.getByRole('button', { name: 'Send' })).toBeDisabled();
  await dlg.getByLabel('Search channels and people').fill('alice');
  await dlg.getByRole('checkbox', { name: /Alice/ }).check();
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(B.page.getByText('Message forwarded')).toBeVisible();
  // Alice receives a forwarded block in the DM (no author of the original is shown, but the label and text are)
  await A.page.goto('/channels/@me');
  await A.page.getByRole('button', { name: /Bob/ }).first().click();
  const fwd = A.page.getByTestId('forwarded').filter({ hasText: 'unrelated chatter' });
  await expect(fwd).toBeVisible();
  await expect(fwd).toContainText('Forwarded');
  await fwd.getByRole('button', { name: '#general' }).click();
  await expect(msg(A.page, 'unrelated chatter').first()).toBeVisible();
  await expect(A.page).toHaveURL(/\/channels\/\d+\/\d+/);
});
