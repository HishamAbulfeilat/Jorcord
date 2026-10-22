import { test, expect } from '@playwright/test';
import { newUser, openUserSettings, token } from './helpers';

test('data export: request a zip in My Account, download it, then delete the account', async ({ browser }) => {
  const u = await newUser(browser, 'Exp');
  await openUserSettings(u.page, /My Account/);
  await u.page.getByRole('button', { name: 'Request data export' }).click();
  const status = u.page.getByTestId('export-status');
  await expect(status.getByRole('link', { name: 'Download' })).toBeVisible({ timeout: 30_000 });
  const href = await status.getByRole('link', { name: 'Download' }).getAttribute('href');
  const res = await u.page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/zip');
  expect((await res.body()).subarray(0, 2).toString()).toBe('PK');
  await expect(u.page.getByRole('button', { name: 'Request data export' })).toBeEnabled();
  expect(await u.page.evaluate(async (t) => (await fetch('/api/v1/users/@me/exports', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' })).status, await token(u.page))).toBe(429);

  // delete the account (password confirmation) and land on the login page
  await u.page.getByRole('button', { name: 'Delete account' }).click();
  await u.page.getByLabel('Password to delete account').fill('correct-horse-battery');
  await u.page.getByRole('button', { name: 'Delete my account' }).click();
  await u.page.waitForURL(/\/login/);
  await u.ctx.close();
});
