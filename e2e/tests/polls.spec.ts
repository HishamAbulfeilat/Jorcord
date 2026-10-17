import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, msg, clickMenu, type User } from './helpers';

let A: User, B: User, gid: string, general: string;
test.describe.configure({ mode: 'serial' });
const poll = (p: Page, q: string) => p.getByTestId('poll').filter({ hasText: q });
const counts = (p: Page, q: string) => poll(p, q).getByTestId('answer-count');
const channelId = async (p: Page, name: string) => (await rest(p, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === name).id as string;

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Poll HQ'); gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
  general = await channelId(A.page, 'general');
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('create a poll from the + menu: validation, multiple answers, duration', async () => {
  const p = A.page;
  await p.getByRole('button', { name: 'Attach' }).click(); await clickMenu(p, 'Create Poll');
  const dlg = p.getByRole('dialog', { name: 'Create Poll' });
  await dlg.getByRole('button', { name: 'Post' }).click(); await expect(dlg).toContainText('Ask a question');
  await dlg.getByLabel('Question').fill('Where do we eat?');
  await dlg.getByLabel('Answer 1', { exact: true }).fill('Pizza'); await dlg.getByRole('button', { name: 'Post' }).click(); await expect(dlg).toContainText('Add at least two answers');
  await dlg.getByLabel('Answer 2', { exact: true }).fill('Sushi');
  await dlg.getByRole('button', { name: 'Add another answer' }).click(); await dlg.getByLabel('Answer 3', { exact: true }).fill('Tacos');
  await dlg.getByRole('button', { name: 'Remove answer 3' }).click(); await expect(dlg.getByLabel('Answer 3', { exact: true })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Add another answer' }).click(); await dlg.getByLabel('Answer 3', { exact: true }).fill('Tacos');
  await dlg.getByLabel('Duration').selectOption({ label: '1 hour' });
  await dlg.getByRole('switch', { name: 'Allow multiple answers' }).click();
  await dlg.getByRole('button', { name: 'Post' }).click();
  await expect(dlg).toHaveCount(0);
  for (const u of [A, B]) {
    const c = poll(u.page, 'Where do we eat?'); await expect(c).toBeVisible();
    await expect(c).toContainText('Select one or more answers'); await expect(c.getByRole('checkbox')).toHaveCount(3);
    await expect(c.getByTestId('poll-status')).toHaveText(/Ends in (59|60) minutes|Ends in 1 hour/);
    await expect(counts(u.page, 'Where do we eat?')).toHaveText(['0 · 0%', '0 · 0%', '0 · 0%']);
  }
  const m = await rest(A.page, 'GET', `/channels/${general}/messages?limit=5`);
  const pm = m.find((x: any) => x.poll); expect(pm.poll).toMatchObject({ question: 'Where do we eat?', allowMultiselect: true });
  expect(Date.parse(pm.poll.expiry) - Date.now()).toBeGreaterThan(55 * 60_000); expect(Date.parse(pm.poll.expiry) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
});

test('voting: Bob picks two answers, everyone sees the counts live; voters list; remove vote', async () => {
  const q = 'Where do we eat?';
  await poll(B.page, q).getByRole('checkbox', { name: /Pizza/ }).click(); await poll(B.page, q).getByRole('checkbox', { name: /Tacos/ }).click();
  await poll(B.page, q).getByRole('button', { name: 'Vote', exact: true }).click();
  await expect(counts(B.page, q)).toHaveText(['1 · 100%', '0 · 0%', '1 · 100%']);
  await expect(counts(A.page, q)).toHaveText(['1 · 100%', '0 · 0%', '1 · 100%']);   // live via MESSAGE_POLL_VOTE_ADD
  await expect(poll(A.page, q)).toContainText('1 vote');
  await expect(poll(B.page, q).getByRole('checkbox', { name: /Pizza/ })).toHaveAttribute('aria-checked', 'true');
  await expect(poll(A.page, q).getByRole('checkbox', { name: /Pizza/ })).toHaveAttribute('aria-checked', 'false'); // my own marks stay mine
  // Alice also votes
  await poll(A.page, q).getByRole('checkbox', { name: /Pizza/ }).click(); await poll(A.page, q).getByRole('button', { name: 'Vote', exact: true }).click();
  await expect(counts(B.page, q)).toHaveText(['2 · 100%', '0 · 0%', '1 · 50%']);
  // voters
  await poll(A.page, q).getByRole('button', { name: 'View votes' }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Votes' });
  await expect(dlg.getByTestId('voters')).toContainText('Alice'); await expect(dlg.getByTestId('voters')).toContainText('Bob');
  await dlg.getByRole('tab', { name: /Tacos/ }).click(); await expect(dlg.getByTestId('voters')).toContainText('Bob'); await expect(dlg.getByTestId('voters')).not.toContainText('Alice');
  await dlg.getByRole('tab', { name: /Sushi/ }).click(); await expect(dlg).toContainText('No votes yet');
  await A.page.keyboard.press('Escape');
  // Bob removes his vote
  await poll(B.page, q).getByRole('button', { name: 'Remove vote' }).click();
  await expect(counts(A.page, q)).toHaveText(['1 · 100%', '0 · 0%', '0 · 0%']);
  await expect(poll(B.page, q).getByRole('button', { name: 'Remove vote' })).toHaveCount(0);
});

test('single-choice poll: picking another answer replaces the first; the vote survives a reload', async () => {
  const m = await rest(A.page, 'POST', `/channels/${general}/messages`, { content: '', poll: { question: 'Best colour?', answers: [{ text: 'Red' }, { text: 'Blue' }], durationHours: 24 } });
  const q = 'Best colour?';
  await expect(poll(B.page, q)).toContainText('Select one answer');
  await expect(poll(B.page, q).getByRole('radio')).toHaveCount(2);
  await poll(B.page, q).getByRole('radio', { name: /Red/ }).click(); await poll(B.page, q).getByRole('radio', { name: /Blue/ }).click();
  await expect(poll(B.page, q).getByRole('radio', { name: /Red/ })).toHaveAttribute('aria-checked', 'false');
  await poll(B.page, q).getByRole('button', { name: 'Vote', exact: true }).click();
  await expect(counts(A.page, q)).toHaveText(['0 · 0%', '1 · 100%']);
  await B.page.reload();
  await expect(poll(B.page, q).getByRole('radio', { name: /Blue/ })).toHaveAttribute('aria-checked', 'true');
  expect(m.poll.answers).toHaveLength(2);
});

test('end a poll early: closed for everyone, results message posted, voting refused by the server', async () => {
  const q = 'Where do we eat?';
  await expect(poll(B.page, q).getByRole('button', { name: 'End poll' })).toHaveCount(0); // not the author, no Manage Messages
  await poll(A.page, q).getByRole('button', { name: 'End poll' }).click();
  await A.page.getByRole('dialog').getByRole('button', { name: 'End poll' }).click();
  for (const u of [A, B]) {
    await expect(poll(u.page, q).getByTestId('poll-status')).toHaveText('Poll closed');
    await expect(poll(u.page, q).getByRole('button', { name: 'Vote', exact: true })).toHaveCount(0);
    await expect(poll(u.page, q)).toContainText('Final results');
    await expect(u.page.getByTestId('poll-result').filter({ hasText: 'Where do we eat?' })).toContainText('Pizza won with 1 vote');
  }
  const pm = (await rest(A.page, 'GET', `/channels/${general}/messages?limit=20`)).find((x: any) => x.poll?.question === q);
  const err = await rest(B.page, 'PUT', `/channels/${general}/polls/${pm.id}/votes`, { answerIds: [2] }).catch((e: Error) => e.message);
  expect(String(err)).toContain('400'); expect(String(err)).toContain('520000');
  // the voters list of a finished poll still works
  await poll(B.page, q).getByRole('button', { name: 'View votes' }).click();
  await expect(B.page.getByRole('dialog', { name: 'Votes' }).getByTestId('voters')).toContainText('Alice');
  await B.page.keyboard.press('Escape');
});

test('SEND_POLLS: members without it do not get "Create Poll"; moderators with Manage Messages can end others\' polls', async () => {
  const quiet = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'no-polls', type: 'text' });
  await rest(A.page, 'PUT', `/channels/${quiet.id}/permissions/${gid}`, { type: 'role', allow: '0', deny: (1n << 41n).toString() });
  await B.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'no-polls' }).click();
  await B.page.getByRole('button', { name: 'Attach' }).click();
  await expect(B.page.getByRole('menuitem', { name: 'Upload a File' })).toBeVisible(); await expect(B.page.getByRole('menuitem', { name: 'Create Poll' })).toHaveCount(0);
  await B.page.keyboard.press('Escape');
  const err = await rest(B.page, 'POST', `/channels/${quiet.id}/messages`, { content: '', poll: { question: 'sneaky', answers: [{ text: 'a' }, { text: 'b' }] } }).catch((e: Error) => e.message);
  expect(String(err)).toContain('403');
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'no-polls' }).click();
  await A.page.getByRole('button', { name: 'Attach' }).click(); await expect(A.page.getByRole('menuitem', { name: 'Create Poll' })).toBeVisible(); await A.page.keyboard.press('Escape');
  // Bob posts a poll in general, Alice (owner, so Manage Messages) ends it
  await B.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click();
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click();
  await rest(B.page, 'POST', `/channels/${general}/messages`, { content: '', poll: { question: 'Bob asks', answers: [{ text: 'yes' }, { text: 'no' }] } });
  await expect(poll(A.page, 'Bob asks').getByRole('button', { name: 'End poll' })).toBeVisible();
  await poll(A.page, 'Bob asks').getByRole('button', { name: 'End poll' }).click(); await A.page.getByRole('dialog').getByRole('button', { name: 'End poll' }).click();
  await expect(poll(B.page, 'Bob asks').getByTestId('poll-status')).toHaveText('Poll closed');
  // the audit log has it
  const logs = await rest(A.page, 'GET', `/guilds/${gid}/audit-logs?actionType=310`);
  expect(logs.length).toBeGreaterThanOrEqual(1); expect(logs[0].action).toBe('POLL_END');
  void msg;
});
