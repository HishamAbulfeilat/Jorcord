/**
 * Captures desktop + mobile screenshots of the REAL running app (real server, real LiveKit, fake media devices).
 * Output: e2e/screenshots/*.png  (run alone: pnpm e2e -- screenshots)
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newUser, createServer, makeInvite, joinViaInvite, sendMessage, msg, rest, guildId, PNG, openGuildSettings, openUserSettings, type User } from './helpers';
import { Bot } from './bot';

const OUT = fileURLToPath(new URL('../screenshots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png` });
const voiceBtn = (p: Page, name = 'General') => p.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name, exact: true });

let A: User, B: User, M: User, gid: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  A = await newUser(browser, 'Alice'); B = await newUser(browser, 'Bob'); M = await newUser(browser, 'Mia', { mobile: true });
  await createServer(A.page, 'Jorcord HQ');
  gid = await guildId(A.page);
  const inv = await makeInvite(A.page);
  await joinViaInvite(B.page, inv); await joinViaInvite(M.page, inv);
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Town Hall', type: 'stage' });
});
test.afterAll(async () => { for (const u of [A, B, M]) await u?.ctx.close(); });

test('chat screenshots', async () => {
  await voiceBtn(A.page, 'general').click(); await voiceBtn(B.page, 'general').click();
  await sendMessage(A.page, 'Welcome to **Jorcord HQ**! Try `code`, ~~strike~~ and ||spoilers||.');
  await sendMessage(B.page, 'Looks great :tada: any plans for the stream tonight?');
  await A.page.locator('input[type=file]').first().setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  const box = A.page.getByRole('textbox', { name: /^Message/ }); await box.fill('here is a picture'); await box.press('Enter');
  await expect(msg(B.page, 'here is a picture')).toBeVisible();
  const m = msg(A.page, 'Looks great'); await m.hover(); await m.getByRole('button', { name: 'Add Reaction' }).click();
  await A.page.getByRole('dialog', { name: 'Emoji picker' }).getByRole('gridcell').nth(2).click();
  await A.page.mouse.move(700, 700);
  await shot(A.page, 'desktop-chat');
  await expect(M.page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await shot(M.page, 'mobile-chat');
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.waitForTimeout(400);
  await shot(M.page, 'mobile-drawer');
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
});

test('voice screenshots', async () => {
  await voiceBtn(A.page).click();
  await shot(A.page, 'desktop-voice-connected-alone');
  await voiceBtn(B.page).click();
  await expect(A.page.getByTestId('voice-tile')).toHaveCount(2);
  await B.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Turn On Camera' }).click();
  await A.page.waitForTimeout(2500);
  await shot(A.page, 'desktop-voice-camera-grid');
  // mobile joins too
  await M.page.getByRole('button', { name: 'Open navigation' }).click();
  await voiceBtn(M.page).click();
  await expect(M.page.getByTestId('voice-tile')).toHaveCount(3);
  await M.page.waitForTimeout(2500);
  await shot(M.page, 'mobile-voice-call');
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Voice Settings' }).click();
  await A.page.waitForTimeout(500);
  await shot(A.page, 'desktop-voice-settings');
  await A.page.keyboard.press('Escape');
  // screen share with quality picker
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stream quality options' }).click();
  await A.page.getByRole('radio', { name: '1440p 60fps' }).check();
  await shot(A.page, 'desktop-share-picker');
  await A.page.getByRole('button', { name: 'Go Live' }).click();
  await expect(B.page.getByTestId('screen-tile')).toBeVisible();
  await B.page.getByLabel('Viewing quality').selectOption('high');
  await B.page.waitForTimeout(3000);
  await B.page.getByTestId('screen-tile').hover();
  await B.page.getByRole('button', { name: 'Stream stats' }).click();
  await B.page.waitForTimeout(1500);
  await shot(B.page, 'desktop-screenshare-spotlight-stats');
  await shot(M.page, 'mobile-voice-with-stream');
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Stop Streaming' }).click();
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.waitForTimeout(400);
  await shot(M.page, 'mobile-drawer-voice-dock');
  await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Disconnect' }).first().click();
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('stage screenshots', async () => {
  await voiceBtn(A.page, 'Town Hall').click();
  await expect(A.page.getByTestId('stage')).toBeVisible();
  await voiceBtn(B.page, 'Town Hall').click();
  await expect(B.page.getByTestId('stage')).toBeVisible();
  await expect(A.page.getByTestId('stage')).toContainText('Audience');
  await B.page.waitForTimeout(800);
  await shot(A.page, 'desktop-stage'); await shot(B.page, 'desktop-stage-audience');
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
});

test('misc screenshots', async () => {
  await A.page.getByRole('button', { name: 'User Settings' }).click();
  await A.page.getByRole('tab', { name: 'Voice & Video' }).or(A.page.getByRole('button', { name: 'Voice & Video' })).first().click();
  await A.page.waitForTimeout(400);
  await shot(A.page, 'desktop-settings-voice');
  await A.page.keyboard.press('Escape');
  await A.page.getByRole('button', { name: 'Direct Messages' }).click();
  await shot(A.page, 'desktop-friends');
  await shot(M.page, 'mobile-friends');
});

/* ---------------------------------------------------------------- platform pass screens */
const local = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

test('platform screenshots: slash commands, components, polls, events', async () => {
  const bot = await Bot.create(A.page, 'Dicebot'); await bot.connect(); await bot.install(A.page, gid);
  await bot.rest('PUT', `/applications/${bot.appId}/commands`, [
    { name: 'ping', description: 'Check the bot is alive' },
    { name: 'roll', description: 'Roll a die', options: [{ type: 4, name: 'sides', description: 'How many sides', required: true, minValue: 2, maxValue: 100 }, { type: 3, name: 'mode', description: 'How to roll', choices: [{ name: 'Fast', value: 'fast' }, { name: 'Careful', value: 'careful' }] }, { type: 5, name: 'secret', description: 'Hide the result' }] },
    { name: 'poll', description: 'Start a poll' }, { name: 'whisper', description: 'Only you hear it' },
  ]);
  for (const u of [A, B]) await u.page.goto(`/channels/${gid}`);
  await voiceBtn(A.page, 'general').click(); await voiceBtn(B.page, 'general').click();
  // slash picker + option form
  const box = A.page.getByRole('textbox', { name: /^Message/ });
  await box.click(); await box.pressSequentially('/'); await expect(A.page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible(); await A.page.waitForTimeout(300);
  await shot(A.page, 'desktop-slash-picker');
  await box.fill('/roll '); await expect(A.page.getByTestId('slash-form')).toBeVisible();
  await A.page.getByTestId('slash-form').getByLabel('sides', { exact: true }).fill('20'); await A.page.waitForTimeout(200);
  await shot(A.page, 'desktop-slash-form');
  await A.page.getByRole('button', { name: 'Run command' }).click();
  const it = await bot.next((i) => i.data?.name === 'roll');
  await bot.callback(it, 4, { content: 'You rolled a **17** on a d20!', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Roll again', customId: 'again' }, { type: 2, style: 3, label: 'Keep', customId: 'keep' }, { type: 2, style: 4, label: 'Discard', customId: 'discard' }, { type: 2, style: 5, label: 'Rules', url: 'https://example.test/rules' }] }, { type: 1, components: [{ type: 3, customId: 'pick', placeholder: 'Choose a die', options: [{ label: 'd6', value: '6' }, { label: 'd20', value: '20' }] }] }] });
  await expect(msg(B.page, 'You rolled')).toBeVisible();
  await box.fill('/whisper '); await A.page.getByRole('button', { name: 'Run command' }).click();
  const w = await bot.next((i) => i.data?.name === 'whisper'); await bot.callback(w, 4, { content: 'Psst: the dice are loaded.', flags: 64 });
  await expect(msg(A.page, 'Psst')).toBeVisible();
  await rest(B.page, 'POST', `/channels/${(await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'general').id}/messages`, { content: '', poll: { question: 'Which die should we use tonight?', answers: [{ text: 'd6', emoji: '🎲' }, { text: 'd20' }, { text: 'd100' }], durationHours: 24, allowMultiselect: false } });
  const poll = A.page.getByTestId('poll'); await expect(poll).toBeVisible();
  await poll.getByRole('radio', { name: /d20/ }).click(); await poll.getByRole('button', { name: 'Vote', exact: true }).click();
  await B.page.getByTestId('poll').getByRole('radio', { name: /d6/ }).click(); await B.page.getByTestId('poll').getByRole('button', { name: 'Vote', exact: true }).click();
  await expect(poll.getByTestId('answer-count').first()).toContainText('1'); await A.page.mouse.move(700, 120); await A.page.waitForTimeout(400);
  await shot(A.page, 'desktop-chat-bot-poll');
  // mobile view of the same channel
  await M.page.goto(`/channels/${gid}`);
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'general', exact: true }).click();
  await expect(M.page.getByTestId('poll')).toBeVisible(); await M.page.waitForTimeout(500);
  await shot(M.page, 'mobile-chat-bot-poll');
  const mbox = M.page.getByRole('textbox', { name: /^Message/ }); await mbox.click(); await M.page.waitForTimeout(1200); await mbox.fill('/roll '); await expect(M.page.getByTestId('slash-form')).toBeVisible(); await M.page.waitForTimeout(300);
  await shot(M.page, 'mobile-slash-form'); await M.page.getByRole('button', { name: 'Cancel command' }).click();
  // events
  await rest(A.page, 'POST', `/guilds/${gid}/scheduled-events`, { name: 'Community game night', description: 'Bring your favourite board game and snacks.', entityType: 3, location: 'Main hall, 2nd floor', scheduledStartTime: new Date(Date.now() + 26 * 3600_000).toISOString(), scheduledEndTime: new Date(Date.now() + 29 * 3600_000).toISOString() });
  const lounge = await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'Lounge', type: 'voice' });
  await rest(A.page, 'POST', `/guilds/${gid}/scheduled-events`, { name: 'Release party', entityType: 2, channelId: lounge.id, scheduledStartTime: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  await expect(A.page.getByTestId('events-entry')).toContainText('2 Events');
  await B.page.getByTestId('events-entry').click(); await B.page.locator('[data-event]').first().getByRole('button', { name: 'Interested', exact: true }).click(); await B.page.keyboard.press('Escape');
  await A.page.getByTestId('events-entry').click(); await A.page.waitForTimeout(400); await shot(A.page, 'desktop-events');
  await A.page.getByRole('button', { name: 'Create Event' }).click(); await A.page.getByLabel('Event Topic').fill('Spring cleanup'); await A.page.waitForTimeout(300);
  await shot(A.page, 'desktop-event-editor'); await A.page.keyboard.press('Escape');
  await M.page.getByRole('button', { name: 'Open navigation' }).click(); await M.page.getByTestId('events-entry').click(); await M.page.waitForTimeout(500); await shot(M.page, 'mobile-events'); await M.page.keyboard.press('Escape');
  bot.close(); void local;
});

test('platform screenshots: voice chat panel, stage topic, forum tags', async () => {
  const lounge = await voiceBtn(A.page, 'Lounge');
  await rest(A.page, 'POST', `/guilds/${gid}/channels`, { name: 'support', type: 'forum' });
  await lounge.click(); await expect(A.page.getByTestId('voice-view')).toBeVisible();
  await voiceBtn(B.page, 'Lounge').click(); await expect(B.page.getByTestId('voice-tile')).toHaveCount(2);
  await A.page.getByRole('button', { name: 'Show Chat' }).click(); await sendMessage(A.page, 'Can everyone hear the music?');
  await B.page.getByRole('button', { name: 'Show Chat' }).click(); await sendMessage(B.page, 'Loud and clear!');
  await expect(msg(A.page, 'Loud and clear!')).toBeVisible(); await A.page.waitForTimeout(800);
  await shot(A.page, 'desktop-voice-chat');
  await M.page.goto(`/channels/${gid}`); await M.page.getByRole('button', { name: 'Open navigation' }).click(); await voiceBtn(M.page, 'Lounge').click(); await expect(M.page.getByTestId('voice-tile')).toHaveCount(3);
  await M.page.getByRole('button', { name: 'Show Chat' }).click(); await M.page.waitForTimeout(800); await shot(M.page, 'mobile-voice-chat');
  await M.page.getByRole('button', { name: 'Hide Chat' }).first().click(); await M.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  for (const u of [A, B]) await u.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  // stage with a topic
  await voiceBtn(A.page, 'Town Hall').click(); await A.page.getByRole('button', { name: 'Start Stage' }).first().click();
  await A.page.getByLabel('Stage Topic').fill('Roadmap AMA: what is coming this quarter'); await A.page.getByRole('dialog').getByRole('button', { name: 'Start Stage' }).click();
  await expect(A.page.getByTestId('stage-topic')).toBeVisible(); await A.page.waitForTimeout(600);
  await shot(A.page, 'desktop-stage-live-topic');
  await A.page.getByRole('button', { name: 'End Stage' }).click(); await A.page.getByRole('dialog').getByRole('button', { name: 'End stage' }).click();
  await A.page.getByTestId('voice-view').getByRole('button', { name: 'Disconnect' }).click();
  // forum tags
  const forum = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.name === 'support');
  await rest(A.page, 'PATCH', `/channels/${forum.id}`, { availableTags: [{ name: 'Question', emoji: '❓', moderated: false }, { name: 'Bug', emoji: '🐛', moderated: true }, { name: 'Idea', emoji: '💡', moderated: false }], requireTag: true });
  const tags = (await rest(A.page, 'GET', `/guilds/${gid}/channels`)).find((c: any) => c.id === forum.id).availableTags;
  await rest(A.page, 'POST', `/channels/${forum.id}/forum/posts`, { name: 'How do I reset my password?', content: 'I forgot it.', appliedTags: [tags[0].id] });
  await rest(A.page, 'POST', `/channels/${forum.id}/forum/posts`, { name: 'Crash when joining a stage', content: 'Stack trace attached.', appliedTags: [tags[1].id] });
  await rest(A.page, 'POST', `/channels/${forum.id}/forum/posts`, { name: 'Add dark-mode scheduling', content: 'Please!', appliedTags: [tags[2].id, tags[0].id] });
  await voiceBtn(A.page, 'support').click(); await expect(A.page.getByTestId('post-tags')).toHaveCount(3); await A.page.waitForTimeout(500);
  await shot(A.page, 'desktop-forum-tags');
  await A.page.getByRole('button', { name: 'New Post' }).click(); await A.page.waitForTimeout(400); await shot(A.page, 'desktop-forum-new-post'); await A.page.keyboard.press('Escape');
});

test('platform screenshots: developer portal, authorize page, settings', async () => {
  const bot = await Bot.create(A.page, 'Dicebot', { redirectUris: ['https://dicebot.example.com/callback'] });
  await bot.rest('PUT', `/applications/${bot.appId}/commands`, [{ name: 'roll', description: 'Roll a die', options: [{ type: 4, name: 'sides', description: 'How many sides', required: true }] }, { name: 'ping', description: 'Check the bot is alive' }]);
  await bot.install(A.page, gid);
  await A.page.goto('/developers'); await expect(A.page.locator(`[data-app="${bot.appId}"]`)).toBeVisible(); await A.page.waitForTimeout(400); await shot(A.page, 'desktop-developer-portal');
  await A.page.getByRole('button', { name: 'New Application' }).click(); await A.page.getByLabel('Name').fill('Weather Bot'); await A.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(A.page.getByTestId('bot-token')).toBeVisible(); await A.page.waitForTimeout(400); await shot(A.page, 'desktop-developer-app-token');
  await A.page.goto(`/developers/${bot.appId}/oauth2`); await A.page.getByLabel('Send Messages', { exact: true }).check(); await A.page.getByLabel('Create Polls').check(); await A.page.waitForTimeout(400);
  await A.page.getByTestId('generated-url').scrollIntoViewIfNeeded(); await shot(A.page, 'desktop-developer-oauth');
  await A.page.goto(`/developers/${bot.appId}/commands`); await expect(A.page.locator('[data-command]').first()).toBeVisible(); await shot(A.page, 'desktop-developer-commands');
  const bits = ((1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 41n)).toString();
  await A.page.goto(`/oauth2/authorize?client_id=${bot.appId}&scope=bot%20applications.commands&permissions=${bits}`); await expect(A.page.getByTestId('oauth-title')).toBeVisible(); await A.page.waitForTimeout(400);
  await shot(A.page, 'desktop-oauth-authorize');
  await M.page.goto('/developers'); await expect(M.page.getByTestId('dev-portal')).toBeVisible(); await M.page.waitForTimeout(500); await shot(M.page, 'mobile-developer-portal');
  await M.page.goto(`/oauth2/authorize?client_id=${bot.appId}&scope=bot%20applications.commands&permissions=${bits}`); await expect(M.page.getByTestId('oauth-title')).toBeVisible(); await M.page.waitForTimeout(500); await shot(M.page, 'mobile-oauth-authorize');
  await A.page.goto(`/channels/${gid}`); await A.page.waitForTimeout(500);
  await openUserSettings(A.page, 'Profile'); await A.page.getByRole('radio', { name: 'Dusk' }).click(); await A.page.waitForTimeout(300); await shot(A.page, 'desktop-settings-profile-gradient'); await A.page.getByRole('button', { name: 'Save Changes' }).click(); await A.page.keyboard.press('Escape');
  await openGuildSettings(A.page, 'Jorcord HQ', 'Audit Log'); await A.page.waitForTimeout(600); await shot(A.page, 'desktop-settings-audit-log'); await A.page.keyboard.press('Escape');
  bot.close();
});
