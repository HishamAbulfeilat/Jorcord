/**
 * Memory soak (docs/PERFORMANCE.md). One client lives through a long session: a busy channel with ~1500 messages, scrolling
 * through history, switching between 14 channels over and over, a flood of gateway events from a second user (into open and
 * never-opened channels), and voice join/leave. Heap is read through the Chrome DevTools protocol after a forced GC.
 *
 * Assertions are deliberately generous so CI is not flaky; they catch unbounded growth, not 5% drift:
 *   - JS heap growth over the soak <= PERF_HEAP_CEILING_MB (default 120)
 *   - channels kept in memory <= the LRU cap, messages in memory <= cap * (per-channel cap + slack)
 * Run: `pnpm e2e perf-soak` (full stack incl. LiveKit, set PERF_VOICE=1 for voice join/leave) or
 * `pnpm exec playwright test -c e2e/playwright.perf.config.ts` (API + web only). Knobs: PERF_SOAK_ROUNDS (default 3), PERF_SEED (messages in the busy channel, default 1500), PERF_REPORT (json output path).
 */
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, openUserSettings, closeSettings, type User } from './helpers';

const ROUNDS = Number(process.env.PERF_SOAK_ROUNDS ?? 3);
const SEED = Number(process.env.PERF_SEED ?? 1500);
const CEILING_MB = Number(process.env.PERF_HEAP_CEILING_MB ?? 120);
const CHANNELS = 14;
const VOICE = process.env.PERF_VOICE === '1';

let A: User, B: User, gid: string;
let cdp: CDPSession;
const samples: { label: string; heapMB: number; nodes: number; listeners: number }[] = [];

async function sample(page: Page, label: string) {
  await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const s = { label, heapMB: Math.round((usedSize / 1048576) * 10) / 10, nodes: dom.nodes, listeners: dom.jsEventListeners };
  samples.push(s); console.log(`[perf] ${label}: heap ${s.heapMB} MB, dom nodes ${s.nodes}, listeners ${s.listeners}`);
  return s;
}
const chanBtn = (p: Page, name: string) => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name, exact: true });

async function seed(page: Page, channelId: string, n: number) {
  for (let i = 0; i < n; i += 25) await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, j) => rest(page, 'POST', `/channels/${channelId}/messages`, { content: `seed ${i + j} lorem ipsum dolor sit amet https://example.test/${i + j}` })));
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Soak'); B = await newUser(browser, 'Flood');
  await createServer(A.page, 'Soak Guild');
  gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
  cdp = await A.ctx.newCDPSession(A.page);
  await cdp.send('Memory.getDOMCounters');
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('long session keeps heap, caches and DOM bounded', async () => {
  const g = await rest<{ channels: { id: string; name: string; type: string }[] }>(A.page, 'GET', `/guilds/${gid}`);
  const general = g.channels.find((c) => c.name === 'general' && c.type === 'text')!;
  const made: { id: string; name: string }[] = [general];
  for (let i = 1; i < CHANNELS; i++) made.push(await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: `soak-${i}`, type: 'text' }));
  await seed(A.page, general.id, SEED);
  for (const c of made.slice(1)) await seed(A.page, c.id, 60);

  await chanBtn(A.page, 'general').click();
  await expect(A.page.getByTestId('message-scroller')).toBeVisible();
  await A.page.waitForTimeout(1500);
  const base = await sample(A.page, 'baseline (busy channel open)');

  for (let round = 1; round <= ROUNDS; round++) {
    // scroll back through history so older pages load (and far pages must be trimmed), then return to the present
    await chanBtn(A.page, 'general').click();
    const sc = A.page.getByTestId('message-scroller');
    for (let i = 0; i < 25; i++) { await sc.evaluate((el) => { el.scrollTop = 0; }); await A.page.waitForTimeout(120); }
    await sc.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // flood of gateway events from B into open + never-opened channels while A switches channels
    const flood = Promise.all(Array.from({ length: 80 }, (_, i) => rest(B.page, 'POST', `/channels/${made[i % made.length]!.id}/messages`, { content: `flood r${round} #${i} @everyone-ish` })));
    for (const c of made) { await chanBtn(A.page, c.name).click(); await A.page.waitForTimeout(80); }
    await flood;
    if (VOICE) { // voice join / leave (needs the LiveKit test server, so opt-in: PERF_VOICE=1)
      await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
      await expect(A.page.getByTestId('voice-dock')).toContainText('Voice Connected', { timeout: 20_000 });
      await A.page.getByRole('button', { name: /Disconnect|Leave/i }).last().click();
    }
    await sample(A.page, `after round ${round}`);
  }

  const end = samples[samples.length - 1]!;
  // what the app itself reports (Settings > Advanced > Memory & performance)
  await openUserSettings(A.page, 'Advanced');
  const channelsInMem = Number(((await A.page.getByTestId('stat-channels').textContent()) ?? '').split('/')[0]!.trim());
  const messagesInMem = Number(((await A.page.getByTestId('stat-messages').textContent()) ?? '0').trim());
  await closeSettings(A.page);
  console.log(`[perf] channels in memory ${channelsInMem}, messages in memory ${messagesInMem}`);

  const report = { rounds: ROUNDS, seed: SEED, samples, growthMB: Math.round((end.heapMB - base.heapMB) * 10) / 10, channelsInMem, messagesInMem };
  const out = process.env.PERF_REPORT ?? 'test-results/perf-soak.json';
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));

  expect(channelsInMem).toBeLessThanOrEqual(12);
  expect(messagesInMem).toBeLessThanOrEqual(12 * (400 + 100));
  expect(end.heapMB - base.heapMB, `heap grew by ${end.heapMB - base.heapMB} MB over ${ROUNDS} rounds`).toBeLessThan(CEILING_MB);
});
