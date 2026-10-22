import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, type User } from './helpers';

/**
 * Priority speaker, the "you are muted" hint, stage hand queue (anonymous hands, blocking) and Go Live viewers
 * (list, cap, removing a viewer). Real LiveKit, fake media devices.
 */
let A: User, B: User, C: User, gid: string;
test.describe.configure({ mode: 'serial' });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
const chan = (p: Page, name: string) => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name, exact: true });
const leave = async (u: User) => { const b = u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }); if (await b.isVisible().catch(() => false)) await b.click(); await expect(u.page.getByTestId('voice-dock')).toHaveCount(0, { timeout: 20_000 }); };

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); C = await newUser(browser, 'Cara');
  await createServer(A.page, 'Extras Guild');
  gid = await guildId(A.page);
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv); await joinViaInvite(C.page, inv);
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Town Hall', type: 'stage' });
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); await C?.ctx.close(); });

test('priority speaker: only a permitted member can switch it on, everyone sees the crown, and clients take the priority list from the server', async () => {
  await chan(A.page, 'General').click(); await chan(B.page, 'General').click();
  for (const u of [A, B]) await expect(u.page.getByTestId('voice-dock')).toContainText('Voice Connected');
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  // Bob lacks PRIORITY_SPEAKER: no button, and the API refuses him too
  await expect(B.page.getByRole('button', { name: /Priority Speaker/ })).toHaveCount(0);
  const voiceId = (await rest<any[]>(A.page, 'GET', `/guilds/${gid}/channels`)).find((c) => c.type === 'voice').id;
  await expect(rest(B.page, 'PUT', `/channels/${voiceId}/voice/priority-speaker`)).rejects.toThrow(/403/);
  // Alice (owner) enables it
  await A.page.getByRole('button', { name: 'Enable Priority Speaker' }).click();
  await expect(A.page.getByRole('button', { name: 'Disable Priority Speaker' })).toBeVisible();
  // Bob sees the crown on her tile and in the channel list, and his client treats her as the priority speaker
  await expect(B.page.getByTestId('priority-badge')).toHaveCount(1);
  await expect(B.page.getByTestId('vs-priority')).toHaveCount(1);
  await expect.poll(async () => (await dbg<any>(B.page, 'state')).participants.filter((p: any) => p.priority).length).toBe(1);
  // the server wrote the LiveKit attribute itself (apps/server tests prove tokens give nobody the right to write one)
  const attr = () => B.page.evaluate(() => [...(window as any).__jorcordVoice.room.remoteParticipants.values()].map((p: any) => p.attributes?.['jv.priority']));
  await expect.poll(attr).toEqual(['1']);
  // off again
  await A.page.getByRole('button', { name: 'Disable Priority Speaker' }).click();
  await expect(B.page.getByTestId('priority-badge')).toHaveCount(0);
  await leave(A); await leave(B);
});

test('"you are muted" hint appears when speaking into a muted mic, and the setting turns it off', async () => {
  // Chrome's fake microphone is silent between rare beeps: stand in for "someone talking" with a steady tone as the microphone
  await A.page.evaluate(() => {
    const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c?.audio) return orig(c);
      const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.frequency.value = 330;
      const gain = ctx.createGain(); gain.gain.value = 0.3; const dst = ctx.createMediaStreamDestination();
      osc.connect(gain); gain.connect(dst); osc.start();
      return dst.stream;
    };
  });
  await chan(A.page, 'General').click();
  await expect(A.page.getByTestId('voice-dock')).toContainText('Voice Connected');
  await A.page.getByRole('button', { name: 'Mute', exact: true }).last().click();
  await expect(A.page.getByTestId('muted-hint')).toBeVisible({ timeout: 30_000 });
  await expect(A.page.getByTestId('muted-hint')).toContainText('You are muted');
  expect((await dbg<any>(A.page, 'state')).speakingWhileMuted).toBe(true);
  // it goes away by itself, and by unmuting
  await expect(A.page.getByTestId('muted-hint')).toHaveCount(0, { timeout: 15_000 });
  // switch the hint off in Voice Settings: no hint any more while muted
  await A.page.getByRole('button', { name: 'Voice Settings' }).last().click();
  await A.page.getByRole('switch', { name: 'Warn me when I speak while muted' }).or(A.page.getByLabel('Warn me when I speak while muted')).first().click();
  await A.page.keyboard.press('Escape');
  await A.page.waitForTimeout(6000);
  await expect(A.page.getByTestId('muted-hint')).toHaveCount(0);
  expect((await dbg<any>(A.page, 'state')).speakingWhileMuted).toBe(false);
  await leave(A);
});

test('stage: hand queue shows the place in line, anonymous hands, and moderators can block a member', async () => {
  await chan(A.page, 'Town Hall').click(); await chan(B.page, 'Town Hall').click();
  await expect(A.page.getByTestId('stage')).toContainText('Audience — 1');
  // Bob raises his hand anonymously
  await B.page.getByLabel('Raise my hand anonymously').check();
  await B.page.getByRole('button', { name: 'Request to Speak' }).click();
  await expect(B.page.getByTestId('hand-position')).toContainText('number 1 in line');
  await expect(B.page.getByTestId('hand-position')).toContainText('only moderators can see it is you');
  const hands = A.page.getByRole('region', { name: 'Requests to speak' });
  await expect(hands).toContainText('Bob'); await expect(hands).toContainText('anonymous hand'); // the moderator sees who it is
  // Cara joins and cannot tell who the anonymous hand is
  await chan(C.page, 'Town Hall').click();
  await expect(C.page.getByRole('region', { name: 'Requests to speak' })).toContainText('Anonymous');
  await expect(C.page.getByRole('region', { name: 'Requests to speak' })).not.toContainText('Bob');
  await C.page.getByRole('button', { name: 'Request to Speak' }).click();
  await expect(C.page.getByTestId('hand-position')).toContainText('number 2 in line');
  // block Bob: his hand disappears, he cannot ask again, and he is listed as blocked
  await A.page.getByRole('button', { name: /Block Bob from speaking/ }).click();
  await expect(A.page.getByRole('region', { name: 'Blocked from speaking' })).toContainText('Bob');
  await expect(B.page.getByRole('button', { name: 'Request to Speak' })).toBeVisible();
  await B.page.getByRole('button', { name: 'Request to Speak' }).click();
  await expect(B.page.getByText(/cannot ask to speak/)).toBeVisible();
  await expect(C.page.getByTestId('hand-position')).toContainText('number 1 in line');
  await A.page.getByRole('button', { name: /Unblock/ }).click();
  await B.page.getByRole('button', { name: 'Request to Speak' }).click();
  await expect(B.page.getByTestId('hand-position')).toContainText('number 2 in line');
  for (const u of [A, B, C]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('Go Live: who is watching, the viewer limit, and removing a viewer', async () => {
  test.setTimeout(180_000);
  for (const u of [A, B, C]) { await chan(u.page, 'General').click(); await expect(u.page.getByTestId('voice-dock')).toContainText('Voice Connected'); }
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(3);
  // Alice goes live with room for one viewer
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stream quality options' }).click();
  const pop = A.page.getByTestId('share-popover');
  await pop.getByLabel('Viewer limit').selectOption('1');
  await pop.getByRole('button', { name: 'Go Live' }).click();
  await expect(B.page.getByTestId('screen-tile').first()).toBeVisible({ timeout: 30_000 });
  // the first viewer gets in and is counted; the sidebar shows the number too
  await expect(A.page.getByTestId('stream-viewer-count')).toHaveText('1 / 1', { timeout: 20_000 });
  await expect(A.page.getByTestId('vs-viewers')).toHaveText('1');
  const aliceId = (await dbg<any>(A.page, 'state')).participants.find((p: any) => p.isLocal).identity;
  // exactly one of Bob and Cara is in; the other is told the stream is full and does not receive the screen
  const full = [B, C].map((u) => u.page.getByTestId('stream-full'));
  await expect.poll(async () => (await Promise.all(full.map((l) => l.count()))).reduce((a, b) => a + b, 0), { timeout: 30_000 }).toBe(1);
  const [inside, outside] = (await full[0]!.count()) ? [C, B] : [B, C];
  await expect(outside.page.getByTestId('stream-full')).toContainText('limit 1');
  await expect.poll(async () => (await dbg<any[]>(inside.page, 'remotes')).find((r) => r.identity === aliceId)?.screenSubscribed, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await dbg<any[]>(outside.page, 'remotes')).find((r) => r.identity === aliceId)?.screenSubscribed, { timeout: 15_000 }).toBe(false);
  // everybody can look at who is watching; only the streamer sees remove buttons
  await outside.page.getByTestId('stream-viewers-button').click();
  await expect(outside.page.getByTestId('stream-viewer')).toHaveCount(1);
  await expect(outside.page.getByRole('button', { name: /^Remove .* from the stream$/ })).toHaveCount(0);
  // Alice removes the viewer: they are told, and the screen share stops reaching them
  await A.page.getByTestId('stream-viewers-button').click();
  await expect(A.page.getByTestId('stream-viewers-panel').getByTestId('stream-viewer')).toHaveCount(1);
  await A.page.getByTestId('stream-viewers-panel').getByRole('button', { name: /^Remove .* from the stream$/ }).click();
  await expect(inside.page.getByTestId('stream-kicked')).toBeVisible({ timeout: 20_000 });
  await expect(A.page.getByTestId('stream-viewers-panel')).toContainText('Removed from this stream');
  await expect.poll(async () => (await dbg<any[]>(inside.page, 'remotes')).find((r) => r.identity === aliceId)?.screenSubscribed, { timeout: 20_000 }).toBe(false);
  // the seat is free again, so the member who was turned away can come in with "Try again"
  await outside.page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(async () => (await dbg<any[]>(outside.page, 'remotes')).find((r) => r.identity === aliceId)?.screenSubscribed, { timeout: 30_000 }).toBe(true);
  // allow the removed viewer again
  await A.page.getByTestId('stream-viewers-panel').getByRole('button', { name: 'Allow again' }).click();
  await expect(A.page.getByTestId('stream-viewers-panel')).not.toContainText('Removed from this stream');
  for (const u of [A, B, C]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});
