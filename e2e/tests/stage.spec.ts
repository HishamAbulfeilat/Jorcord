import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, type User } from './helpers';

let A: User, B: User, gid: string;
test.describe.configure({ mode: 'serial' });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
const chan = (p: Page, name: string) => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name, exact: true });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Stage Guild');
  gid = await guildId(A.page);
  const inv = await makeInvite(A.page); await joinViaInvite(B.page, inv);
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Town Hall', type: 'stage' });
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Lounge', type: 'voice' });
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('stage: audience requests to speak, moderator invites, speaker is heard', async () => {
  await chan(A.page, 'Town Hall').click();
  await expect(A.page.getByTestId('stage')).toContainText('Speakers — 1');
  await chan(B.page, 'Town Hall').click();
  await expect(B.page.getByTestId('stage')).toContainText('Audience — 1');
  await expect(A.page.getByTestId('stage')).toContainText('Audience — 1');
  await B.page.getByRole('button', { name: 'Request to Speak' }).click();
  await expect(A.page.getByRole('region', { name: 'Requests to speak' })).toContainText('Bob');
  await A.page.getByRole('button', { name: 'Invite to Speak' }).click();
  await expect(B.page.getByTestId('stage')).toContainText('You are a speaker');
  await expect(A.page.getByTestId('stage')).toContainText('Speakers — 2');
  // Bob is now allowed to publish: Alice receives his microphone
  await expect.poll(async () => (await dbg<any[]>(A.page, 'remotes')).some((r) => r.audioSubscribed), { timeout: 30_000 }).toBe(true);
  const id = (await dbg<any[]>(A.page, 'remotes'))[0].identity;
  await expect.poll(async () => (await dbg<any>(A.page, 'audioStats', id))?.bytesReceived ?? 0, { timeout: 30_000 }).toBeGreaterThan(1000);
  // back to the audience
  await A.page.getByRole('button', { name: /Move Bob to Audience/ }).click();
  await expect(B.page.getByRole('button', { name: 'Request to Speak' })).toBeVisible();
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('voice moderation: server mute, move and disconnect via context menu', async () => {
  await chan(A.page, 'Lounge').click(); await chan(B.page, 'Lounge').click();
  const row = A.page.getByRole('list', { name: 'Voice participants' }).getByRole('listitem').filter({ hasText: 'Bob' });
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await A.page.getByRole('menuitem', { name: 'Server Mute' }).click();
  await expect(B.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted')).toHaveCount(1);
  await row.click({ button: 'right' });
  await A.page.getByRole('menuitem', { name: 'Move To' }).click();
  await A.page.getByRole('menuitem', { name: 'Town Hall' }).click();
  await expect(B.page.getByTestId('voice-dock')).toContainText('Town Hall', { timeout: 20_000 });
  const row2 = A.page.getByRole('list', { name: 'Voice participants' }).getByRole('listitem').filter({ hasText: 'Bob' });
  await row2.click({ button: 'right' });
  await A.page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(B.page.getByTestId('voice-dock')).toHaveCount(0, { timeout: 20_000 });
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});
