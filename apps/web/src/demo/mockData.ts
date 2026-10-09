/** Static mock dataset for the /demo route (no server needed). */
import { Perm, DEFAULT_EVERYONE, snowflake } from '@jorcord/shared';
import type { Channel, GuildFull, Member, Message, Presence, ReadyPayload, Role, User, Embed, Attachment } from '@jorcord/shared';

const NOW = Date.now();
const ago = (min: number) => snowflake(NOW - min * 60_000);
const iso = (min: number) => new Date(NOW - min * 60_000).toISOString();
const svg = (w: number, h: number, a: string, b: string, label = '') => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${h * 0.3}" r="${h * 0.12}" fill="rgba(255,255,255,.55)"/><path d="M0 ${h} L${w * 0.35} ${h * 0.55} L${w * 0.55} ${h * 0.8} L${w * 0.75} ${h * 0.5} L${w} ${h} Z" fill="rgba(0,0,0,.28)"/><text x="16" y="${h - 16}" font-family="sans-serif" font-size="22" fill="#fff">${label}</text></svg>`)}`;
const letter = (a: string, b: string, l: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><text x="64" y="86" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="70" fill="#fff">${l}</text></svg>`)}`;
const avatar = (c: string, l: string) => svg(128, 128, c, '#222', l).replace('font-size%3D%2222%22', 'font-size%3D%2260%22');

const mk = (id: string, username: string, displayName: string | null, extra: Partial<User> = {}): User => ({ id, username, displayName, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: iso(60 * 24 * 200), ...extra });

export const ME = { ...mk('1001', 'hisham', 'Hisham', { bio: 'Building **Jorcord**. Coffee, code, and *questionable* puns.', pronouns: 'he/him', accentColor: '#5865f2', customStatus: { text: 'Shipping the web client', emoji: null } }), email: 'hisham@example.com', mfaEnabled: false, verified: true, theme: 'dark' as const, settings: {} };
const alice = mk('1002', 'alice', 'Alice Chen', { bio: 'Designer. Pixel pusher.', pronouns: 'she/her' });
const bob = mk('1003', 'bobby', 'Bob', { customStatus: { text: 'In a meeting', emoji: null } });
const charlie = mk('1004', 'charlie', 'Charlie');
const dana = mk('1005', 'dana_dev', 'Dana');
const eve = mk('1006', 'eve', 'Eve');
const frank = mk('1007', 'frank', 'Frank');
const grace = mk('1008', 'grace', 'Grace Hopper');
const heidi = mk('1009', 'heidi', null);
const bot = mk('1010', 'jorbot', 'Jorbot', { bot: true });
const ivan = mk('1011', 'ivan', 'Ivan');
const judy = mk('1012', 'judy', 'Judy');
const users = [ME as User, alice, bob, charlie, dana, eve, frank, grace, heidi, bot, ivan, judy];

const presences: Record<string, Presence> = { '1001': 'online', '1002': 'online', '1003': 'dnd', '1004': 'idle', '1005': 'online', '1006': 'offline', '1007': 'online', '1008': 'idle', '1009': 'offline', '1010': 'online', '1011': 'offline', '1012': 'online' };

const roleMk = (id: string, gid: string, name: string, color: number, position: number, perms: bigint, hoist = false): Role => ({ id, guildId: gid, name, color, hoist, position, permissions: perms.toString(), mentionable: true, icon: null });
const ALL = Object.values(Perm).reduce((a, b) => a | b, 0n);
const mem = (gid: string, u: User, roles: string[], nick: string | null = null): Member => ({ guildId: gid, user: u, nick, roles, joinedAt: iso(60 * 24 * 120), timeoutUntil: null });
const ch = (id: string, gid: string | null, type: Channel['type'], name: string | null, position: number, parentId: string | null = null, extra: Partial<Channel> = {}): Channel => ({ id, guildId: gid, type, name, topic: null, position, parentId, nsfw: false, slowmode: 0, bitrate: null, userLimit: null, overwrites: [], lastMessageId: null, createdAt: iso(60 * 24 * 90), ...extra });

const G1 = '2001';
const emoji1 = { id: '9001', guildId: G1, name: 'jorcat', animated: false, url: svg(64, 64, '#f6c177', '#eb6f92', '😺') };
const emoji2 = { id: '9002', guildId: G1, name: 'ship_it', animated: false, url: svg(64, 64, '#3e8fb0', '#9ccfd8', '🚀') };

const g1Roles = [
  roleMk(G1, G1, '@everyone', 0, 0, DEFAULT_EVERYONE),
  roleMk('3001', G1, 'Admin', 0xed4245, 40, ALL, true), roleMk('3002', G1, 'Moderator', 0x2ecc71, 30, Perm.KICK_MEMBERS | Perm.MANAGE_MESSAGES | Perm.MODERATE_MEMBERS | DEFAULT_EVERYONE, true),
  roleMk('3003', G1, 'Developers', 0x3498db, 20, DEFAULT_EVERYONE | Perm.MANAGE_THREADS, true), roleMk('3004', G1, 'Designers', 0xe91e63, 10, DEFAULT_EVERYONE),
];
const g1Members = [mem(G1, ME as User, ['3001']), mem(G1, alice, ['3004', '3003'], 'Alice ✨'), mem(G1, bob, ['3002']), mem(G1, charlie, ['3003']), mem(G1, dana, ['3003']), mem(G1, eve, []), mem(G1, frank, []), mem(G1, grace, ['3003']), mem(G1, heidi, []), mem(G1, bot, ['3002']), mem(G1, ivan, []), mem(G1, judy, ['3004'])];
const g1Channels = [
  ch('4001', G1, 'category', 'INFORMATION', 0), ch('4002', G1, 'text', 'welcome', 0, '4001', { topic: 'Say hello and read the rules.' }), ch('4003', G1, 'text', 'rules', 1, '4001', { topic: 'Be excellent to each other.' }), ch('4004', G1, 'announcement', 'announcements', 2, '4001', { topic: 'Release notes and news' }),
  ch('4010', G1, 'category', 'TEXT CHANNELS', 1), ch('4011', G1, 'text', 'general', 0, '4010', { topic: 'General chat for **everyone**. Be kind. https://jorcord.example/guidelines' }), ch('4012', G1, 'text', 'memes', 1, '4010'), ch('4013', G1, 'text', 'dev-talk', 2, '4010', { topic: 'Code, bugs and coffee' }), ch('4014', G1, 'forum', 'showcase', 3, '4010', { topic: 'Show off what you are building' }),
  ch('4020', G1, 'category', 'VOICE CHANNELS', 2), ch('4021', G1, 'voice', 'Lounge', 0, '4020'), ch('4022', G1, 'voice', 'Gaming', 1, '4020'), ch('4023', G1, 'stage', 'Town Hall', 2, '4020'),
  ch('4030', G1, 'thread', 'Release 1.0 planning', 0, '4011', { ownerId: '1005' }), ch('4031', G1, 'thread', 'Dark mode colour bikeshed', 0, '4014', { ownerId: '1002' }), ch('4032', G1, 'thread', 'My PWA experiments', 0, '4014', { ownerId: '1004' }),
];

const mkGuild = (id: string, name: string, desc: string, channels: Channel[], roles: Role[], members: Member[], extra: Partial<GuildFull> = {}): GuildFull => ({
  id, name, icon: null, banner: null, description: desc, ownerId: '1001', systemChannelId: null, rulesChannelId: null, boostLevel: 1, boostCount: 3, features: [], vanityUrl: null, createdAt: iso(60 * 24 * 100), channels, roles, members, emojis: [], stickers: [], memberCount: members.length, ...extra,
});
const G2 = '2002', G3 = '2003', G4 = '2004';
const simple = (gid: string, names: string[]) => [ch(gid + '1', gid, 'category', 'TEXT', 0), ...names.map((n, i) => ch(gid + '2' + i, gid, 'text', n, i, gid + '1')), ch(gid + '90', gid, 'voice', 'Voice', 9, gid + '1')];
const simpleRoles = (gid: string) => [roleMk(gid, gid, '@everyone', 0, 0, DEFAULT_EVERYONE)];
const guilds: GuildFull[] = [
  mkGuild(G1, 'Jorcord HQ', 'The official home of Jorcord.', g1Channels, g1Roles, g1Members, { icon: letter('#5865f2', '#eb459e', 'J'), emojis: [emoji1, emoji2], boostCount: 9, boostLevel: 2, memberCount: 1284 }),
  mkGuild(G2, 'Pixel Pals', 'Pixel art friends', simple(G2, ['general', 'art-share', 'wip']), simpleRoles(G2), [mem(G2, ME as User, []), mem(G2, alice, [])], { icon: letter('#23a559', '#0b4d2c', 'P') }),
  mkGuild(G3, 'Study Hall', 'Focus together', simple(G3, ['general', 'resources']), simpleRoles(G3), [mem(G3, ME as User, []), mem(G3, bob, [])], { icon: letter('#f0b232', '#a86a00', 'S') }),
  mkGuild(G4, 'Open Source Garden', 'Plant a PR', simple(G4, ['general']), simpleRoles(G4), [mem(G4, ME as User, []), mem(G4, dana, [])]),
];

const DM1 = '5001', DM2 = '5002', DM3 = '5003';
const dms: Channel[] = [
  ch(DM1, null, 'dm', null, 0, null, { recipients: [alice] }), ch(DM2, null, 'dm', null, 0, null, { recipients: [bob] }), ch(DM3, null, 'group_dm', 'Weekend Trip', 0, null, { recipients: [charlie, dana, eve] }),
];

const att = (id: string, name: string, w: number, h: number, a: string, b: string, label: string, spoiler = false): Attachment => ({ id, filename: name, contentType: 'image/svg+xml', size: 48_213, url: svg(w, h, a, b, label), width: w, height: h, spoiler });
const M = (n: number, min: number, channelId: string, author: User, content: string, extra: Partial<Message> = {}): Message => ({
  id: ago(min), channelId, guildId: channelId.startsWith('4') ? G1 : null, author, content, createdAt: iso(min), editedAt: null, type: 'default', replyTo: null, referenced: null, mentions: [], mentionRoles: [], mentionEveryone: false,
  attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...extra,
}) as Message & { __n?: number };

const c = '4011';
const m1 = M(1, 2900, c, alice, 'Morning everyone! :wave: Did anyone see the **new design tokens** land in `main`?');
const m2 = M(2, 2895, c, dana, 'Yep, merged last night. The dark theme finally matches the palette — `#313338` for chat, `#2b2d31` for the sidebar.');
const m3 = M(3, 2894, c, dana, 'Also the AMOLED variant is pure black, so OLED phones will thank us.');
const embed: Embed = { type: 'link', url: 'https://jorcord.example/blog/design-tokens', siteName: 'Jorcord Blog', title: 'How we built our design tokens', description: 'A tour through the colour palette, spacing scale, and the three themes shipping with Jorcord 1.0 — dark, light and AMOLED.', color: 0x5865f2, thumbnail: svg(160, 160, '#5865f2', '#eb459e', 'tokens') };
const m4 = M(4, 1500, c, alice, 'Write-up is live: https://jorcord.example/blog/design-tokens', { embeds: [embed], reactions: [{ emoji: '🔥', emojiId: null, count: 5, me: true }, { emoji: 'jorcat', emojiId: '9001', count: 3, me: false }, { emoji: '👀', emojiId: null, count: 2, me: false }] });
const m5 = M(5, 1490, c, charlie, 'Nice! Quick question — how does the **markdown** renderer handle code?', { replyTo: m4.id, referenced: m4 });
const m6 = M(6, 1488, c, dana, 'Great question. Fenced blocks get syntax highlighting:\n```ts\nexport function greet(name: string): string {\n  // returns a friendly message\n  return `Hello, ${name}!`;\n}\nconsole.log(greet("Jorcord"));\n```\nSupported: *italic*, __underline__, ~~strike~~, ||spoilers||, and > quotes.', { replyTo: m5.id, referenced: m5, editedAt: iso(1480), reactions: [{ emoji: '👍', emojiId: null, count: 4, me: false }] });
const m7 = M(7, 1485, c, dana, '> Premature optimisation is the root of all evil\nStill, virtualised lists are worth it. This channel has **thousands** of messages.', { pinned: true });
const m8 = M(8, 800, c, grace, 'Shared the mockups for the mobile layout. Bottom tab bar + swipe drawers 📱', { attachments: [att('7001', 'mobile-mockup.png', 640, 400, '#3e8fb0', '#6e6a86', 'mobile-mockup.png')], reactions: [{ emoji: '😍', emojiId: null, count: 7, me: true }, { emoji: 'ship_it', emojiId: '9002', count: 2, me: false }] });
const m9 = M(9, 799, c, grace, 'And one with the member list open. ||The spoiler text reveals on click||');
const j1 = M(10, 700, c, eve, '', { type: 'join' });
const m11 = M(11, 690, c, eve, 'Hi all, just joined! Excited to contribute 🎉');
const m12 = M(12, 640, c, bob, `Hey <@1001>, can you review the PR before standup? Timer's set for <t:${Math.floor((NOW + 3600_000) / 1000)}:R>.`, { mentions: ['1001'] });
const m13 = M(13, 100, c, ME as User, 'On it! I\'ll look at it right after lunch. Meanwhile — check the new **channel** <#4013> and the <:jorcat:9001> emoji we added <:ship_it:9002>.', { reactions: [{ emoji: '✅', emojiId: null, count: 1, me: false }] });
const m14 = M(14, 99, c, ME as User, 'Also: ```\nplain code block with no language\n```', {});
const m15 = M(15, 20, c, charlie, 'Ship it! 🚀🚀🚀', {});
const m16 = M(16, 8, c, judy, 'The new icon set looks sharp. Here is a banner I made:', { attachments: [att('7002', 'banner.png', 800, 320, '#eb6f92', '#f6c177', 'banner.png')], threadId: '4030' });
const m17 = M(17, 3, c, bot, 'Build **#482** passed ✅ — 128 tests, 0 failures.', { embeds: [{ type: 'rich', title: 'CI / build', description: 'All checks have passed', color: 0x23a559, fields: [{ name: 'Branch', value: 'main', inline: true }, { name: 'Duration', value: '2m 31s', inline: true }, { name: 'Tests', value: '128 passed', inline: true }], footer: 'Jorbot • CI' }] });
const m18 = M(18, 1, c, alice, '😀 😀 😀');
const generalMsgs = [m1, m2, m3, m4, m5, m6, m7, m8, m9, j1, m11, m12, m13, m14, m15, m16, m17, m18];

const gen = (cid: string, lines: [User, string][], startMin = 600) => lines.map(([u, t], i) => M(100 + i, startMin - i * 7, cid, u, t));
export const messagesByChannel: Record<string, Message[]> = {
  [c]: generalMsgs,
  '4012': gen('4012', [[bob, 'when the build is green 🟢'], [eve, 'when prod is red 🔴'], [alice, 'obligatory friday deploy meme'], [charlie, 'lol'], [dana, 'accurate']], 300),
  '4013': gen('4013', [[dana, 'Anyone profiling the message list?'], [ME as User, '@dana yes — virtualized, ~60fps while streaming 1k messages'], [charlie, 'nice']], 200),
  '4002': gen('4002', [[bot, 'Welcome to **Jorcord HQ**! Read <#4003> and say hi.']], 4000),
  [DM1]: [M(200, 55, DM1, alice, 'Hey! Are you coming to the design review?'), M(201, 54, DM1, ME as User, 'Yes! Sending the Figma link in a sec'), M(202, 40, DM1, alice, 'Perfect, thanks 🙏')],
  [DM2]: [M(210, 300, DM2, bob, 'lunch?')],
  [DM3]: [M(220, 120, DM3, charlie, 'Flights booked ✈️'), M(221, 118, DM3, dana, 'Amazing!!')],
};
for (const [, list] of Object.entries(messagesByChannel)) for (const m of list) if (m.channelId.startsWith('5')) m.guildId = null;
const last = (id: string) => messagesByChannel[id]?.at(-1)?.id ?? null;
for (const g of guilds) for (const x of g.channels) x.lastMessageId = last(x.id);
for (const d of dms) d.lastMessageId = last(d.id);
// give other servers some unread
const fakeLast = (cid: string) => { for (const g of guilds) { const x = g.channels.find((y) => y.id === cid); if (x) x.lastMessageId = ago(5); } };
['20021', '20022', '20031'].forEach(fakeLast);

const readStates = [
  { channelId: '4011', lastReadId: m13.id, mentionCount: 0 }, // unread after m13 -> NEW divider
  { channelId: '4012', lastReadId: ago(9999), mentionCount: 0 },
  { channelId: '4013', lastReadId: ago(500), mentionCount: 2 },
  { channelId: '4002', lastReadId: last('4002'), mentionCount: 0 }, { channelId: '4003', lastReadId: null, mentionCount: 0 },
  { channelId: DM1, lastReadId: ago(60), mentionCount: 1 }, { channelId: DM2, lastReadId: last(DM2), mentionCount: 0 }, { channelId: DM3, lastReadId: ago(200), mentionCount: 0 },
  { channelId: '20021', lastReadId: ago(9999), mentionCount: 3 },
];

export const demoReady: ReadyPayload = {
  sessionId: 'demo', user: ME, guilds,
  privateChannels: dms,
  relationships: [
    { user: alice, type: 'friend' }, { user: bob, type: 'friend' }, { user: charlie, type: 'friend' }, { user: dana, type: 'friend' }, { user: grace, type: 'friend' }, { user: eve, type: 'friend' },
    { user: frank, type: 'incoming' }, { user: heidi, type: 'incoming' }, { user: ivan, type: 'outgoing' }, { user: judy, type: 'blocked' },
  ],
  readStates, presences: Object.entries(presences).map(([userId, presence]) => ({ userId, presence })),
  voiceStates: [
    { userId: '1002', guildId: G1, channelId: '4021', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false },
    { userId: '1004', guildId: G1, channelId: '4021', selfMute: true, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false },
    { userId: '1005', guildId: G1, channelId: '4022', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: true, streaming: false, suppress: false },
  ],
};
export const DEMO_START = { guildId: G1, channelId: c };
void avatar;
