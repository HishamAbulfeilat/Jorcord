import { test, expect } from '@playwright/test';
import { newUser, createServer, openGuildSettings, openUserSettings, closeSettings, rest, guildId, makeInvite, joinViaInvite, sendMessage, msg, type User } from './helpers';

let A: User;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { A = await newUser(browser, 'Warden'); });
test.afterAll(async () => { await A?.ctx.close(); });

test('automod: regex + block/alert rule from Settings, sandbox preview, alert embed in the log channel', async ({ browser }) => {
  const B = await newUser(browser, 'Offender');
  try {
    await createServer(A.page, 'Mod Lab');
    const gid = await guildId(A.page);
    const log = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'mod-log', type: 'text' });
    await openGuildSettings(A.page, 'Mod Lab', 'AutoMod');
    const dlg = A.page.getByRole('dialog', { name: 'Mod Lab' });
    await dlg.getByLabel('Name', { exact: true }).fill('No promo');
    await dlg.getByLabel('Trigger').selectOption('regex');
    await dlg.getByLabel('Patterns', { exact: true }).fill('free\\s+nitro');
    await dlg.getByRole('checkbox', { name: 'Send alert' }).check();
    await expect(dlg.getByRole('button', { name: 'Create Rule' })).toBeDisabled(); // alert needs a channel
    await dlg.getByLabel('Alert channel', { exact: true }).selectOption(log.id);
    await dlg.getByRole('button', { name: 'Create Rule' }).click();
    await expect(dlg.getByRole('listitem').filter({ hasText: 'No promo' })).toContainText('Pattern (regex)');
    await dlg.getByLabel('Sample message').fill('get FREE   Nitro now');
    await dlg.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(dlg.getByText('Would trigger: No promo')).toBeVisible();
    await closeSettings(A.page);

    await joinViaInvite(B.page, await makeInvite(A.page));
    await sendMessage(B.page, 'hello friends');
    await expect(msg(B.page, 'hello friends')).toBeVisible();
    await sendMessage(B.page, 'claim free   nitro here');
    await expect(msg(B.page, 'claim free   nitro here')).toHaveCount(0);
    await expect.poll(async () => (await rest(A.page, 'GET', `/channels/${log.id}/messages?limit=10`)).filter((m: any) => m.embeds.length).length).toBe(1);
    await A.page.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: /mod-log/ }).click();
    const alert = msg(A.page, 'AutoMod: No promo');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('claim free   nitro here');
    await expect(alert).toContainText('blocked message');
  } finally { await B.ctx.close(); }
});
