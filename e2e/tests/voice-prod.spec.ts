/**
 * Production-like voice: the server serves the BUILT web app with its production CSP (same origin, LIVEKIT_URL=auto so
 * signalling goes through the server's /livekit proxy), LiveKit runs with docker-compose's rtc config, and both are killed and
 * restarted mid-call. This is the regression suite for "voice says Connecting… forever" and for auto-reconnect.
 */
import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, type User } from './helpers';
import { Stack, PORTS } from './stack';

const stack = new Stack();
const voiceChannel = (p: Page) => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true });
const dbg = <T>(p: Page, fn: string, ...args: unknown[]) => p.evaluate(([fn, args]) => (window as any).__jorcordVoice[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
const dock = (p: Page) => p.getByTestId('voice-dock');
const roster = (p: Page) => p.getByRole('list', { name: 'Voice participants' }).getByRole('listitem');
const leave = async (u: User) => { const b = u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }); if (await b.isVisible().catch(() => false)) await b.click(); };
const gwBar = (p: Page) => p.locator('[role=status]', { hasText: 'Reconnecting…' });

let A: User, B: User; const csp: string[] = [];
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const watchCsp = (page: Page, who: string) => {
  page.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(`${who}: ${m.text()}`); });
  return page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window as any).__csp = ((window as any).__csp ?? []).concat(`${e.violatedDirective} ${e.blockedURI}`); }));
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000);
  await stack.up();
  A = await newUser(browser, 'Alice', { baseURL: stack.origin });
  // Bob opens the app through a different host name for the same server: signalling must still resolve (LIVEKIT_URL=auto)
  B = await newUser(browser, 'Bob', { baseURL: `http://127.0.0.1:${PORTS.server}` });
  for (const [u, n] of [[A, 'A'], [B, 'B']] as const) { await watchCsp(u.page, n); await u.page.reload(); }
  await createServer(A.page, 'Prod Guild');
  await joinViaInvite(B.page, await makeInvite(A.page));
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); await stack.down(); });

test('server-served app + production CSP: two users join, hear and see each other', async () => {
  const res = await A.page.request.get(stack.origin + '/', { headers: { accept: 'text/html' } });
  expect(res.headers()['content-security-policy']).toContain('connect-src');
  expect(res.headers()['content-security-policy']).not.toMatch(/connect-src[^;]* (https?|wss?): /);

  await voiceChannel(A.page).click(); await voiceChannel(B.page).click();
  for (const u of [A, B]) { await expect(dock(u.page)).toContainText('Voice Connected', { timeout: 30_000 }); await expect(roster(u.page)).toHaveCount(2); }
  expect((await dbg<any>(A.page, 'state')).error).toBeNull();

  for (const me of [A, B]) {
    await expect.poll(async () => (await dbg<any[]>(me.page, 'remotes')).some((r) => r.audioSubscribed), { timeout: 20_000 }).toBe(true);
    const otherId = (await dbg<any[]>(me.page, 'remotes'))[0].identity;
    await expect.poll(async () => (await dbg<any>(me.page, 'audioStats', otherId))?.bytesReceived ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000);
  }
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  const aId = (await dbg<any[]>(B.page, 'remotes'))[0].identity;
  await expect.poll(async () => (await dbg<any>(B.page, 'tileVideo', aId, 'camera'))?.videoWidth ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);

  // the dock shows live quality like Discord's tooltip
  await expect(A.page.getByTestId('voice-dock-ping')).toContainText('ms', { timeout: 15_000 });
  await dock(A.page).getByRole('button', { name: /Connection details/ }).click();
  const pop = A.page.getByTestId('voice-conn-popover');
  await expect(pop.getByTestId('voice-ping')).toContainText('ms'); await expect(pop.getByTestId('voice-loss')).toContainText('%');
  await pop.getByRole('button', { name: 'Open diagnostics' }).click();
  const diag = A.page.getByTestId('voice-diagnostics');
  await expect(diag).toContainText('Voice server reachable'); await expect(diag).toContainText('/livekit');
  await expect(diag.locator('li[data-status="fail"]')).toHaveCount(0);
  await diag.getByRole('button', { name: 'Close' }).click();

  for (const u of [A, B]) expect(await u.page.evaluate(() => (window as any).__csp ?? [])).toEqual([]);
  expect(csp).toEqual([]);
});

test('LiveKit killed and restarted mid-call: both recover, mute / camera / roster survive', async () => {
  // state that must survive the outage
  await A.page.getByRole('button', { name: 'Mute', exact: true }).last().click();
  await expect(B.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted')).toHaveCount(1);

  await stack.killLivekit();
  for (const u of [A, B]) {
    const banner = u.page.getByTestId('voice-reconnecting');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(dock(u.page)).toContainText('Reconnecting…');
  }
  // keep changing state while offline: it is applied once we are back
  await B.page.getByRole('button', { name: 'Deafen', exact: true }).last().click();
  await expect.poll(async () => Number(await A.page.getByTestId('voice-reconnecting').getAttribute('data-attempt')), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

  await stack.startLivekit({ LIVEKIT_UDP_PORT: String(PORTS.lkMux) }); // comes back in single-UDP-port mode
  for (const u of [A, B]) {
    await expect(dock(u.page)).toContainText('Voice Connected', { timeout: 90_000 });
    await expect(u.page.getByTestId('voice-reconnecting')).toHaveCount(0);
    await expect(roster(u.page)).toHaveCount(2, { timeout: 30_000 });
  }
  const sa = await dbg<any>(A.page, 'state'); const sb = await dbg<any>(B.page, 'state');
  expect(sa.muted).toBe(true); expect(sa.cameraOn).toBe(true); expect(sb.deafened).toBe(true); expect(sa.error).toBeNull();
  // Alice is still muted for Bob, and her camera is back and decoded
  await expect(B.page.getByRole('list', { name: 'Voice participants' }).getByLabel('Muted').first()).toBeVisible();
  const aId = (await dbg<any[]>(B.page, 'remotes'))[0].identity;
  await expect.poll(async () => (await dbg<any>(B.page, 'tileVideo', aId, 'camera'))?.videoWidth ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  // media flows again: unmute, undeafen, audio bytes grow
  await A.page.getByRole('button', { name: 'Unmute', exact: true }).last().click();
  await B.page.getByRole('button', { name: 'Undeafen', exact: true }).last().click();
  const before = (await dbg<any>(B.page, 'audioStats', aId))?.bytesReceived ?? 0;
  await expect.poll(async () => ((await dbg<any>(B.page, 'audioStats', aId))?.bytesReceived ?? 0) - before, { timeout: 20_000 }).toBeGreaterThan(500);
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn Off Camera' }).click();
});

test('join with LiveKit down: the real reason, a Troubleshoot panel and Retry that works', async () => {
  for (const u of [A, B]) await leave(u);
  await expect(dock(A.page)).toHaveCount(0);
  await stack.killLivekit();
  const started = Date.now();
  await voiceChannel(A.page).click(); // clicking a voice channel joins it
  const panel = A.page.getByTestId('voice-troubleshoot');
  await expect(panel).toBeVisible({ timeout: 25_000 });
  expect(Date.now() - started).toBeLessThan(25_000); // bounded: never "Connecting…" forever
  await expect(panel).toHaveAttribute('data-code', /signal-unreachable|timeout|connection/);
  await panel.getByRole('button', { name: 'Troubleshoot' }).click();
  await expect(A.page.getByTestId('voice-troubleshoot-details')).toContainText('Voice server reachable', { timeout: 15_000 });
  await stack.startLivekit();
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(dock(A.page)).toContainText('Voice Connected', { timeout: 30_000 });
  await expect(A.page.getByTestId('voice-troubleshoot')).toHaveCount(0);
  await voiceChannel(B.page).click(); await expect(dock(B.page)).toContainText('Voice Connected', { timeout: 30_000 });
});

test('Docker Desktop failure mode: LiveKit advertises an unreachable ICE address -> bounded wait, "ice-failed" with the fix, Retry works once fixed', async () => {
  // Reproduces the user's report: signalling connects (through the app) but the advertised candidate (a container IP) is unreachable from the browser.
  for (const u of [A, B]) await leave(u);
  await stack.killLivekit(); await stack.startLivekit({ LIVEKIT_NODE_IP: '203.0.113.9' }, { onlyAdvertised: true });
  const started = Date.now();
  await voiceChannel(A.page).click();
  await expect(A.page.getByTestId('voice-connecting')).toBeVisible(); // visible while ICE is being attempted
  const panel = A.page.getByTestId('voice-troubleshoot');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - started).toBeLessThan(25_000);
  await expect(panel).toHaveAttribute('data-code', 'ice-failed');
  await expect(panel).toContainText('LIVEKIT_NODE_IP');
  await expect(dock(A.page)).toHaveCount(0);
  await stack.killLivekit(); await stack.startLivekit();
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(dock(A.page)).toContainText('Voice Connected', { timeout: 30_000 });
  await voiceChannel(B.page).click(); await expect(dock(B.page)).toContainText('Voice Connected', { timeout: 30_000 });
});

test('API server restarted: gateway "Reconnecting…" bar, then everything is back and voice state is re-announced', async () => {
  await stack.killServer();
  for (const u of [A, B]) await expect(gwBar(u.page).first()).toBeVisible({ timeout: 30_000 });
  await stack.startServer();
  for (const u of [A, B]) await expect(gwBar(u.page)).toHaveCount(0, { timeout: 60_000 });
  // chat works again
  const text = `after restart ${Date.now()}`;
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /general/ }).first().click();
  await sendMessage(A.page, text);
  await expect(msg(A.page, text)).toBeVisible();
  // voice survived (media never touched the API) and the gateway sees both users in the channel again
  for (const u of [A, B]) await expect(dock(u.page)).toContainText('Voice Connected', { timeout: 60_000 });
  await expect.poll(async () => (await dbg<any>(A.page, 'state')).participants.length, { timeout: 30_000 }).toBe(2);
  await voiceChannel(A.page).click();
  for (const u of [A, B]) await expect(roster(u.page)).toHaveCount(2, { timeout: 30_000 });
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  await expect(roster(A.page)).toHaveCount(0);
});
