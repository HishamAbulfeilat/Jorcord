import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, type User } from './helpers';

const voiceChannel = (p: Page) => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;

let A: User, B: User;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Voice Guild');
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv);
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('both users join a voice channel and hear each other', async () => {
  await voiceChannel(A.page).click();
  await expect(A.page.getByTestId('voice-view')).toBeVisible();
  await expect(A.page.getByTestId('voice-dock')).toContainText('Voice Connected');
  await voiceChannel(B.page).click();
  await expect(B.page.getByTestId('voice-dock')).toContainText('Voice Connected');

  // gateway state mirrored: each sees both in the sidebar list
  for (const u of [A, B]) await expect(u.page.getByRole('list', { name: 'Voice participants' }).getByRole('listitem')).toHaveCount(2);
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);

  // remote audio track subscribed + RTP bytes flowing on both sides
  for (const [me, other] of [[A, B], [B, A]] as const) {
    await expect.poll(async () => (await dbg<any[]>(me.page, 'remotes')).some((r) => r.audioSubscribed), { timeout: 20_000 }).toBe(true);
    const otherId = (await dbg<any[]>(me.page, 'remotes'))[0].identity;
    await expect.poll(async () => (await dbg<any>(me.page, 'audioStats', otherId))?.bytesReceived ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000);
    void other;
  }
});

test('mute/deafen are mirrored to the other user', async () => {
  await A.page.getByRole('button', { name: 'Mute', exact: true }).last().click();
  await expect(B.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted')).toHaveCount(1);
  await A.page.getByRole('button', { name: 'Unmute', exact: true }).last().click();
  await expect(B.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted')).toHaveCount(0);
});

test('camera: remote video track subscribed and decoded', async () => {
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await expect.poll(async () => (await dbg<any[]>(B.page, 'remotes'))[0]?.cameraSubscribed, { timeout: 20_000 }).toBe(true);
  const aId = (await dbg<any[]>(B.page, 'remotes'))[0].identity;
  await expect.poll(async () => (await dbg<any>(B.page, 'stats', aId, 'camera'))?.width ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await dbg<any>(B.page, 'tileVideo', aId, 'camera'))?.videoWidth ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn Off Camera' }).click();
});

test('leave updates gateway state', async () => {
  await B.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  await expect(A.page.getByRole('list', { name: 'Voice participants' }).getByRole('listitem')).toHaveCount(1);
  await expect(B.page.getByTestId('voice-dock')).toHaveCount(0);
});

const PRESETS = [
  { id: '720p30', label: '720p 30fps', w: 1280, h: 720, fps: 30 },
  { id: '1080p60', label: '1080p 60fps', w: 1920, h: 1080, fps: 60 },
  { id: '1440p60', label: '1440p 60fps', w: 2560, h: 1440, fps: 60 },
  { id: '4k60', label: '4K 60fps', w: 3840, h: 2160, fps: 60 },
  { id: 'source', label: 'Source', w: 3840, h: 2160, fps: 60 },
] as const;

test.describe('screen share quality picker', () => {
  test.beforeAll(async () => {
    // fresh join for both
    for (const u of [A, B]) { await voiceChannel(u.page).click(); await expect(u.page.getByTestId('voice-dock')).toContainText('Voice Connected'); }
    await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  });
  for (const pr of PRESETS) {
    test(`share at ${pr.id}`, async () => {
      test.setTimeout(150_000);
      const view = A.page.getByTestId('voice-view');
      await view.getByRole('button', { name: 'Stream quality options' }).click();
      const pop = A.page.getByTestId('share-popover');
      await pop.getByRole('radio', { name: pr.id === 'source' ? 'Source' : pr.label }).check();
      await pop.getByRole('button', { name: 'Go Live' }).click();
      const aId = (await dbg<any>(A.page, 'state')).participants.find((p: any) => p.isLocal).identity;

      // sender: capture track delivered at the selected resolution/fps
      await expect.poll(async () => (await dbg<any>(A.page, 'localTrack', 'screen'))?.width ?? 0, { timeout: 30_000 }).toBe(pr.w);
      const lt = await dbg<any>(A.page, 'localTrack', 'screen');
      expect(lt.height).toBe(pr.h); expect(Math.round(lt.frameRate)).toBe(pr.fps);

      // receiver: screen track subscribed, publication dimensions == selected, frames decoded
      await expect.poll(async () => (await dbg<any[]>(B.page, 'remotes')).find((r) => r.identity === aId)?.screenSubscribed, { timeout: 30_000 }).toBe(true);
      await expect(B.page.getByTestId('screen-tile')).toBeVisible();
      await expect.poll(async () => { const t = (await dbg<any[]>(B.page, 'remotes')).find((r) => r.identity === aId)?.tracks.find((x: any) => x.source === 'screen_share'); return t?.width ?? 0; }, { timeout: 30_000 }).toBe(pr.w);
      // ask for the source layer so the decoded stream is full size
      await B.page.getByLabel('Viewing quality').selectOption('high');
      await expect.poll(async () => (await dbg<any>(B.page, 'stats', aId, 'screen'))?.width ?? 0, { timeout: 45_000 }).toBeGreaterThan(0);
      const st = await dbg<any>(B.page, 'stats', aId, 'screen');
      console.log(`[${pr.id}] receiver stats`, JSON.stringify(st), 'sender', JSON.stringify(await dbg(A.page, 'stats', aId, 'screen')));
      await expect.poll(async () => (await dbg<any>(B.page, 'tileVideo', aId, 'screen'))?.videoWidth ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      // stats overlay in the UI reports dimensions too
      await B.page.getByTestId('screen-tile').hover();
      await B.page.getByRole('button', { name: 'Stream stats' }).click();
      await expect(B.page.getByTestId('stream-stats')).toHaveAttribute('data-width', /[1-9]\d+/);
      await B.page.getByRole('button', { name: 'Stream stats' }).click();

      await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stop Streaming' }).click();
      await expect(B.page.getByTestId('screen-tile')).toHaveCount(0);
    });
  }
});
