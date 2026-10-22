import { test, expect } from '@playwright/test';
import { newUser, createServer, openUserSettings, type User } from './helpers';

let A: User;
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

// A fake Web Speech recognizer: says "hello from the mock" once it is started (headless Chromium has no speech service).
const MOCK = () => {
  class Rec {
    lang = ''; continuous = false; interimResults = false; onresult: any = null; onerror: any = null; onend: any = null;
    start() { (window as any).__speechStarts = ((window as any).__speechStarts ?? 0) + 1; (window as any).__speechLang = this.lang;
      setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello from the mock' }], { isFinal: true })] }), 200); }
    stop() { this.onend?.(); } abort() { (window as any).__speechAborts = ((window as any).__speechAborts ?? 0) + 1; }
  }
  (window as any).webkitSpeechRecognition = Rec; (window as any).SpeechRecognition = Rec;
};

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice');
  await A.page.addInitScript(MOCK);
  await createServer(A.page, 'Caption Guild');
  await A.page.reload();
});
test.afterAll(async () => { await A?.ctx.close(); });

test('live captions: toggle on, join a call, see my own words under the tiles; muting releases the recognizer', async () => {
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(A.page.getByTestId('voice-dock')).toContainText('Voice Connected', { timeout: 30_000 });
  await expect(A.page.getByTestId('captions')).toHaveCount(0); // off by default
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Show live captions' }).click();
  const cap = A.page.getByTestId('captions');
  await expect(cap).toContainText('your speech only');
  await expect(cap).toContainText('hello from the mock', { timeout: 10_000 });
  expect(await A.page.evaluate(() => (window as any).__speechStarts)).toBeGreaterThanOrEqual(1);
  const aborts = await A.page.evaluate(() => (window as any).__speechAborts ?? 0);
  await A.page.getByRole('button', { name: 'Mute', exact: true }).last().click();
  await expect.poll(() => A.page.evaluate(() => (window as any).__speechAborts ?? 0)).toBeGreaterThan(aborts);
  await A.page.getByRole('button', { name: 'Hide live captions' }).click();
  await expect(cap).toHaveCount(0);
});
