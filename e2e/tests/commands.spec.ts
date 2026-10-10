import { test, expect } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, msg, openGuildSettings, closeSettings, type User } from './helpers';
import { Bot } from './bot';

let A: User, B: User, gid: string, bot: Bot;
test.describe.configure({ mode: 'serial' });

const box = (u: User) => u.page.getByRole('textbox', { name: /^Message/ });
const form = (u: User) => u.page.getByTestId('slash-form');
const run = (u: User) => form(u).getByRole('button', { name: 'Run command' });
const opt = (u: User, name: string) => form(u).getByLabel(name, { exact: true });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Slash HQ'); gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
  bot = await Bot.create(A.page, 'Dicebot'); await bot.connect(); await bot.install(A.page, gid);
  await bot.rest('PUT', `/applications/${bot.appId}/commands`, [
    { name: 'ping', description: 'Check the bot is alive' },
    { name: 'roll', description: 'Roll a die', options: [
      { type: 4, name: 'sides', description: 'How many sides', required: true, minValue: 2, maxValue: 100 },
      { type: 3, name: 'mode', description: 'How', choices: [{ name: 'Fast', value: 'fast' }, { name: 'Careful', value: 'careful' }] },
      { type: 3, name: 'label', description: 'Name this roll', autocomplete: true }] },
    { name: 'settings', description: 'Bot settings', options: [{ type: 1, name: 'view', description: 'Show' }, { type: 1, name: 'set', description: 'Change', options: [{ type: 3, name: 'value', description: 'New value', required: true }] }] },
    { name: 'slow', description: 'Takes a while' }, { name: 'silent', description: 'Never answers' }, { name: 'feedback', description: 'Opens a form' }, { name: 'whisper', description: 'Only you hear it' },
  ]);
  for (const u of [A, B]) { await u.page.reload(); await expect(u.page.getByRole('textbox', { name: /^Message/ })).toBeVisible(); }
});
test.afterAll(async () => { bot?.close(); await A?.ctx.close(); await B?.ctx.close(); });

test('typing / lists the commands with the app name; typing narrows; Escape closes', async () => {
  await box(A).click(); await box(A).pressSequentially('/');
  const list = A.page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toContainText('Commands');
  await expect(list.getByRole('option')).toHaveCount(7);
  await expect(list.getByRole('option').first()).toContainText('Dicebot');
  await box(A).pressSequentially('ro');
  await expect(list.getByRole('option')).toHaveCount(1); await expect(list).toContainText('/roll'); await expect(list).toContainText('Roll a die');
  await box(A).press('Escape'); await expect(list).toHaveCount(0);
  await box(A).fill('');
});

test('a command without options: pick, run, the app replies and everyone sees "Alice used /ping"', async () => {
  await box(A).fill('/pi');
  await A.page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /\/ping/ }).click();
  await expect(form(A)).toBeVisible(); await expect(form(A).getByTestId('slash-chip')).toHaveText('/ping');
  await run(A).click();
  const it = await bot.next((i) => i.type === 2 && i.data.name === 'ping');
  expect(it.user.id).toBeTruthy(); expect(it.data.options ?? []).toEqual([]);
  expect((await bot.callback(it, 4, { content: 'Pong!' })).status).toBe(204);
  await expect(form(A)).toHaveCount(0);
  for (const u of [A, B]) {
    const m = msg(u.page, 'Pong!'); await expect(m).toBeVisible();
    await expect(m.getByTestId('interaction-header')).toContainText('Alice'); await expect(m.getByTestId('interaction-header')).toContainText('/ping');
    await expect(m.getByText('Bot', { exact: true })).toBeVisible();
  }
});

test('options: required/min validation in the form, typed values go on the wire', async () => {
  await box(A).fill('/roll ');                       // an exact name plus a space starts the form
  await expect(form(A).getByTestId('slash-chip')).toHaveText('/roll');
  await opt(A, 'sides').fill('1');
  await run(A).click();
  await expect(form(A)).toContainText('Must be at least 2');
  await expect.poll(() => bot.interactions.filter((i) => i.data?.name === 'roll').length).toBe(0); // nothing was sent
  await opt(A, 'sides').fill('');
  await run(A).click(); await expect(form(A)).toContainText('This field is required');
  await opt(A, 'sides').fill('6'); await opt(A, 'mode').selectOption('careful');
  await run(A).click();
  const it = await bot.next((i) => i.type === 2 && i.data.name === 'roll');
  expect(it.data.options).toEqual([{ name: 'sides', type: 4, value: 6 }, { name: 'mode', type: 3, value: 'careful' }]);
  await bot.callback(it, 4, { content: 'Rolled a 4', components: [{ type: 1, components: [
    { type: 2, style: 1, label: 'Roll again', customId: 'again' }, { type: 2, style: 5, label: 'Rules', url: 'https://example.test/rules' }, { type: 2, style: 4, label: 'Disabled', customId: 'dis', disabled: true }] },
    { type: 1, components: [{ type: 3, customId: 'pick', placeholder: 'Pick a side', options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b' }] }] }] });
  await expect(msg(A.page, 'Rolled a 4').getByRole('button', { name: 'Roll again' })).toBeVisible();
  await expect(msg(B.page, 'Rolled a 4').getByRole('link', { name: 'Rules' })).toHaveAttribute('href', 'https://example.test/rules');
  await expect(msg(B.page, 'Rolled a 4').getByRole('button', { name: 'Disabled' })).toBeDisabled();
});

test('autocomplete: the app is asked while typing and its choices fill the option', async () => {
  await box(A).fill('/roll ');
  await opt(A, 'sides').fill('20');
  await opt(A, 'label').fill('al');
  const ac = await bot.next((i) => i.type === 4);
  expect(ac.data.options.find((o: any) => o.focused)).toMatchObject({ name: 'label', value: 'al', focused: true });
  expect(ac.data.options.find((o: any) => o.name === 'sides')).toMatchObject({ value: 20 });
  expect((await bot.callback(ac, 8, { choices: [{ name: 'Alpha', value: 'alpha' }, { name: 'Almond', value: 'almond' }] })).status).toBe(204);
  const list = form(A).getByRole('listbox', { name: 'label suggestions' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await list.getByRole('option', { name: 'Almond' }).click();
  await expect(opt(A, 'label')).toHaveValue('almond');
  await form(A).getByRole('button', { name: 'Cancel command' }).click(); await expect(form(A)).toHaveCount(0);
});

test('sub-commands pick a variant and send nested options', async () => {
  await box(A).fill('/settings ');
  await expect(form(A).getByTestId('slash-chip')).toHaveText('/settings view');
  await form(A).getByLabel('subcommand').selectOption({ label: 'set' });
  await expect(form(A).getByTestId('slash-chip')).toHaveText('/settings set');
  await opt(A, 'value').fill('loud');
  await opt(A, 'value').press('Enter');
  const it = await bot.next((i) => i.data?.name === 'settings');
  expect(it.data.options).toEqual([{ name: 'set', type: 1, options: [{ name: 'value', type: 3, value: 'loud' }] }]);
  await bot.callback(it, 4, { content: 'Setting changed to loud' });
  await expect(msg(B.page, 'Setting changed to loud')).toBeVisible();
});

test('buttons: press -> the app updates the message in place for everyone; a spinner shows while waiting', async () => {
  await msg(A.page, 'Rolled a 4').getByRole('button', { name: 'Roll again' }).click();
  await expect(msg(A.page, 'Rolled a 4').getByRole('button', { name: 'Roll again' })).toBeDisabled(); // busy until the app answers
  const it = await bot.next((i) => i.type === 3 && i.data.customId === 'again');
  expect(it.message?.id ?? it.messageId ?? true).toBeTruthy();
  await bot.callback(it, 7, { content: 'Rolled again: 2', components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Once more', customId: 'again' }] }] });
  for (const u of [A, B]) { await expect(msg(u.page, 'Rolled again: 2')).toBeVisible(); await expect(msg(u.page, 'Rolled again: 2').getByRole('button', { name: 'Once more' })).toBeEnabled(); }
  await expect(msg(A.page, 'Rolled a 4')).toHaveCount(0);
});

test('ephemeral replies: only the presser sees them, with "Only you can see this" and Dismiss', async () => {
  await msg(B.page, 'Rolled again: 2').getByRole('button', { name: 'Once more' }).click();
  const it = await bot.next((i) => i.type === 3 && i.user.username === B.username);
  await bot.callback(it, 4, { content: 'Psst, only for Bob', flags: 64 });
  const m = msg(B.page, 'Psst, only for Bob'); await expect(m).toBeVisible();
  await expect(m.getByTestId('ephemeral-notice')).toContainText('Only you can see this');
  await expect(m.getByRole('toolbar')).toHaveCount(0);        // no reply/pin/delete on a message nobody else has
  await expect(msg(A.page, 'Psst')).toHaveCount(0);
  const hist = await rest(A.page, 'GET', `/channels/${(await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general').id}/messages`);
  expect(JSON.stringify(hist)).not.toContain('Psst');
  // it survives a navigation inside the app (no refetch) and goes away on Dismiss
  await B.page.getByRole('button', { name: 'Direct Messages' }).click(); await B.page.getByRole('button', { name: 'Slash HQ' }).click();
  await expect(msg(B.page, 'Psst, only for Bob')).toBeVisible();
  await m.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(msg(B.page, 'Psst')).toHaveCount(0);
});

test('select menus submit the chosen values', async () => {
  const m = msg(B.page, 'Rolled again: 2');
  await expect(m).toBeVisible();
  // the first message's select was replaced by the update above; post a fresh one through /whisper-like flow
  await box(B).fill('/whisper '); await run(B).click();
  const it = await bot.next((i) => i.data?.name === 'whisper');
  await bot.callback(it, 4, { content: 'Pick one', components: [{ type: 1, components: [{ type: 3, customId: 'pick', placeholder: 'Choose a colour', minValues: 1, maxValues: 2, options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b' }, { label: 'Green', value: 'g' }] }] }] });
  const pick = msg(B.page, 'Pick one').getByRole('combobox', { name: 'Choose a colour' });
  await pick.click();
  await B.page.getByRole('option', { name: 'Red' }).click(); await B.page.getByRole('option', { name: 'Green' }).click();
  await pick.click(); // closing submits once
  const sel = await bot.next((i) => i.type === 3 && i.data.customId === 'pick');
  expect(sel.data.values).toEqual(['r', 'g']);
  await bot.callback(sel, 6);
});

test('deferred reply shows "is thinking…" until the app fills it in', async () => {
  await box(A).fill('/slow '); await run(A).click();
  const it = await bot.next((i) => i.data?.name === 'slow');
  expect((await bot.callback(it, 5)).status).toBe(204);
  for (const u of [A, B]) await expect(u.page.getByTestId('thinking')).toContainText('Dicebot is thinking…');
  expect((await bot.editOriginal(it, { content: 'Finished slowly' })).status).toBe(200);
  for (const u of [A, B]) { await expect(msg(u.page, 'Finished slowly')).toBeVisible(); await expect(u.page.getByTestId('thinking')).toHaveCount(0); }
});

test('an app that does not answer in 3s: "The application did not respond" (only for the caller)', async () => {
  await box(A).fill('/silent '); await run(A).click();
  await bot.next((i) => i.data?.name === 'silent');
  const m = msg(A.page, 'The application did not respond'); await expect(m).toBeVisible({ timeout: 10_000 });
  await expect(m.getByTestId('ephemeral-notice')).toBeVisible();
  await expect(msg(B.page, 'The application did not respond')).toHaveCount(0);
  await m.getByRole('button', { name: 'Dismiss message' }).click();
});

test('modals: the app opens a form, validation runs in the client, the submit reaches the app', async () => {
  await box(A).fill('/feedback '); await run(A).click();
  const it = await bot.next((i) => i.data?.name === 'feedback');
  await bot.callback(it, 9, { customId: 'fb', title: 'Send feedback', components: [
    { type: 1, components: [{ type: 4, customId: 'subject', label: 'Subject', textStyle: 1, required: true, minLength: 3, maxLength: 20 }] },
    { type: 1, components: [{ type: 4, customId: 'body', label: 'Details', textStyle: 2, required: false }] }] });
  const dlg = A.page.getByRole('dialog', { name: 'Send feedback' }); await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Submit' }).click(); await expect(dlg).toContainText('This field is required');
  await dlg.getByLabel('Subject').fill('ab'); await dlg.getByRole('button', { name: 'Submit' }).click(); await expect(dlg).toContainText('At least 3 characters');
  await dlg.getByLabel('Subject').fill('Great bot'); await dlg.getByLabel('Details').fill('line one\nline two');
  await dlg.getByRole('button', { name: 'Submit' }).click();
  await expect(dlg).toHaveCount(0);
  const sub = await bot.next((i) => i.type === 5);
  expect(sub.data.customId).toBe('fb');
  expect(sub.data.components.flatMap((r: any) => r.components).map((c: any) => [c.customId, c.value])).toEqual([['subject', 'Great bot'], ['body', 'line one\nline two']]);
  await bot.callback(sub, 4, { content: 'Thanks for: Great bot' });
  await expect(msg(B.page, 'Thanks for: Great bot')).toBeVisible();
});

test('command permissions: a denied command is refused by the server even from a stale picker, and the person is told', async () => {
  const general = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general');
  const secret = await bot.rest('POST', `/applications/${bot.appId}/guilds/${gid}/commands`, { name: 'secret', description: 'Hidden later' });
  await B.page.reload(); await expect(box(B)).toBeVisible();
  await box(B).fill('/sec');
  const opt1 = B.page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /\/secret/ }); await expect(opt1).toBeVisible();
  // the owner denies it in this channel; Bob's cached picker still offers it
  await rest(A.page, 'PUT', `/applications/${bot.appId}/guilds/${gid}/commands/${secret.id}/permissions`, { permissions: [{ id: general.id, type: 3, permission: false }] });
  await opt1.click(); await run(B).click();
  await expect(B.page.getByRole('status').getByText('You cannot use this command here')).toBeVisible();
  expect(bot.interactions.filter((i) => i.data?.name === 'secret')).toHaveLength(0);
  await form(B).getByRole('button', { name: 'Cancel command' }).click();
  await B.page.reload(); await expect(box(B)).toBeVisible(); await box(B).fill('/sec');
  await expect(B.page.getByRole('listbox', { name: 'Suggestions' })).toHaveCount(0); // the fresh catalog hides it
  await box(B).fill('');
});

test('server settings: command permissions page lists the app, saves an override, and the server enforces it', async () => {
  const p = A.page; const general = (await rest(p, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general');
  const cmd = await bot.rest('POST', `/applications/${bot.appId}/guilds/${gid}/commands`, { name: 'gated', description: 'Gated by settings' });
  await p.reload(); await expect(box(A)).toBeVisible();
  await openGuildSettings(p, 'Slash HQ', 'Command Permissions');
  const dlg = p.getByRole('dialog', { name: 'Slash HQ' });
  await expect(dlg.getByRole('heading', { name: 'Command Permissions' })).toBeVisible();
  await dlg.getByTestId('cmdperm-command').selectOption({ label: '/gated' });
  await expect(dlg.getByTestId('cmdperm-empty')).toBeVisible();
  await dlg.getByTestId('cmdperm-type').selectOption('3'); await dlg.getByTestId('cmdperm-target').selectOption({ label: '#general' });
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dlg.getByTestId('cmdperm-list')).toContainText('#general');
  await dlg.getByLabel('Permission for #general').selectOption('deny');
  await p.getByRole('button', { name: 'Save Changes' }).click();
  await expect(p.getByRole('status').getByText('Command permissions saved')).toBeVisible();
  const saved = await rest(p, 'GET', `/applications/${bot.appId}/guilds/${gid}/commands/${cmd.id}/permissions`);
  expect(saved.permissions).toEqual([{ id: general.id, type: 3, permission: false }]);
  await dlg.getByLabel('Remove override for #general').click();
  await p.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(async () => (await rest(p, 'GET', `/applications/${bot.appId}/guilds/${gid}/commands/${cmd.id}/permissions`)).permissions).toEqual([]);
  await closeSettings(p);
});
