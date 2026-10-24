import { expect, test, type WebSocketRoute } from '@playwright/test';
import { newUser } from './helpers';

/**
 * The "Reconnecting…" banner must appear for a real outage and go away once the gateway is back (and never for a blip).
 * The gateway socket is proxied through Playwright so the test can kill it server-side and refuse new connections on demand.
 */
test('connection banner appears when the gateway dies and clears when it is back', async ({ browser }) => {
  const u = await newUser(browser, 'banner');
  const page = u.page;
  let allow = true; const live: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/gateway/, (ws) => {
    if (!allow) { void ws.close({ code: 1006, reason: 'test outage' }); return; }
    ws.connectToServer(); live.push(ws);
  });
  await page.reload(); // reconnect so the gateway socket goes through the proxy
  await expect(page.getByRole('navigation', { name: 'Servers' }).or(page.getByRole('tablist', { name: 'Main navigation' })).first()).toBeVisible();
  const banner = page.getByTestId('connection-banner');
  await expect.poll(() => live.length).toBeGreaterThan(0);
  await page.waitForTimeout(2000); // READY has long arrived
  await expect(banner).toHaveCount(0);

  // 1) a blip (server closes, the client reconnects at once): no banner is ever shown
  await page.evaluate(() => { (window as any).__flash = 0; new MutationObserver(() => { if (document.querySelector('[data-testid=connection-banner]')) (window as any).__flash++; }).observe(document.body, { childList: true, subtree: true }); });
  live.splice(0).forEach((w) => void w.close({ code: 1006 }));
  await expect.poll(() => live.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as any).__flash)).toBe(0);

  // 2) a real outage: refuse new sockets and drop the live one
  allow = false;
  live.splice(0).forEach((w) => void w.close({ code: 1006 }));
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/Reconnecting|Connecting|Still trying/);
  await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();

  // 3) the server is back: Retry now (or the next backoff) reconnects and the banner clears
  allow = true;
  await banner.getByRole('button', { name: 'Retry now' }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });

  // 4) offline -> online in the browser
  await u.ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await u.ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await u.ctx.close();
});

test('auth rejection shows "Session expired" with a sign-in action, not Reconnecting forever', async ({ browser }) => {
  const u = await newUser(browser, 'expired');
  const page = u.page;
  await page.routeWebSocket(/\/gateway/, (ws) => { void ws.close({ code: 4004, reason: 'authentication failed' }); });
  // the REST session is also rejected, so the token cannot be repaired
  await page.route('**/api/**/users/@me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }));
  await page.reload();
  const banner = page.getByTestId('connection-banner');
  await expect(banner.or(page.getByRole('button', { name: /log in|sign in/i }).first())).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Reconnecting…')).toHaveCount(0);
  await u.ctx.close();
});
