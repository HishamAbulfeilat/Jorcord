import { test, expect } from '@playwright/test';
import { newUser, createServer, sendMessage, msg, type User } from './helpers';

let A: User;
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Alice'); await createServer(A.page, 'Limit HQ'); });
test.afterAll(async () => { await A?.ctx.close(); });

const post = '**/api/v1/channels/*/messages';
const limited = (retry: number) => ({ status: 429, contentType: 'application/json', headers: { 'retry-after': String(Math.ceil(retry)), 'x-ratelimit-scope': 'user', 'x-ratelimit-global': 'false' }, body: JSON.stringify({ code: 'RATE_LIMITED', message: 'You are being rate limited.', details: { retryAfter: retry }, retry_after: retry, global: false, errorCode: 0 }) });

test('a short 429 is retried after Retry-After: the message goes out and nothing looks broken', async () => {
  let hits = 0; let firstAt = 0; let secondAt = 0;
  await A.page.route(post, async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    hits++; if (hits === 1) { firstAt = Date.now(); return r.fulfill(limited(1.2)); }
    secondAt = Date.now(); return r.continue();
  });
  await sendMessage(A.page, 'patience is a virtue');
  await expect(msg(A.page, 'patience is a virtue')).toBeVisible();
  expect(hits).toBe(2); expect(secondAt - firstAt).toBeGreaterThanOrEqual(1100);
  await expect(A.page.getByText('Failed to send')).toHaveCount(0);
  await A.page.unroute(post);
});

test('a long 429 is not hammered: it fails fast with a clear message and can be retried later', async () => {
  let hits = 0;
  await A.page.route(post, (r) => { if (r.request().method() !== 'POST') return r.continue(); hits++; return r.fulfill(limited(30)); });
  await sendMessage(A.page, 'too much, too fast');
  await expect(A.page.getByRole('status').getByText('You are being rate limited. Try again in 30 seconds.')).toBeVisible();
  await expect(A.page.getByText('Failed to send')).toBeVisible();
  expect(hits).toBe(1);                                         // no retry storm
  await A.page.unroute(post);
  // the bucket pause is remembered only for the route that was limited; retry works once the limit is lifted
  await A.page.getByRole('button', { name: 'Retry' }).click();
  await expect(msg(A.page, 'too much, too fast')).toBeVisible({ timeout: 40_000 });
});
