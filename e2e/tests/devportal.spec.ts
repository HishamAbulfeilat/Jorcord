import { test, expect } from '@playwright/test';
import { newUser, createServer, rest, guildId, type User } from './helpers';
import { Bot } from './bot';

let A: User, B: User, gid: string;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Portal HQ'); gid = await guildId(A.page);
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

let appId = ''; let token1 = '';

test('developer portal: create an application and see the bot token exactly once', async () => {
  const p = A.page;
  await p.getByRole('button', { name: 'User Settings' }).first().click();
  await p.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'Developer Portal' }).click();
  await expect(p).toHaveURL(/\/developers$/);
  await expect(p.getByText('No applications yet')).toBeVisible();
  await p.getByRole('button', { name: 'New Application' }).click();
  await p.getByLabel('Name').fill('Dicebot');
  await p.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(p).toHaveURL(/\/developers\/\d+\/information/);
  appId = p.url().match(/developers\/(\d+)/)![1]!;
  token1 = await p.getByTestId('bot-token').inputValue(); expect(token1.length).toBeGreaterThan(20);
  await expect(p.getByTestId('client-secret')).toBeVisible();
  // the token really is the bot's credential
  const me = await fetch('http://127.0.0.1:3100/api/v1/applications/@me', { headers: { authorization: `Bot ${token1}` } });
  expect(me.status).toBe(200); expect((await me.json()).id).toBe(appId);
  // "I have saved it" hides it; a reload never shows it again
  await p.getByRole('button', { name: 'I have saved it' }).first().click();
  await expect(p.getByTestId('bot-token')).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId('bot-token')).toHaveCount(0);
  await expect(p.getByTestId('app-id')).toHaveValue(appId);
  await expect(p.getByTestId('app-public-key')).toHaveValue(/^[0-9a-f]{64}$/);
});

test('developer portal: edit general info, public bot toggle; the list shows the app', async () => {
  const p = A.page;
  await p.getByLabel('Description').fill('Rolls dice for the team');
  await p.getByRole('button', { name: 'Save Changes' }).click();
  await expect(p.getByText('Application saved')).toBeVisible();
  await expect.poll(async () => (await rest(p, 'GET', `/applications/${appId}`)).description).toBe('Rolls dice for the team');
  await p.getByRole('link', { name: 'Bot', exact: true }).click();
  await p.getByRole('switch', { name: 'Public Bot' }).click();
  await expect.poll(async () => (await rest(p, 'GET', `/applications/${appId}`)).botPublic).toBe(false);
  await p.getByRole('switch', { name: 'Public Bot' }).click();
  await expect.poll(async () => (await rest(p, 'GET', `/applications/${appId}`)).botPublic).toBe(true);
  await p.goto('/developers');
  await expect(p.locator(`[data-app="${appId}"]`)).toContainText('Dicebot');
});

test('developer portal: reset the bot token kills the old one and shows the new one once', async () => {
  const p = A.page;
  const bot = new Bot(); bot.appId = appId; bot.token = token1;
  await bot.connect(); // a live gateway session that the reset must drop
  await p.goto(`/developers/${appId}/bot`);
  await p.getByRole('button', { name: 'Reset Token' }).click();
  await p.getByRole('button', { name: 'Yes, do it!' }).click();
  const token2 = await p.getByTestId('bot-token').inputValue();
  expect(token2).not.toBe(token1); expect(token2.length).toBeGreaterThan(20);
  expect((await fetch('http://127.0.0.1:3100/api/v1/applications/@me', { headers: { authorization: `Bot ${token1}` } })).status).toBe(401);
  expect((await fetch('http://127.0.0.1:3100/api/v1/applications/@me', { headers: { authorization: `Bot ${token2}` } })).status).toBe(200);
  bot.close();
  await p.reload(); await expect(p.getByTestId('bot-token')).toHaveCount(0);
});

test('developer portal: reset the client secret, redirects and the OAuth2 URL generator', async () => {
  const p = A.page;
  await p.goto(`/developers/${appId}/oauth2`);
  await expect(p.getByTestId('client-id')).toHaveValue(appId);
  await p.getByRole('button', { name: 'Reset Secret' }).click();
  await p.getByRole('button', { name: 'Reset Secret', exact: true }).last().click();
  await expect(p.getByTestId('client-secret')).toBeVisible();
  // redirects are validated and saved
  await p.getByLabel('Redirect URI').fill('not a url'); await p.getByRole('button', { name: 'Add Redirect' }).click();
  await expect(p.getByText('Enter a valid http(s) URL')).toBeVisible();
  await p.getByLabel('Redirect URI').fill('https://example.test/callback'); await p.getByRole('button', { name: 'Add Redirect' }).click();
  await p.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(p, 'GET', `/applications/${appId}`)).redirectUris).toEqual(['https://example.test/callback']);
  // URL generator: default scopes, then add a permission
  const url = p.getByTestId('generated-url');
  await expect(url).toHaveValue(new RegExp(`/oauth2/authorize\\?client_id=${appId}&scope=bot%20applications\\.commands$`));
  await p.getByLabel('Send Messages', { exact: true }).check();
  await p.getByLabel('Create Polls').check();
  const bits = ((1n << 11n) | (1n << 41n)).toString();
  await expect(url).toHaveValue(new RegExp(`permissions=${bits}`));
  await p.getByRole('checkbox', { name: /^applications\.commands/ }).uncheck();
  await expect(url).toHaveValue(new RegExp(`scope=bot&permissions=${bits}`));
  await p.getByRole('checkbox', { name: /^bot / }).uncheck();
  await p.getByRole('checkbox', { name: /^identify/ }).check();
  await p.getByLabel('Redirect URL').selectOption('https://example.test/callback');
  await expect(url).toHaveValue(/scope=identify&redirect_uri=https%3A%2F%2Fexample\.test%2Fcallback&response_type=code/);
});

test('developer portal: command list shows registered commands per scope and deletes them', async () => {
  const p = A.page;
  const bot = new Bot(); bot.appId = appId;
  // the bot token was reset above: fetch the live app's new bot credentials by resetting through the API as the owner
  bot.token = (await rest(p, 'POST', `/applications/${appId}/bot/reset-token`)).token;
  await bot.install(p, gid);
  await bot.rest('PUT', `/applications/${appId}/commands`, [
    { name: 'roll', description: 'Roll a die', options: [{ type: 4, name: 'sides', description: 'How many sides', required: true }] },
    { name: 'settings', description: 'Bot settings', options: [{ type: 1, name: 'view', description: 'View' }, { type: 1, name: 'set', description: 'Set', options: [{ type: 3, name: 'value', description: 'v', required: true }] }] },
  ]);
  await bot.rest('POST', `/applications/${appId}/guilds/${gid}/commands`, { name: 'serveronly', description: 'Only here' });
  await p.goto(`/developers/${appId}/commands`);
  const global = p.locator('[data-scope=global]');
  await expect(global.locator('[data-command]')).toHaveCount(2);
  await expect(global.locator('[data-command=roll]')).toContainText('sides*');
  await expect(global.locator('[data-command=settings]')).toContainText('view');
  await expect(p.locator(`[data-scope="${gid}"] [data-command=serveronly]`)).toBeVisible();
  await expect(p.getByText('Installed in')).toBeVisible();
  await expect(p.getByRole('list').filter({ hasText: 'Portal HQ' }).first()).toBeVisible();
  await p.getByRole('button', { name: 'Delete /roll' }).click();
  await p.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(global.locator('[data-command]')).toHaveCount(1);
  expect((await bot.rest('GET', `/applications/${appId}/commands`)).map((c: any) => c.name)).toEqual(['settings']);
});

test('developer portal: delete the application', async () => {
  const p = A.page;
  await p.goto(`/developers/${appId}/information`);
  await p.getByRole('button', { name: 'Delete App' }).click();
  await p.getByRole('dialog').getByRole('textbox').fill('Dicebot');
  await p.getByRole('button', { name: 'Confirm' }).click();
  await expect(p).toHaveURL(/\/developers$/);
  await expect(p.getByText('No applications yet')).toBeVisible();
});

test('the portal needs a login', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:5273', serviceWorkers: 'block' }); const p = await ctx.newPage();
  await p.goto('/developers'); await expect(p).toHaveURL(/\/login\?next=%2Fdevelopers/); await ctx.close();
});

test('OAuth2 authorize page: add a bot to a server I manage, with a permission checklist', async () => {
  const bot = await Bot.create(A.page, 'Helper', { redirectUris: ['https://example.test/callback'] });
  const p = A.page;
  const bits = ((1n << 11n) | (1n << 41n)).toString(); // send messages + create polls
  await p.goto(`/oauth2/authorize?client_id=${bot.appId}&scope=bot%20applications.commands&permissions=${bits}`);
  await expect(p.getByTestId('oauth-title')).toHaveText('Add Helper to a server');
  await expect(p.getByLabel('Add to server')).toHaveValue(gid);
  await expect(p.getByRole('list', { name: 'Scopes' })).toContainText('Add a bot to a server');
  await expect(p.getByRole('list', { name: 'Scopes' })).toContainText('Create commands in a server');
  const boxes = p.getByRole('group', { name: 'Bot permissions' }).getByRole('checkbox');
  await expect(boxes).toHaveCount(2); await expect(p.getByLabel('Create Polls')).toBeChecked();
  await p.getByLabel('Create Polls').uncheck();
  await p.getByRole('button', { name: 'Authorize' }).click();
  await expect(p.getByTestId('oauth-done')).toContainText('Helper was added to your server');
  // the bot is a member with a managed role limited to what was left checked
  const members = await rest(p, 'GET', `/guilds/${gid}/members?limit=100`);
  const botMember = members.find((m: any) => m.user.id === bot.botUserId); expect(botMember.user.bot).toBe(true);
  const roles = await rest(p, 'GET', `/guilds/${gid}/roles`);
  const role = roles.find((r: any) => r.id === botMember.roles[0]); expect(role.name).toBe('Helper'); expect(role.permissions).toBe((1n << 11n).toString());
  await p.getByRole('button', { name: 'Go to server' }).click();
  await expect(p).toHaveURL(new RegExp(`/channels/${gid}`));
  await expect(p.getByRole('complementary', { name: 'Members' })).toContainText('Helper');
  await expect(p.getByRole('complementary', { name: 'Members' }).getByText('Bot', { exact: true })).toBeVisible();
});

test('OAuth2 authorize page: needs Manage Server, shows API errors and rejects bad links', async () => {
  const bot = await Bot.create(A.page, 'Private Pal', { botPublic: false });
  const p = B.page; // Bob manages nothing
  await p.goto(`/oauth2/authorize?client_id=${bot.appId}&scope=bot`);
  await expect(p.getByRole('heading', { name: 'Application not found' })).toBeVisible(); // private bots are invisible to others
  const pub = await Bot.create(A.page, 'Public Pal');
  await p.goto(`/oauth2/authorize?client_id=${pub.appId}&scope=bot`);
  await expect(p.getByText('You need the Manage Server permission')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Authorize' })).toBeDisabled();
  await p.goto('/oauth2/authorize?client_id=1&scope=bogus');
  await expect(p.getByText('Invalid authorization link')).toBeVisible();
  await p.goto('/oauth2/authorize'); await expect(p.getByText('Invalid authorization link')).toBeVisible();
});

test('OAuth2 identify scope returns a code to the registered redirect', async () => {
  const bot = await Bot.create(A.page, 'Login With Jorcord', { redirectUris: ['https://example.test/callback'] });
  const p = A.page;
  await p.route('https://example.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>callback</h1>' }));
  await p.goto(`/oauth2/authorize?client_id=${bot.appId}&scope=identify&redirect_uri=${encodeURIComponent('https://example.test/callback')}&state=xyz`);
  await expect(p.getByTestId('oauth-title')).toContainText('wants to access your account');
  await expect(p.getByLabel('Add to server')).toHaveCount(0);
  await p.getByRole('button', { name: 'Authorize' }).click();
  await p.waitForURL(/example\.test\/callback\?code=.+&state=xyz/);
  const code = new URL(p.url()).searchParams.get('code')!;
  const tok = await fetch('http://127.0.0.1:3100/api/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: bot.appId, clientSecret: bot.clientSecret, grantType: 'authorization_code', code, redirectUri: 'https://example.test/callback' }) });
  expect(tok.status).toBe(200);
  const who = await fetch('http://127.0.0.1:3100/api/v1/oauth2/@me', { headers: { authorization: `Bearer ${(await tok.json()).accessToken}` } });
  expect((await who.json()).user.username).toBe(A.username);
});
