import { test, expect } from '@playwright/test';
import { newUser, openUserSettings, closeSettings } from './helpers';

// Chromium's CDP virtual authenticator stands in for a platform passkey (resident key, user verification on).
// WebAuthn needs a real domain as RP ID, so this spec runs on http://localhost:5273 (the e2e server is started with WEBAUTHN_RP_ID=localhost).
test('passkeys: add in settings, sign in passwordless, rename, remove', async ({ browser }) => {
  const u = await newUser(browser, 'Pk', { baseURL: 'http://localhost:5273' });
  const cdp = await u.ctx.newCDPSession(u.page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  await openUserSettings(u.page, /Security/);
  await u.page.getByRole('button', { name: 'Add a passkey' }).click();
  await u.page.getByLabel('Passkey name').fill('E2E key');
  await u.page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await u.page.getByRole('button', { name: 'Continue' }).click();
  await expect(u.page.getByTestId('passkey-list').getByText('E2E key')).toBeVisible();

  // rename
  await u.page.getByRole('button', { name: 'Rename E2E key' }).click();
  await u.page.getByLabel('Passkey name').fill('Renamed key');
  await u.page.keyboard.press('Enter');
  await expect(u.page.getByTestId('passkey-list').getByText('Renamed key')).toBeVisible();
  await closeSettings(u.page);

  // sign out (drop the session locally) and sign back in with only the passkey
  await u.page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await u.page.goto('/login');
  await u.page.getByTestId('passkey-login').click();
  await u.page.waitForURL(/\/channels\/@me/);
  await expect(u.page.getByRole('navigation', { name: 'Servers' })).toBeVisible();

  // remove it again (needs the password)
  await openUserSettings(u.page, /Security/);
  await u.page.getByRole('button', { name: 'Remove Renamed key' }).click();
  await u.page.getByLabel('Password', { exact: true }).fill('wrong-password-1');
  await u.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(u.page.getByTestId('passkey-list').getByText('Renamed key')).toBeVisible();
  await u.page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await u.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(u.page.getByText('No passkeys yet.')).toBeVisible();
  await u.ctx.close();
});
