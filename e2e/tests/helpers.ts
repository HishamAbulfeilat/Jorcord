import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface User { ctx: BrowserContext; page: Page; username: string; email: string; display: string }
export const rnd = () => Math.random().toString(36).slice(2, 8);

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

export async function newUser(browser: Browser, label: string, o: { mobile?: boolean; viewport?: { width: number; height: number } } = {}): Promise<User> {
  const username = `${label}${rnd()}`.toLowerCase();
  const ctx = await browser.newContext({
    viewport: o.viewport ?? (o.mobile ? MOBILE : DESKTOP),
    ...(o.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' } : {}),
    permissions: ['microphone', 'camera'],
    baseURL: 'http://127.0.0.1:5273',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label}] pageerror`, e.message));
  await page.goto('/register');
  await page.getByLabel('Email').fill(`${username}@example.test`);
  await page.getByLabel('Display Name').fill(label);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByLabel(/I agree/).check();
  await page.getByRole('button', { name: /continue|register|create/i }).click();
  await page.waitForURL(/\/channels\/@me/);
  await expect(page.getByRole('navigation', { name: 'Servers' }).or(page.getByRole('tablist', { name: 'Main navigation' })).first()).toBeVisible();
  return { ctx, page, username, email: `${username}@example.test`, display: label };
}

export async function createServer(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add a Server' }).click();
  await page.getByRole('button', { name: /Create My Own/ }).click();
  await page.getByLabel('Server Name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} server menu` })).toBeVisible();
}

export const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('jorcord.auth.v1') || '{}').access as string);

/** Authenticated REST call from inside the page (same origin, same token the app uses). */
export async function rest<T = any>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const t = await token(page);
  return page.evaluate(async ({ method, path, body, t }) => {
    const r = await fetch('/api/v1' + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }, { method, path, body, t }) as Promise<T>;
}

export async function guildId(page: Page): Promise<string> {
  const m = page.url().match(/channels\/(\d+)/); if (!m) throw new Error('no guild in url ' + page.url()); return m[1]!;
}

/** Create an invite through the UI (channel hover button) and return the /invite/<code> path. */
export async function makeInvite(page: Page): Promise<string> {
  const row = page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /general/ }).first();
  await row.hover();
  await page.getByRole('button', { name: 'Create Invite' }).first().click({ force: true });
  const input = page.getByLabel('Invite link');
  await expect(input).toHaveValue(/invite\//);
  const url = await input.inputValue();
  await page.keyboard.press('Escape');
  return new URL(url).pathname;
}

export async function joinViaInvite(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole('button', { name: /Accept Invite/ }).click();
  await page.waitForURL(/\/channels\/\d+/);
}

export async function sendMessage(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^Message/ });
  await box.click(); await box.fill(text); await box.press('Enter');
}

export const msg = (page: Page, text: string | RegExp) => page.locator('[id^="msg-"]').filter({ hasText: text });

export async function hoverMsg(page: Page, text: string | RegExp) {
  const m = msg(page, text).first(); await m.hover(); return m;
}

/** 1x1 red PNG scaled by the browser: a valid, tiny image for upload tests. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
