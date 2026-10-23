import { test, expect } from '@playwright/test';
import { clickMenu, newUser, createServer, makeInvite, rest, injectNative, openUserSettings, closeSettings } from './helpers';

const SERVER = 'http://127.0.0.1:3100';
test('Capacitor wrapper: connect screen, cross-origin API/WS, deep link, back button, push, no screen share', async ({ browser }) => {
  const host = await newUser(browser, 'Hosty'); await createServer(host.page, 'Native HQ'); const invite = await makeInvite(host.page);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: 'http://127.0.0.1:5273', serviceWorkers: 'block', permissions: ['microphone', 'camera'], userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' });
  await injectNative(ctx, 'android', { screenShare: 'unsupported' });
  const page = await ctx.newPage(); const hits: string[] = []; page.on('request', (r) => hits.push(r.url()));
  await page.goto('/');
  await expect(page).toHaveURL(/\/connect/); await expect(page.getByTestId('server-setup')).toBeVisible();
  await page.getByLabel('Server address').fill('127.0.0.1:9'); await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText(/reach/i);
  await page.getByLabel('Server address').fill(SERVER); await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page).toHaveURL(/\/login/); await expect(page.getByTestId('server-line')).toContainText('127.0.0.1:3100');
  await page.getByRole('link', { name: 'Register' }).click();
  const u = 'nat' + Math.random().toString(36).slice(2, 8);
  await page.getByLabel('Email').fill(`${u}@example.test`); await page.getByLabel('Username').fill(u); await page.getByLabel('Password').fill('correct-horse-battery'); await page.getByLabel(/I agree/).check();
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByRole('tablist', { name: 'Main navigation' }).or(page.getByRole('navigation', { name: 'Servers' })).first()).toBeVisible();
  expect(hits.some((h) => h.startsWith(SERVER + '/api/v1/auth/register'))).toBe(true);
  expect(hits.some((h) => /127\.0\.0\.1:5273\/api\//.test(h))).toBe(false);
  expect(await page.evaluate(() => document.querySelector('meta[name=viewport]')!.getAttribute('content'))).toContain('viewport-fit=cover');
  // deep link -> invite page of that server, accept
  await page.evaluate((url) => (window as any).__listeners['App:appUrlOpen']({ url }), `jorcord://invite/${invite.split('/').pop()}`);
  await expect(page).toHaveURL(/\/invite\//); await expect(page.getByRole('heading', { name: 'Native HQ' })).toBeVisible();
  await page.getByRole('button', { name: /Accept Invite/ }).click(); await page.waitForURL(/\/channels\/\d+/);
  // cross-origin chat works (REST + gateway)
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
  const box = page.getByRole('textbox', { name: /^Message/ }); await box.fill('hello cross origin'); await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[id^="msg-"]').filter({ hasText: 'hello cross origin' })).toBeVisible();
  await expect(host.page.locator('[id^="msg-"]').filter({ hasText: 'hello cross origin' })).toBeVisible();
  // hardware back closes settings before anything else
  await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('tab', { name: /^You$|./ }).last().click();
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
  await page.evaluate(() => (window as any).__listeners['App:backButton']({ canGoBack: false }));
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toHaveCount(0);
  // native push registration
  await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('tab', { name: /^You$|./ }).last().click();
  await page.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('switch', { name: 'Push on this device' }).click();
  await expect.poll(async () => (await page.evaluate(async (s) => { const t = JSON.parse(localStorage.getItem('jorcord.auth.v1')!).access; const r = await fetch(s + '/api/v1/users/@me/push-devices', { headers: { authorization: 'Bearer ' + t } }); return (await r.json()).map((d: any) => d.platform); }, SERVER))).toEqual(['android']);
  await page.getByRole('switch', { name: 'Push on this device' }).click();
  await closeSettings(page).catch(() => {});
  await ctx.close(); await host.ctx.close();
});

for (const mode of ['unsupported', 'supported'] as const) test(`Capacitor: screen share is ${mode === 'supported' ? 'offered' : 'hidden'} in a voice channel when the native plugin reports ${mode}`, async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: 'http://127.0.0.1:5273', serviceWorkers: 'block', permissions: ['microphone', 'camera'] });
  await injectNative(ctx, 'ios', { screenShare: mode });
  const page = await ctx.newPage(); await page.addInitScript((s) => localStorage.setItem('jorcord.server.v1', s), SERVER);
  await page.goto('/register');
  const u = 'ios' + mode.slice(0, 3) + Math.random().toString(36).slice(2, 8);
  await page.getByLabel('Email').fill(`${u}@example.test`); await page.getByLabel('Username').fill(u); await page.getByLabel('Password').fill('correct-horse-battery'); await page.getByLabel(/I agree/).check();
  await page.getByRole('button', { name: /continue/i }).click(); await page.waitForURL(/\/channels\/@me/);
  const t = await page.evaluate(() => JSON.parse(localStorage.getItem('jorcord.auth.v1')!).access);
  const r = await page.request.post(SERVER + '/api/v1/guilds', { data: { name: 'Voice HQ' }, headers: { authorization: 'Bearer ' + t } }); expect(r.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole('tab', { name: 'Home' }).click(); await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Voice HQ' }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Share Your Screen/ })).toHaveCount(mode === 'supported' ? 1 : 0);
  await ctx.close();
});

test('Tauri wrapper: cold-start deep link survives the connect screen; desktop settings', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: 'http://127.0.0.1:5273', serviceWorkers: 'block' });
  await injectNative(ctx, 'tauri', { deepLinks: ['jorcord://invite/abcd1234'] });
  const page = await ctx.newPage(); await page.goto('/');
  await expect(page).toHaveURL(/\/connect\?next=%2Finvite%2Fabcd1234/);
  await page.getByLabel('Server address').fill(SERVER); await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page).toHaveURL(/\/invite\/abcd1234/);
  await page.evaluate(() => (window as any).__listeners['tauri:jorcord://open']({ payload: 'jorcord://open?server=http://127.0.0.1:3100' }));
  await expect(page).toHaveURL(/\/channels\/@me|\/login/);
  await ctx.close();
});
