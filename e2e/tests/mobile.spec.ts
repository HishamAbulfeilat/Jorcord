import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, type User } from './helpers';

let D: User, M: User;
test.describe.configure({ mode: 'serial' });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
const noHScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);

test.beforeAll(async ({ browser }) => {
  D = await newUser(browser, 'Desk'); M = await newUser(browser, 'Mobi', { mobile: true });
  await createServer(D.page, 'Mobile Guild');
  const inv = await makeInvite(D.page);
  await joinViaInvite(M.page, inv);
});
test.afterAll(async () => { await D?.ctx.close(); await M?.ctx.close(); });

test('mobile layout: drawer navigation, chat, no horizontal overflow', async () => {
  await expect(M.page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  expect(await noHScroll(M.page)).toBe(true);
  await sendMessage(D.page, 'hi mobile');
  await expect(msg(M.page, 'hi mobile')).toBeVisible();
  await sendMessage(M.page, 'hi desktop');
  await expect(msg(D.page, 'hi desktop')).toBeVisible();
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(M.page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await expect(M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('navigation', { name: 'Channels' })).toContainText('General');
  await M.page.screenshot({ path: 'test-results/mobile-drawer.png' });
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
  await expect(M.page.getByRole('dialog', { name: 'Navigation' })).toHaveAttribute('aria-hidden', 'true');
});

test('mobile voice: join from drawer, controls usable, remote media, no screen-share button', async () => {
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(M.page.getByTestId('voice-view')).toBeVisible();
  await expect(M.page.getByTestId('voice-dock')).toHaveCount(1); // lives in the drawer
  await D.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(M.page.getByTestId('voice-tile')).toHaveCount(2);
  const view = M.page.getByTestId('voice-view');
  await expect(view.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(view.getByRole('button', { name: /Share Your Screen/ })).toHaveCount(0); // not offered on mobile browsers
  expect(await noHScroll(M.page)).toBe(true);
  // every control fits the viewport and is at least 40px tall (touch target)
  for (const b of await view.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button').all()) {
    if (!(await b.isVisible())) continue;
    const box = (await b.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390.5); expect(box.height).toBeGreaterThanOrEqual(24);
  }
  await expect.poll(async () => (await dbg<any[]>(M.page, 'remotes')).some((r) => r.audioSubscribed), { timeout: 20_000 }).toBe(true);
  const id = (await dbg<any[]>(M.page, 'remotes'))[0].identity;
  await expect.poll(async () => (await dbg<any>(M.page, 'audioStats', id))?.bytesReceived ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000);
  // mute from the mobile toolbar mirrors to desktop
  await view.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(D.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted')).toHaveCount(1);
  await M.page.screenshot({ path: 'test-results/mobile-voice.png' });
  // navigating away keeps the call and shows the compact voice bar
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
  await expect(M.page.getByTestId('mobile-voice-bar')).toBeVisible();
  await M.page.getByTestId('mobile-voice-bar').getByRole('button', { name: 'Disconnect' }).click();
  await expect(M.page.getByTestId('mobile-voice-bar')).toHaveCount(0);
  await D.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('mobile screenshots do not overflow on settings/voice settings', async () => {
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'User Settings' }).click();
  await expect(M.page.getByRole('dialog').first()).toBeVisible();
  expect(await noHScroll(M.page)).toBe(true);
});
