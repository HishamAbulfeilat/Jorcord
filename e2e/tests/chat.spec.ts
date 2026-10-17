import { test, expect } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, hoverMsg, rest, guildId, PNG, type User } from './helpers';

let A: User, B: User, gid: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Chat Guild');
  gid = await guildId(A.page);
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv);
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

test('B joins via invite link and both see each other as members', async () => {
  await expect(B.page.getByRole('button', { name: 'Chat Guild server menu' })).toBeVisible();
  await expect(B.page.getByRole('navigation', { name: 'Channels' })).toContainText('general');
  await expect(A.page.getByText('Bob').first()).toBeVisible();
});

test('live messages, reply, edit, reaction, delete', async () => {
  await B.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click();
  await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'general', exact: true }).click();

  await sendMessage(A.page, 'hello from alice');
  await expect(msg(B.page, 'hello from alice')).toBeVisible();

  // reply
  const m = await hoverMsg(B.page, 'hello from alice');
  await m.getByRole('button', { name: 'Reply' }).click();
  await expect(B.page.getByText(/Replying to/)).toBeVisible();
  await sendMessage(B.page, 'hi back, bob here');
  await expect(msg(A.page, 'hi back, bob here')).toBeVisible();
  await expect(msg(A.page, 'hi back, bob here')).toContainText('hello from alice'); // reply preview

  // edit (own message)
  const own = await hoverMsg(A.page, 'hello from alice');
  await own.getByRole('button', { name: 'Edit' }).click();
  const ed = A.page.getByRole('textbox', { name: 'Edit message' });
  await ed.fill('hello from alice (fixed)'); await ed.press('Enter');
  await expect(msg(B.page, 'hello from alice (fixed)')).toContainText('(edited)');

  // reaction
  const target = await hoverMsg(B.page, 'hello from alice (fixed)');
  await target.getByRole('button', { name: 'Add Reaction' }).click();
  await B.page.getByRole('dialog', { name: 'Emoji picker' }).getByRole('gridcell').first().click();
  await expect(msg(A.page, 'hello from alice (fixed)').getByRole('group', { name: 'Reactions' }).getByRole('button').first()).toContainText('1');
  await expect(msg(B.page, 'hello from alice (fixed)').getByRole('group', { name: 'Reactions' }).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  // remove it again
  await msg(B.page, 'hello from alice (fixed)').getByRole('group', { name: 'Reactions' }).getByRole('button').first().click();
  await expect(msg(A.page, 'hello from alice (fixed)').getByRole('group', { name: 'Reactions' })).toHaveCount(0);

  // delete
  const del = await hoverMsg(A.page, 'hi back, bob here');
  await del.getByRole('button', { name: 'Delete' }).click();
  await A.page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(msg(A.page, 'hi back, bob here')).toHaveCount(0);
  await expect(msg(B.page, 'hi back, bob here')).toHaveCount(0);
});

test('image upload is delivered and rendered', async () => {
  await A.page.locator('input[type=file]').first().setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(A.page.getByRole('list', { name: 'Attachments to upload' })).toBeVisible();
  const box = A.page.getByRole('textbox', { name: /^Message/ });
  await box.fill('look at this'); await box.press('Enter');
  const m = msg(B.page, 'look at this');
  await expect(m).toBeVisible();
  const img = m.locator('img[src*="/files/"]').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
});

test('typing indicator shows live', async () => {
  const box = A.page.getByRole('textbox', { name: /^Message/ });
  await box.click();
  // the client throttles TYPING to once per 8s per channel, so keep typing until one goes out
  await expect(async () => {
    await box.pressSequentially('t', { delay: 20 });
    await expect(B.page.getByText('is typing…')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect(B.page.getByText('is typing…')).toContainText('Alice');
  await box.fill('');
  // indicator disappears again once she stops (9s window)
  await expect(B.page.getByText('is typing…')).toHaveCount(0, { timeout: 15_000 });
});

test('unread badge and mention badge', async () => {
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'random', type: 'text' });
  const nav = B.page.getByRole('navigation', { name: 'Channels' });
  await nav.getByRole('button', { name: 'random', exact: true }).click(); // B moves away from #general
  await sendMessage(A.page, 'ping unread');
  const general = nav.getByRole('button', { name: 'general', exact: true });
  const row = nav.locator('li').filter({ has: B.page.getByRole('button', { name: 'general', exact: true }) });
  // unread pill on #general row
  await expect(row.locator('.pill-unread')).toBeVisible();
  // @mention -> numeric badge on the row and the server icon (B is on a different server? no: same, so check row badge)
  const bobId = (await rest<any>(B.page, 'GET', '/users/@me')).id;
  await rest(A.page, 'POST', (await (async () => { const ch = await rest<any[]>(A.page, 'GET', `/guilds/${gid}/channels`); return `/channels/${ch.find((c) => c.name === 'general').id}/messages`; })()), { content: `<@${bobId}> you there?` });
  await expect(row.getByLabel(/mentions/)).toBeVisible();
  // opening the channel clears both
  await general.click();
  await expect(msg(B.page, 'you there?')).toBeVisible();
  await expect(row.locator('.pill-unread')).toHaveCount(0);
  await expect(row.getByLabel(/mentions/)).toHaveCount(0);
});

test('server badge on the rail when B is in a DM / other server', async () => {
  // B goes Home; A mentions B -> the server icon carries a mention badge
  await B.page.getByRole('button', { name: 'Direct Messages' }).click();
  const ch = (await rest<any[]>(A.page, 'GET', `/guilds/${gid}/channels`)).find((c) => c.name === 'general');
  const bobId = (await rest<any>(B.page, 'GET', '/users/@me')).id;
  await rest(A.page, 'POST', `/channels/${ch.id}/messages`, { content: `<@${bobId}> second ping` });
  await expect(B.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /Chat Guild, \d+ mentions/ })).toBeVisible();
});

test('role permission restricts a channel (UI) and server enforces it', async () => {
  const chan = await rest<any>(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'staff-only', type: 'text' });
  const bobId = (await rest<any>(B.page, 'GET', '/users/@me')).id;
  const role = await rest<any>(A.page, 'POST', `/guilds/${gid}/roles`, { name: 'Insider' });
  const nav = (u: User) => u.page.getByRole('navigation', { name: 'Channels' });
  await B.page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Chat Guild/ }).click();
  await expect(nav(B).getByRole('button', { name: 'staff-only', exact: true })).toBeVisible();

  // A opens channel settings > Permissions and denies @everyone View Channel, allows Insider
  await nav(A).getByRole('button', { name: 'staff-only', exact: true }).hover();
  await A.page.getByRole('button', { name: 'Edit Channel' }).first().click({ force: true });
  await A.page.getByRole('tab', { name: 'Permissions' }).or(A.page.getByRole('button', { name: 'Permissions' })).first().click();
  const addOw = async (who: string) => { await A.page.getByRole('button', { name: 'Add role or member' }).click(); await A.page.getByRole('button', { name: who, exact: true }).click(); };
  await addOw('@everyone');
  await A.page.getByRole('radio', { name: 'deny VIEW_CHANNEL' }).click();
  await addOw('Insider');
  await A.page.getByRole('radio', { name: 'allow VIEW_CHANNEL' }).click();
  await A.page.getByRole('button', { name: /Save Changes/ }).click();
  await expect(A.page.getByText('Permissions saved')).toBeVisible();
  await A.page.keyboard.press('Escape');

  // B (no role) loses the channel live and the server refuses access
  await expect(nav(B).getByRole('button', { name: 'staff-only', exact: true })).toHaveCount(0);
  await expect(rest(B.page, 'GET', `/channels/${chan.id}/messages`)).rejects.toThrow(/40[34]/);
  await expect(rest(B.page, 'POST', `/channels/${chan.id}/messages`, { content: 'sneaky' })).rejects.toThrow(/40[34]/);

  // Grant the role to B: channel reappears and is usable
  await rest(A.page, 'PATCH', `/guilds/${gid}/members/${bobId}`, { roles: [role.id] });
  await expect(nav(B).getByRole('button', { name: 'staff-only', exact: true })).toBeVisible();
  await nav(B).getByRole('button', { name: 'staff-only', exact: true }).click();
  await sendMessage(B.page, 'insider here');
  await expect(msg(A.page, 'insider here')).toBeVisible().catch(async () => { await nav(A).getByRole('button', { name: 'staff-only', exact: true }).click(); await expect(msg(A.page, 'insider here')).toBeVisible(); });
});
