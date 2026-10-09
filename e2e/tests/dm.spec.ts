import { test, expect, type Page } from '@playwright/test';
import { newUser, sendMessage, msg, type User } from './helpers';

let A: User, B: User;
test.describe.configure({ mode: 'serial' });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;

test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); });
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('friend request: send, receive, accept', async () => {
  await A.page.getByRole('tab', { name: 'Add Friend' }).click();
  await A.page.getByLabel('Username').fill(B.username);
  await A.page.getByRole('button', { name: 'Send Friend Request' }).click();
  await expect(A.page.getByText(/Success! Your friend request/)).toBeVisible();

  // B sees the pending request (badge on the Pending tab / mobile + DM sidebar) and accepts it
  await B.page.getByRole('tab', { name: /^Pending/ }).click();
  await expect(B.page.getByText('Incoming Friend Request')).toBeVisible();
  await B.page.getByRole('button', { name: 'Accept' }).click();
  await A.page.getByRole('tab', { name: 'All', exact: true }).click();
  await expect(A.page.locator('#main li').filter({ hasText: 'Bob' })).toBeVisible();
  await B.page.getByRole('tab', { name: 'All', exact: true }).click();
  await expect(B.page.locator('#main li').filter({ hasText: 'Alice' })).toBeVisible();
});

test('DM: open from friends list, exchange messages, unread badge', async () => {
  await A.page.getByRole('button', { name: 'Message', exact: true }).first().click();
  await expect(A.page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
  await sendMessage(A.page, 'psst, a DM');
  // B is on the friends page: DM appears in the sidebar with a mention badge
  const dmRow = B.page.getByRole('button', { name: 'Alice' }).first();
  await expect(dmRow).toBeVisible();
  await expect(B.page.getByLabel(/1 mentions/).first()).toBeVisible();
  await dmRow.click();
  await expect(msg(B.page, 'psst, a DM')).toBeVisible();
  await sendMessage(B.page, 'got it');
  await expect(msg(A.page, 'got it')).toBeVisible();
  await expect(B.page.getByLabel(/mentions/)).toHaveCount(0);
});

test('DM call: ring banner, join, hear each other, leave', async () => {
  await A.page.getByRole('button', { name: 'Start Voice Call' }).click();
  await expect(A.page.getByTestId('dm-call')).toBeVisible();
  await expect(B.page.getByTestId('dm-call-banner')).toContainText('in a call');
  await B.page.getByRole('button', { name: 'Join Call' }).click();
  await expect(B.page.getByTestId('dm-call')).toBeVisible();
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  for (const u of [A, B]) {
    await expect.poll(async () => (await dbg<any[]>(u.page, 'remotes')).some((r) => r.audioSubscribed), { timeout: 20_000 }).toBe(true);
    const id = (await dbg<any[]>(u.page, 'remotes'))[0].identity;
    await expect.poll(async () => (await dbg<any>(u.page, 'audioStats', id))?.bytesReceived ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000);
  }
  // video call upgrade: B turns camera on, A receives a decoded video track
  await B.page.getByTestId('dm-call').getByRole('button', { name: 'Turn On Camera' }).click();
  await expect.poll(async () => (await dbg<any[]>(A.page, 'remotes'))[0]?.cameraSubscribed, { timeout: 20_000 }).toBe(true);
  await B.page.getByTestId('dm-call').getByRole('button', { name: 'Disconnect' }).click();
  await A.page.getByTestId('dm-call').getByRole('button', { name: 'Disconnect' }).click();
  await expect(A.page.getByTestId('dm-call')).toHaveCount(0);
});
