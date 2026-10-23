import { test, expect } from '@playwright/test';
import { newUser, createServer, guildId, rest, type User } from './helpers';

let A: User, gid: string, clipsId: string;
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice');
  await createServer(A.page, 'Clip Guild');
  gid = await guildId(A.page);
  const ch = await rest<{ id: string }>(A.page, 'POST', `/guilds/${gid}/channels`, { type: 'text', name: 'clips', isClipsChannel: true });
  clipsId = ch.id;
  await A.page.reload();
});
test.afterAll(async () => { await A?.ctx.close(); });

test('record the last 30 s of my camera, preview it, share it to the clips channel and watch it in the viewer', async () => {
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(A.page.getByTestId('voice-dock')).toContainText('Voice Connected', { timeout: 30_000 });
  await expect(A.page.getByTestId('clip-button')).toHaveCount(0); // nothing to record yet
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await A.page.getByTestId('clip-button').click();
  const pop = A.page.getByTestId('clip-popover');
  await expect(pop.getByRole('radio', { name: '30 s' })).toBeChecked();
  await pop.getByRole('button', { name: 'Start recording buffer' }).click();
  await expect(pop.getByTestId('clip-status')).toContainText('Recording');
  await expect(pop.getByRole('button', { name: 'Save clip' })).toBeDisabled(); // < 2 s recorded
  await expect(pop.getByRole('button', { name: 'Save clip' })).toBeEnabled({ timeout: 15_000 });
  await A.page.waitForTimeout(2500);
  await pop.getByRole('button', { name: 'Save clip' }).click();

  const dlg = A.page.getByRole('dialog').filter({ hasText: 'Your clip' });
  await expect(dlg).toBeVisible();
  const video = dlg.getByTestId('clip-preview');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect(dlg.getByTestId('clip-meta')).toContainText(/\d+ s/);
  const [dl] = await Promise.all([A.page.waitForEvent('download'), dlg.getByRole('link', { name: 'Download' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^clip-.*\.webm$/);

  await dlg.getByLabel('Caption (optional)').fill('my first clip');
  await expect(dlg.getByLabel('Clips channel')).toContainText('#clips');
  await dlg.getByRole('button', { name: 'Share to clips channel' }).click();
  await expect(dlg).toHaveCount(0, { timeout: 30_000 });

  const list = await rest<any[]>(A.page, 'GET', `/channels/${clipsId}/clips`);
  expect(list).toHaveLength(1); expect(list[0].durationSeconds).toBeGreaterThanOrEqual(2); expect(list[0].durationSeconds).toBeLessThanOrEqual(30); expect(list[0].content).toBe('my first clip');

  // viewer (header button of a clips channel)
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /clips/ }).first().click();
  // wait for the route to land: until then the voice view's own "Clips" (recorder) button is the only match
  await expect(A.page.getByRole('heading', { level: 1, name: 'clips', exact: true })).toBeVisible();
  await A.page.getByRole('button', { name: 'Clips', exact: true }).first().click();
  const card = A.page.getByTestId('clip-card');
  await expect(card).toHaveCount(1);
  await expect.poll(() => card.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
});

test('the 1 and 2 minute windows can be shared too (API cap 120 s); stopping the buffer frees it', async () => {
  await A.page.keyboard.press('Escape');
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await A.page.getByTestId('clip-button').click();
  const pop = A.page.getByTestId('clip-popover');
  await pop.getByRole('button', { name: 'Stop' }).click();
  await pop.getByRole('radio', { name: '1 min' }).check({ force: true });
  await expect(pop).not.toContainText('limited to'); // the server cap is 120 s: no sharing limit note for the 1 minute window
  await pop.getByRole('button', { name: 'Start recording buffer' }).click();
  await expect(pop.getByRole('button', { name: 'Save clip' })).toBeEnabled({ timeout: 15_000 });
  await A.page.waitForTimeout(2500);
  await pop.getByRole('button', { name: 'Save clip' }).click();
  const dlg = A.page.getByRole('dialog').filter({ hasText: 'Your clip' });
  await expect(dlg.getByTestId('clip-preview')).toBeVisible();
  // shared from the 1 minute window; the guard for clips above the cap is unit-tested
  await expect(dlg.getByRole('button', { name: 'Share to clips channel' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Share to clips channel' }).click();
  await expect.poll(async () => (await rest<any[]>(A.page, 'GET', `/channels/${clipsId}/clips`)).length).toBe(2);
  expect((await rest<{ maxSeconds: number }>(A.page, 'GET', '/clips/limits')).maxSeconds).toBe(120);
  await A.page.getByTestId('clip-button').click();
  await A.page.getByTestId('clip-popover').getByRole('button', { name: 'Stop' }).click();
  await expect(A.page.getByTestId('clip-popover').getByRole('button', { name: 'Start recording buffer' })).toBeVisible();
});
