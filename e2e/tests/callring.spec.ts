import { test, expect } from '@playwright/test';
import { newUser, rest, type User } from './helpers';

let A: User, B: User, dm: { id: string };
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  const a = await rest<{ id: string }>(A.page, 'GET', '/users/@me'); const b = await rest<{ id: string }>(B.page, 'GET', '/users/@me');
  await rest(A.page, 'PUT', `/users/@me/relationships/${b.id}`, { type: 'friend' });
  await rest(B.page, 'PUT', `/users/@me/relationships/${a.id}`, { type: 'friend' });
  dm = await rest(A.page, 'POST', '/users/@me/channels', { recipientIds: [b.id] });
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

const openDm = async (u: User) => { await u.page.goto(`/channels/@me/${dm.id}`); await expect(u.page.getByRole('button', { name: 'Start Voice Call' })).toBeVisible({ timeout: 20_000 }); };
const hangUp = async (u: User) => { await u.page.getByRole('button', { name: 'Disconnect' }).first().click(); await expect(u.page.getByTestId('dm-call')).toHaveCount(0); };

test('calling a friend rings them; Decline stops the ring and leaves a missed-call line', async () => {
  await openDm(A); await openDm(B);
  await A.page.getByRole('button', { name: 'Start Voice Call' }).click();
  const modal = B.page.getByTestId('incoming-call');
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect(modal).toContainText('Incoming call');
  for (const n of ['Accept', 'Decline', 'Ignore']) await expect(modal.getByRole('button', { name: n })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Accept' })).toBeFocused();
  await modal.getByRole('button', { name: 'Decline' }).click();
  await expect(modal).toHaveCount(0);
  await hangUp(A);
  await expect(A.page.getByText('called, but no one picked up.')).toBeVisible({ timeout: 15_000 });
  await expect(B.page.getByText('called, but you missed it.')).toBeVisible({ timeout: 15_000 });
});

test('Ignore silences only this device; the caller hanging up cancels the ring everywhere', async () => {
  const B2 = await B.ctx.newPage(); await B2.goto('/channels/@me'); await expect(B2.getByRole('navigation', { name: 'Servers' })).toBeVisible({ timeout: 20_000 });
  await A.page.getByRole('button', { name: 'Start Voice Call' }).click();
  await expect(B.page.getByTestId('incoming-call')).toBeVisible({ timeout: 20_000 });
  await expect(B2.getByTestId('incoming-call')).toBeVisible({ timeout: 20_000 });
  await B.page.getByTestId('incoming-call').getByRole('button', { name: 'Ignore' }).click();
  await expect(B.page.getByTestId('incoming-call')).toHaveCount(0);
  await expect(B2.getByTestId('incoming-call')).toBeVisible(); // the other device keeps ringing
  await hangUp(A);
  await expect(B2.getByTestId('incoming-call')).toHaveCount(0, { timeout: 15_000 });
  await B2.close();
});

test('Accept joins the call; the other device stops ringing; no missed call is left', async () => {
  const B2 = await B.ctx.newPage(); await B2.goto('/channels/@me'); await expect(B2.getByRole('navigation', { name: 'Servers' })).toBeVisible({ timeout: 20_000 });
  const before = await A.page.getByText(/called, but/).count();
  await A.page.getByRole('button', { name: 'Start Voice Call' }).click();
  await expect(B2.getByTestId('incoming-call')).toBeVisible({ timeout: 20_000 });
  await expect(B.page.getByTestId('incoming-call')).toBeVisible();
  await B.page.getByTestId('incoming-call').getByRole('button', { name: 'Accept' }).click();
  await expect(B.page.getByTestId('voice-dock')).toContainText('Call Connected', { timeout: 30_000 });
  await expect(B2.getByTestId('incoming-call')).toHaveCount(0, { timeout: 15_000 });
  await expect(A.page.getByTestId('dm-call').getByTestId('voice-tile')).toHaveCount(2, { timeout: 20_000 });
  expect(await A.page.getByText(/called, but/).count()).toBe(before);
  await B2.close();
});
