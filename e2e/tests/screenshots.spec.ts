/**
 * Captures desktop + mobile screenshots of the REAL running app (real server, real LiveKit, fake media devices).
 * Output: e2e/screenshots/*.png  (run alone: pnpm e2e -- screenshots)
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, rest, guildId, PNG, type User } from './helpers';

const OUT = fileURLToPath(new URL('../screenshots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png` });
const voiceBtn = (p: Page, name = 'General') => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name, exact: true });

let A: User, B: User, M: User, gid: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); M = await newUser(browser, 'Mia', { mobile: true });
  await createServer(A.page, 'Jorcord HQ');
  gid = await guildId(A.page);
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv); await joinViaInvite(M.page, inv);
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Town Hall', type: 'stage' });
});
test.afterAll(async () => { for (const u of [A, B, M]) await u?.ctx.close(); });

test('chat screenshots', async () => {
  await voiceBtn(A.page, 'general').click(); await voiceBtn(B.page, 'general').click();
  await sendMessage(A.page, 'Welcome to **Jorcord HQ**! Try `code`, ~~strike~~ and ||spoilers||.');
  await sendMessage(B.page, 'Looks great :tada: any plans for the stream tonight?');
  await A.page.locator('input[type=file]').first().setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  const box = A.page.getByRole('textbox', { name: /^Message/ }); await box.fill('here is a picture'); await box.press('Enter');
  await expect(msg(B.page, 'here is a picture')).toBeVisible();
  const m = msg(A.page, 'Looks great'); await m.hover(); await m.getByRole('button', { name: 'Add Reaction' }).click();
  await A.page.getByRole('dialog', { name: 'Emoji picker' }).getByRole('gridcell').nth(2).click();
  await A.page.mouse.move(700, 700);
  await shot(A.page, 'desktop-chat');
  await expect(M.page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await shot(M.page, 'mobile-chat');
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.waitForTimeout(400);
  await shot(M.page, 'mobile-drawer');
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
});

test('voice screenshots', async () => {
  await voiceBtn(A.page).click();
  await shot(A.page, 'desktop-voice-connected-alone');
  await voiceBtn(B.page).click();
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  await B.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await A.page.waitForTimeout(2500);
  await shot(A.page, 'desktop-voice-camera-grid');
  // mobile joins too
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await voiceBtn(M.page).click();
  await expect(M.page.getByTestId('voice-tile')).toHaveCount(3);
  await M.page.waitForTimeout(2500);
  await shot(M.page, 'mobile-voice-call');
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Voice Settings' }).click();
  await A.page.waitForTimeout(500);
  await shot(A.page, 'desktop-voice-settings');
  await A.page.keyboard.press('Escape');
  // screen share with quality picker
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stream quality options' }).click();
  await A.page.getByRole('radio', { name: '1440p 60fps' }).check();
  await shot(A.page, 'desktop-share-picker');
  await A.page.getByRole('button', { name: 'Go Live' }).click();
  await expect(B.page.getByTestId('screen-tile')).toBeVisible();
  await B.page.getByLabel('Viewing quality').selectOption('high');
  await B.page.waitForTimeout(3000);
  await B.page.getByTestId('screen-tile').hover();
  await B.page.getByRole('button', { name: 'Stream stats' }).click();
  await B.page.waitForTimeout(1500);
  await shot(B.page, 'desktop-screenshare-spotlight-stats');
  await shot(M.page, 'mobile-voice-with-stream');
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stop Streaming' }).click();
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.waitForTimeout(400);
  await shot(M.page, 'mobile-drawer-voice-dock');
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Disconnect' }).first().click();
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('stage screenshots', async () => {
  await voiceBtn(A.page, 'Town Hall').click();
  await expect(A.page.getByTestId('stage')).toBeVisible();
  await voiceBtn(B.page, 'Town Hall').click();
  await expect(B.page.getByTestId('stage')).toBeVisible();
  await expect(A.page.getByTestId('stage')).toContainText('Audience');
  await B.page.waitForTimeout(800);
  await shot(A.page, 'desktop-stage'); await shot(B.page, 'desktop-stage-audience');
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('misc screenshots', async () => {
  await A.page.getByRole('button', { name: 'User Settings' }).click();
  await A.page.getByRole('tab', { name: 'Voice & Video' }).or(A.page.getByRole('button', { name: 'Voice & Video' })).first().click();
  await A.page.waitForTimeout(400);
  await shot(A.page, 'desktop-settings-voice');
  await A.page.keyboard.press('Escape');
  await A.page.getByRole('button', { name: 'Direct Messages' }).click();
  await shot(A.page, 'desktop-friends');
  await shot(M.page, 'mobile-friends');
});
