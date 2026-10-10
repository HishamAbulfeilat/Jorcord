import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, msg, sendMessage, clickMenu, type User } from './helpers';

let A: User, B: User, gid: string, forum: string, general: string;
test.describe.configure({ mode: 'serial' });
const nav = (p: Page) => p.getByRole('navigation', { name: 'Channels' });
const chan = (p: Page, name: string) => nav(p).getByRole('button', { name, exact: true });
const card = (p: Page, title: string) => p.locator('li').filter({ has: p.getByText(title, { exact: true }) }).filter({ has: p.locator('button') });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Forum HQ'); gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
  general = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general').id;
  forum = (await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'help', type: 'forum' })).id;
  for (const u of [A, B]) await u.page.reload();
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('forum tags: the tag editor in channel settings (add, moderated, require tag, default auto-archive)', async () => {
  const row = chan(A.page, 'help'); await row.hover();
  await row.locator('xpath=ancestor::li').getByRole('button', { name: 'Edit Channel' }).click({ force: true });
  const dlg = A.page.getByRole('dialog', { name: '#help' });
  await dlg.getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(dlg.getByRole('heading', { name: 'Tags', exact: true })).toBeVisible();
  await dlg.getByRole('button', { name: 'Add Tag' }).click();
  await dlg.getByLabel('Tag 1 name').fill('Question'); await dlg.getByLabel('Tag 1 emoji').fill('❓');
  await dlg.getByRole('button', { name: 'Add Tag' }).click();
  await dlg.getByLabel('Tag 2 name').fill('Bug'); await dlg.getByLabel('Tag 2 emoji').fill('🐛');
  await dlg.locator('[data-tag="Bug"]').getByLabel('Moderated').check();
  await dlg.getByRole('button', { name: 'Add Tag' }).click(); await dlg.getByRole('button', { name: 'Remove tag 3' }).click(); // blank tags are dropped
  await dlg.getByRole('switch', { name: 'Require tag' }).click();
  await dlg.getByLabel('Hide After Inactivity').selectOption({ label: '3 Days' });
  await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(A.page.getByText('Tags saved')).toBeVisible();
  const ch = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.id === forum);
  expect(ch.availableTags.map((t: any) => [t.name, t.emoji, t.moderated])).toEqual([['Question', '❓', false], ['Bug', '🐛', true]]);
  expect(ch).toMatchObject({ requireTag: true, defaultAutoArchiveDuration: 4320 });
  // renaming keeps ids (so posts keep their tags); removing a tag drops it
  const ids = ch.availableTags.map((t: any) => t.id);
  await dlg.getByLabel('Tag 1 name').fill('Help'); await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.id === forum).availableTags[0].id).toBe(ids[0]);
  await dlg.getByLabel('Tag 1 name').fill('Question'); await A.page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(A.page.getByText('Tags saved').first()).toBeVisible();
  await A.page.keyboard.press('Escape');
});

test('forum posts: a tag is required, moderated tags are locked for members, posts show their tags, filter by tag', async () => {
  await chan(B.page, 'help').click();
  await B.page.getByRole('button', { name: 'New Post' }).click();
  const dlg = B.page.getByRole('dialog', { name: 'New Post' });
  await dlg.getByLabel('Post Title').fill('How do I reset my password?'); await dlg.getByLabel('Message').fill('I forgot it.');
  await expect(dlg.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();            // requireTag
  await expect(dlg.getByRole('button', { name: /Bug/ })).toBeDisabled();                           // moderated
  await dlg.getByRole('button', { name: /Question/ }).click(); await expect(dlg.getByRole('button', { name: /Question/ })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(B.page.getByRole('heading', { name: 'How do I reset my password?', exact: true })).toBeVisible();  // opened the thread
  // the server enforces it too
  const err = await rest(B.page, 'POST', `/channels/${forum}/forum/posts`, { name: 'no tag', content: 'x' }).catch((e: Error) => e.message);
  expect(String(err)).toContain('400');
  const bug = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.id === forum).availableTags.find((t: any) => t.name === 'Bug');
  const forbidden = await rest(B.page, 'POST', `/channels/${forum}/forum/posts`, { name: 'bug post', content: 'x', appliedTags: [bug.id] }).catch((e: Error) => e.message);
  expect(String(forbidden)).toContain('403');
  // Alice (moderator) posts a bug
  await chan(A.page, 'help').click(); await A.page.getByRole('button', { name: 'New Post' }).click();
  const ad = A.page.getByRole('dialog', { name: 'New Post' });
  await ad.getByLabel('Post Title').fill('Crash on startup'); await ad.getByLabel('Message').fill('Stack trace attached.');
  await ad.getByRole('button', { name: /Bug/ }).click(); await ad.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(A.page.getByRole('heading', { name: 'Crash on startup', exact: true })).toBeVisible();
  // forum view
  await chan(B.page, 'help').click();
  await expect(card(B.page, 'Crash on startup').getByTestId('post-tags')).toContainText('Bug');
  await expect(card(B.page, 'How do I reset my password?').getByTestId('post-tags')).toContainText('Question');
  const filter = B.page.getByRole('group', { name: 'Filter by tag' });
  await filter.getByRole('button', { name: /Bug/ }).click();
  await expect(card(B.page, 'Crash on startup')).toBeVisible(); await expect(B.page.getByText('How do I reset my password?', { exact: true })).toHaveCount(0);
  await filter.getByRole('button', { name: /Question/ }).click();
  await expect(card(B.page, 'How do I reset my password?')).toBeVisible(); await expect(B.page.getByText('Crash on startup', { exact: true })).toHaveCount(0);
  await filter.getByRole('button', { name: 'All' }).click(); await expect(B.page.getByTestId('post-tags')).toHaveCount(2);
});

test('thread lifecycle: owner settings, moderator lock, archive/unarchive, delete', async () => {
  await B.page.getByText('How do I reset my password?', { exact: true }).click();
  const tid = B.page.url().split('/').pop()!;
  // Bob owns the thread: settings without the lock switch
  await B.page.getByRole('button', { name: 'Thread Settings' }).click();
  const dlg = B.page.getByRole('dialog', { name: 'Thread Settings' });
  await expect(dlg.getByRole('switch', { name: 'Lock thread' })).toHaveCount(0);
  await dlg.getByLabel('Thread Name').fill('Password reset help'); await dlg.getByLabel('Hide After Inactivity').selectOption({ label: '1 Week' });
  await dlg.getByRole('button', { name: /Bug/ }).isDisabled().then((d) => expect(d).toBe(true));
  await dlg.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(B.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.id === tid)).toMatchObject({ name: 'Password reset help', autoArchiveDuration: 10080 });
  await expect(B.page.getByRole('heading', { name: 'Password reset help', exact: true })).toBeVisible();
  // Alice locks it
  await A.page.goto(`/channels/${gid}/${tid}`);
  await A.page.getByRole('button', { name: 'Thread Settings' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('switch', { name: 'Lock thread' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('button', { name: 'Save Changes' }).click();
  await expect(B.page.getByTestId('thread-banner')).toContainText('This thread is locked');
  await expect(B.page.getByRole('textbox', { name: /^Message/ })).toBeEnabled();   // an open locked thread still takes messages
  await expect(B.page.getByRole('heading', { name: 'Password reset help', exact: true }).locator('..').getByLabel('Locked')).toBeVisible();
  await sendMessage(B.page, 'still talking');
  await expect(msg(A.page, 'still talking')).toBeVisible();
  // archive: Bob cannot unarchive a locked thread, Alice can
  await A.page.getByRole('button', { name: 'Thread Settings' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('button', { name: 'Archive Thread' }).click();
  await expect(B.page.getByTestId('thread-banner')).toContainText('archived and locked');
  await expect(B.page.getByRole('textbox', { name: 'This thread is archived and locked.' })).toBeDisabled();
  const blocked = await rest(B.page, 'POST', `/channels/${tid}/messages`, { content: 'let me in' }).catch((e: Error) => e.message);
  expect(String(blocked)).toContain('403');
  const reopen = await rest(B.page, 'PATCH', `/channels/${tid}`, { archived: false }).catch((e: Error) => e.message);
  expect(String(reopen)).toContain('403');
  await expect(B.page.getByTestId('thread-banner').getByRole('button', { name: 'Unarchive' })).toHaveCount(0);
  await expect(A.page.getByTestId('thread-banner').getByRole('button', { name: 'Unarchive' })).toBeVisible();
  await A.page.getByTestId('thread-banner').getByRole('button', { name: 'Unarchive' }).click();
  await expect(A.page.getByTestId('thread-banner')).toContainText('This thread is locked'); await expect(A.page.getByTestId('thread-banner').getByRole('button')).toHaveCount(0);
  // unlock, then Bob can talk again
  await A.page.getByRole('button', { name: 'Thread Settings' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('switch', { name: 'Lock thread' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('button', { name: 'Save Changes' }).click();
  await expect(B.page.getByTestId('thread-banner')).toHaveCount(0); await sendMessage(B.page, 'thanks, unlocked');
  await expect(msg(A.page, 'thanks, unlocked')).toBeVisible();
  // delete: gone from the forum list and Bob is moved out of it
  await A.page.getByRole('button', { name: 'Thread Settings' }).click();
  await A.page.getByRole('dialog', { name: 'Thread Settings' }).getByRole('button', { name: 'Delete Thread' }).click();
  await A.page.getByRole('dialog').getByRole('button', { name: 'Delete Thread' }).click();
  await expect(B.page).not.toHaveURL(new RegExp(tid));
  await chan(B.page, 'help').click(); await expect(B.page.getByText('Password reset help', { exact: true })).toHaveCount(0);
  const audit = (await rest(A.page, 'GET', `/guilds/${gid}/audit-logs?limit=100`)).map((e: any) => e.action);
  expect(audit).toEqual(expect.arrayContaining(['FORUM_TAG_UPDATE', 'THREAD_DELETE', 'THREAD_UPDATE']));
});

test('threads from a message: auto-archive choice in the create dialog', async () => {
  await chan(A.page, 'general').click(); await sendMessage(A.page, 'let us talk about lunch');
  const m = msg(A.page, 'let us talk about lunch'); await m.hover(); await m.getByRole('button', { name: 'More' }).click(); await clickMenu(A.page, 'Create Thread');
  const dlg = A.page.getByRole('dialog', { name: 'Create Thread' });
  await dlg.getByLabel('Thread Name').fill('Lunch'); await dlg.getByLabel('Hide After Inactivity').selectOption({ label: '1 Hour' });
  await dlg.getByRole('button', { name: 'Create Thread' }).click();
  await expect(A.page.getByRole('heading', { name: 'Lunch', exact: true })).toBeVisible();
  const th = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'Lunch');
  expect(th).toMatchObject({ type: 'thread', autoArchiveDuration: 60, locked: false });
});
