import { test, expect, type Page } from '@playwright/test';
import { newUser, createServer, makeInvite, joinViaInvite, rest, guildId, msg, sendMessage, clickMenu, type User } from './helpers';

let A: User, B: User, gid: string, general: string;
test.describe.configure({ mode: 'serial' });
const nav = (p: Page) => p.getByRole('navigation', { name: 'Channels' });
const chan = (p: Page, name: string) => nav(p).getByRole('button', { name, exact: true });
const channelId = async (p: Page, name: string) => (await rest(p, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === name)?.id as string;
const local = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const inDays = (days: number, hour = 18) => { const d = new Date(Date.now() + days * 86_400_000); d.setHours(hour, 0, 0, 0); return d; };

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob');
  await createServer(A.page, 'Community HQ'); gid = await guildId(A.page);
  await joinViaInvite(B.page, await makeInvite(A.page));
  general = await channelId(A.page, 'general');
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Town Hall', type: 'stage' });
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Lounge', type: 'voice' });
  for (const u of [A, B]) await u.page.reload();
});
test.afterAll(async () => { await A?.ctx.close(); await B?.ctx.close(); });

/* ---------------------------------------------------------------- scheduled events */
test('scheduled events: create an external event, list it live for others, mark interest', async () => {
  const entry = (p: Page) => p.getByTestId('events-entry');
  await expect(entry(A.page)).toHaveText('Events'); await expect(entry(B.page)).toHaveCount(0); // Bob cannot create events and none exist yet
  await entry(A.page).click();
  const list = A.page.getByRole('dialog', { name: 'Events' });
  await expect(list).toContainText('There are no upcoming events');
  await list.getByRole('button', { name: 'Create Event' }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Create Event' });
  // validation first
  await dlg.getByLabel('Event Topic').fill('Picnic'); await dlg.getByLabel('Start Date').fill(local(new Date(Date.now() - 3600_000)));
  await dlg.getByRole('radio').nth(2).check();
  await dlg.getByLabel('Location').fill('Town square'); await dlg.getByLabel('End Date').fill(local(inDays(1, 20)));
  await dlg.getByRole('button', { name: 'Create Event' }).click(); await expect(dlg).toContainText('The start time must be in the future');
  await dlg.getByLabel('Start Date').fill(local(inDays(1, 18)));
  await dlg.getByLabel('End Date').fill(''); await dlg.getByRole('button', { name: 'Create Event' }).click(); await expect(dlg).toContainText('External events need an end time');
  await dlg.getByLabel('End Date').fill(local(inDays(1, 20)));
  await dlg.getByLabel('Description').fill('Bring snacks');
  await dlg.getByRole('button', { name: 'Create Event' }).click();
  const card = A.page.locator('[data-event]').filter({ hasText: 'Picnic' });
  await expect(card).toBeVisible(); await expect(card).toContainText('Town square'); await expect(card).toContainText('Bring snacks'); await expect(card).toContainText('Tomorrow at');
  await A.page.keyboard.press('Escape');
  await expect(entry(A.page)).toHaveText('1 Event');
  await expect(entry(B.page)).toHaveText('1 Event');                      // GUILD_SCHEDULED_EVENT_CREATE
  await entry(B.page).click();
  const bcard = B.page.locator('[data-event]').filter({ hasText: 'Picnic' });
  await expect(bcard).toContainText('0 interested');
  await expect(bcard.getByRole('button', { name: /Start Event|Edit/ })).toHaveCount(0);  // no manage rights
  await bcard.getByRole('button', { name: 'Interested', exact: true }).click();
  await expect(bcard.getByTestId('event-interested')).toContainText('1 interested');
  await expect(bcard.getByRole('button', { name: /Interested ✓/ })).toHaveAttribute('aria-pressed', 'true');
  await entry(A.page).click();
  await expect(A.page.locator('[data-event]').filter({ hasText: 'Picnic' }).getByTestId('event-interested')).toContainText('1 interested'); // USER_ADD reached the owner
  await A.page.keyboard.press('Escape'); await B.page.keyboard.press('Escape');
  // persisted for Bob
  await B.page.reload(); await entry(B.page).click();
  await expect(B.page.locator('[data-event]').filter({ hasText: 'Picnic' }).getByRole('button', { name: /Interested ✓/ })).toBeVisible();
  await B.page.locator('[data-event]').filter({ hasText: 'Picnic' }).getByRole('button', { name: /Interested ✓/ }).click();
  await expect(B.page.locator('[data-event]').filter({ hasText: 'Picnic' }).getByTestId('event-interested')).toContainText('0 interested');
  await B.page.keyboard.press('Escape');
});

test('scheduled events: voice event, start/end lifecycle shows LIVE, cancel removes it for everyone', async () => {
  await A.page.getByTestId('events-entry').click();
  await A.page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: 'Create Event' }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Create Event' });
  await expect(dlg.getByLabel('Channel', { exact: true })).toContainText('General'); // first voice channel
  await dlg.getByLabel('Channel', { exact: true }).selectOption({ label: 'Lounge' });
  await dlg.getByLabel('Event Topic').fill('Game night'); await dlg.getByLabel('Start Date').fill(local(inDays(2, 21)));
  await dlg.getByRole('button', { name: 'Create Event' }).click();
  const card = A.page.locator('[data-event]').filter({ hasText: 'Game night' });
  await expect(card).toContainText('Lounge');
  await expect(A.page.locator('[data-event]')).toHaveCount(2);
  expect((await rest(A.page, 'GET', `/guilds/${gid}/scheduled-events`)).map((e: any) => e.name).sort()).toEqual(['Game night', 'Picnic']);
  await card.getByRole('button', { name: 'Start Event' }).click();
  await expect(card.getByTestId('event-live')).toBeVisible();
  await expect(A.page.getByTestId('events-entry').getByLabel('Live')).toBeVisible();
  await expect(B.page.getByTestId('events-entry').getByLabel('Live')).toBeVisible();
  await card.getByRole('button', { name: 'End Event' }).click();
  await expect(A.page.locator('[data-event]').filter({ hasText: 'Game night' })).toHaveCount(0);
  await expect(B.page.getByTestId('events-entry')).toHaveText('1 Event');
  // cancel Picnic
  await A.page.getByRole('button', { name: 'Cancel Picnic' }).click(); await A.page.getByRole('button', { name: 'Cancel event' }).click();
  await expect(A.page.locator('[data-event]')).toHaveCount(0);
  await expect(B.page.getByTestId('events-entry')).toHaveCount(0);
  await A.page.keyboard.press('Escape');
  const logs = (await rest(A.page, 'GET', `/guilds/${gid}/audit-logs?limit=100`)).map((e: any) => e.action);
  expect(logs).toEqual(expect.arrayContaining(['GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE']));
});

/* ---------------------------------------------------------------- stage topic */
test('stage: moderators start it with a topic, everyone sees it live, topic edit, end', async () => {
  await chan(A.page, 'Town Hall').click();
  const bar = A.page.getByTestId('stage-bar');
  await expect(bar).toContainText('This stage is not live yet.');
  await chan(B.page, 'Town Hall').click();
  await expect(B.page.getByTestId('stage-bar')).toContainText('not live yet'); await expect(B.page.getByTestId('stage-bar').getByRole('button')).toHaveCount(0); // no moderation rights
  await bar.getByRole('button', { name: 'Start Stage' }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Start Stage' });
  await expect(dlg.getByRole('button', { name: 'Start Stage' })).toBeDisabled();
  await dlg.getByLabel('Stage Topic').fill('Roadmap AMA'); await dlg.getByRole('button', { name: 'Start Stage' }).click();
  for (const u of [A, B]) { await expect(u.page.getByTestId('stage-topic')).toHaveText('Roadmap AMA'); await expect(u.page.getByTestId('stage-bar')).toContainText('Live'); }
  await expect(A.page.getByTestId('stage-bar').getByRole('button', { name: 'Edit topic' })).toBeVisible();
  await expect(nav(B.page).getByTestId('stage-live')).toContainText('Roadmap AMA'); // sidebar marker
  // a second start is refused by the server
  const dup = await rest(A.page, 'POST', '/stage-instances', { channelId: await channelId(A.page, 'Town Hall'), topic: 'again' }).catch((e: Error) => e.message);
  expect(String(dup)).toContain('409');
  await A.page.getByRole('button', { name: 'Edit topic' }).click();
  const edit = A.page.getByRole('dialog', { name: 'Edit Stage Topic' }); await expect(edit.getByLabel('Stage Topic')).toHaveValue('Roadmap AMA');
  await edit.getByLabel('Stage Topic').fill('Roadmap AMA (part 2)'); await edit.getByRole('button', { name: 'Save' }).click();
  await expect(B.page.getByTestId('stage-topic')).toHaveText('Roadmap AMA (part 2)');
  await B.page.reload(); await expect(B.page.getByTestId('stage-topic')).toHaveText('Roadmap AMA (part 2)'); // loaded from the API, not just events
  await A.page.getByTestId('stage-bar').getByRole('button', { name: 'End Stage' }).click();
  await A.page.getByRole('dialog').getByRole('button', { name: 'End stage' }).click();
  for (const u of [A, B]) await expect(u.page.getByTestId('stage-bar')).toContainText('not live yet');
  await expect(nav(B.page).getByTestId('stage-live')).toHaveCount(0);
  const audit = (await rest(A.page, 'GET', `/guilds/${gid}/audit-logs?limit=100`)).map((e: any) => e.action);
  expect(audit).toEqual(expect.arrayContaining(['STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE']));
  for (const u of [A, B]) { const d = u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }); if (await d.isVisible().catch(() => false)) await d.click(); }
});

/* ---------------------------------------------------------------- voice channel text chat */
test('voice-channel chat: a side panel with the same composer, live for everyone in the channel', async () => {
  await chan(A.page, 'Lounge').click(); await expect(A.page.getByTestId('voice-view')).toBeVisible();
  await chan(B.page, 'Lounge').click(); await expect(B.page.getByTestId('voice-view')).toBeVisible();
  await expect(A.page.getByTestId('voice-chat')).toHaveCount(0);
  await A.page.getByRole('button', { name: 'Show Chat' }).click();
  const panel = A.page.getByTestId('voice-chat'); await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Message #Lounge' })).toBeVisible();
  await sendMessage(A.page, 'anyone hear the music?');
  await expect(msg(A.page, 'anyone hear the music?')).toBeVisible();
  await B.page.getByRole('button', { name: 'Show Chat' }).click();
  await expect(msg(B.page, 'anyone hear the music?')).toBeVisible();
  await sendMessage(B.page, 'loud and clear');
  await expect(msg(A.page, 'loud and clear')).toBeVisible();
  // the call keeps working next to the chat
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  await A.page.getByRole('button', { name: 'Hide Chat' }).first().click(); await expect(A.page.getByTestId('voice-chat')).toHaveCount(0);
  // history is plain channel history
  const hist = await rest(A.page, 'GET', `/channels/${await channelId(A.page, 'Lounge')}/messages`);
  expect(hist.map((m: any) => m.content)).toEqual(expect.arrayContaining(['anyone hear the music?', 'loud and clear']));
  // deny SEND_MESSAGES in the voice channel: the composer is disabled but the panel still reads
  await rest(A.page, 'PUT', `/channels/${await channelId(A.page, 'Lounge')}/permissions/${gid}`, { type: 'role', allow: '0', deny: (1n << 11n).toString() });
  await expect(B.page.getByTestId('voice-chat').getByRole('textbox')).toBeDisabled();
  await rest(A.page, 'DELETE', `/channels/${await channelId(A.page, 'Lounge')}/permissions/${gid}`);
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  void clickMenu;
});
