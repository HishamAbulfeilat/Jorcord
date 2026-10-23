import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DISCORD_PERMISSION_BITS, Perm, discordToJorcordPerms, jorcordToDiscordPerms, snowflake, type PermName } from '@jorcord/shared';
import { Api, startServer, type Client, type TestEnv } from './helpers';
import { readZip } from '../src/lib/unzip';
import { ZipFileWriter } from '../src/lib/zip';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const LIM = { maxEntries: 50, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };

function multipart(file: Buffer, filename: string) {
  const b = '----jc' + Math.random().toString(36).slice(2);
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, file, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const upload = (token: string, guildId: string, file: Buffer, name: string, query = '') => { const m = multipart(file, name); return api.req('POST', `/guilds/${guildId}/import${query}`, token, m.payload, m.headers); };
async function zipOf(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'jc-zip-')); const path = join(dir, 'x.zip');
  const w = await ZipFileWriter.create(path); for (const [n, d] of Object.entries(entries)) await w.add(n, d); await w.finish();
  const buf = readFileSync(path); rmSync(dir, { recursive: true, force: true }); return buf;
}
async function addEmoji(guildId: string, userId: string, name: string) {
  const key = Buffer.from(snowflake() + snowflake() + snowflake()).toString('hex').slice(0, 48).padEnd(48, 'a');
  await env.ctx.storage.put(key, Readable.from(PNG), 1024);
  await env.ctx.db.query('INSERT INTO files (id, key, uploader_id, filename, content_type, size, width, height, spoiler) VALUES ($1,$2,$3,$4,$5,$6,1,1,false)', [snowflake(), key, userId, `${name}.png`, 'image/png', PNG.length]);
  await env.ctx.db.query('INSERT INTO emojis (id, guild_id, name, animated, url, role_ids) VALUES ($1,$2,$3,false,$4,$5::jsonb)', [snowflake(), guildId, name, `/api/v1/files/${key}/${name}.png`, '[]']);
}
async function sourceGuild() {
  const owner = await api.register('go');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Source Server' })).body;
  const mod = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Moderators', color: 0xff0000, hoist: true, mentionable: true, permissions: String(Perm.KICK_MEMBERS | Perm.MANAGE_MESSAGES) })).body;
  const cat = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'Staff', type: 'category' })).body;
  const staff = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'staff-chat', type: 'text', parentId: cat.id, topic: 'private', slowmode: 5, overwrites: [{ id: guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }, { id: mod.id, type: 'role', allow: String(Perm.VIEW_CHANNEL), deny: '0' }] })).body;
  await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'Lounge', type: 'voice', parentId: cat.id, userLimit: 5 });
  await addEmoji(guild.id, owner.id, 'party');
  return { owner, guild, mod, cat, staff };
}
const target = async () => { const owner = await api.register('gt'); const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Target' })).body; return { owner, guild }; };
const channelsOf = async (token: string, id: string) => (await api.req('GET', `/guilds/${id}/channels`, token)).body as any[];
const rolesOf = async (token: string, id: string) => (await api.req('GET', `/guilds/${id}/roles`, token)).body as any[];

describe('permission mapping', () => {
  it('round-trips through DISCORD_PERMISSION_BITS and drops what Discord has no bit for', () => {
    const names = (Object.keys(DISCORD_PERMISSION_BITS) as PermName[]).filter((n) => n !== 'RECORD_VOICE');
    const positions = names.map((n) => DISCORD_PERMISSION_BITS[n]);
    expect(new Set(positions).size).toBe(positions.length); // otherwise two permissions would collide on import
    for (const n of names) {
      expect(discordToJorcordPerms(1n << BigInt(DISCORD_PERMISSION_BITS[n]))).toBe(Perm[n]);
      expect(jorcordToDiscordPerms(Perm[n])).toBe(1n << BigInt(DISCORD_PERMISSION_BITS[n]));
    }
    expect(discordToJorcordPerms((1n << 10n) | (1n << 11n))).toBe(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES);
    expect(discordToJorcordPerms(1n << 63n)).toBe(0n);
    expect(jorcordToDiscordPerms(Perm.RECORD_VOICE)).toBe(0n);
  });
});

describe('zip reader limits', () => {
  it('reads what the writer wrote and refuses bombs, traversal names and corrupt archives', async () => {
    const z = await zipOf({ 'server.json': '{"a":1}', 'emoji/a.png': PNG });
    const m = readZip(z, LIM);
    expect(m.get('server.json')?.toString()).toBe('{"a":1}'); expect(m.get('emoji/a.png')?.equals(PNG)).toBe(true);
    const bomb = await zipOf({ 'zeros.bin': Buffer.alloc(3 * 1024 * 1024) });
    expect(() => readZip(bomb, LIM)).toThrow(/too large/); // a 3 MB entry, ~3 KB on the wire
    expect(() => readZip(bomb, { ...LIM, maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 1024 })).toThrow(/too much data/);
    expect(() => readZip(z, { ...LIM, maxEntries: 1 })).toThrow(/too many entries/);
    const evil = Buffer.from((await zipOf({ 'aa/bb/c.js': '{}' })).toString('latin1').split('aa/bb/c.js').join('../../c.js'), 'latin1');
    expect(() => readZip(evil, LIM)).toThrow(/unsafe entry name/);
    expect(() => readZip(Buffer.from('PK nonsense'), LIM)).toThrow(/zip/);
  });
});

describe('server export', () => {
  it('exports structure only, to owners and MANAGE_GUILD holders', async () => {
    const { owner, guild, mod } = await sourceGuild();
    const member = await api.register('gm');
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, member.token);
    expect((await api.req('GET', `/guilds/${guild.id}/export`, member.token)).status).toBe(403);
    const stranger = await api.register('gx');
    expect((await api.req('GET', `/guilds/${guild.id}/export`, stranger.token)).status).toBe(404);
    const r = await api.req('GET', `/guilds/${guild.id}/export`, owner.token);
    expect(r.status).toBe(200);
    expect(r.raw.headers['content-disposition']).toContain('.json');
    const doc = r.body;
    expect(doc).toMatchObject({ format: 'jorcord-server-export', version: 1, source: { name: 'Source Server' } });
    const role = doc.roles.find((x: any) => x.name === 'Moderators');
    expect(role).toMatchObject({ color: 0xff0000, hoist: true, mentionable: true, permissionNames: expect.arrayContaining(['KICK_MEMBERS', 'MANAGE_MESSAGES']) });
    expect(BigInt(role.discordPermissions)).toBe((1n << 1n) | (1n << 13n)); // KICK_MEMBERS + MANAGE_MESSAGES in Discord's positions
    expect(doc.channels.map((c: any) => c.name)).toEqual(expect.arrayContaining(['Staff', 'staff-chat', 'Lounge']));
    const staff = doc.channels.find((c: any) => c.name === 'staff-chat');
    expect(staff.parentKey).toBe(doc.channels.find((c: any) => c.name === 'Staff').key);
    expect(staff.overwrites.map((o: any) => o.target).sort()).toEqual(['everyone', role.key].sort());
    expect(JSON.stringify(doc)).not.toMatch(/token|password|email/i);
    expect(doc.emoji).toEqual([{ name: 'party', animated: false, file: null }]);
    // a member who was given MANAGE_GUILD may export as well
    await api.req('PATCH', `/guilds/${guild.id}/members/${member.id}`, owner.token, { roles: [mod.id] });
    await api.req('PATCH', `/guilds/${guild.id}/roles/${mod.id}`, owner.token, { permissions: String(Perm.MANAGE_GUILD) });
    expect((await api.req('GET', `/guilds/${guild.id}/export`, member.token)).status).toBe(200);
    // audit trail
    const log = (await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body as any[];
    expect(log.some((e) => e.action === 'GUILD_EXPORT')).toBe(true);
  });

  it('the zip export carries the emoji images and imports back as a copy of the structure', async () => {
    const { owner, guild } = await sourceGuild();
    const z = await api.req('GET', `/guilds/${guild.id}/export?format=zip`, owner.token);
    expect(z.status).toBe(200); expect(z.raw.headers['content-type']).toContain('application/zip');
    const entries = readZip(z.raw.rawPayload, LIM);
    expect([...entries.keys()].sort()).toEqual(['emoji/party.png', 'server.json']);
    expect(entries.get('emoji/party.png')?.equals(PNG)).toBe(true);

    const t = await target();
    const dry = await upload(t.owner.token, t.guild.id, z.raw.rawPayload, 'x.zip', '?dryRun=true');
    const exported = (await api.req('GET', `/guilds/${guild.id}/export`, owner.token)).body;
    const nCats = exported.channels.filter((c: any) => c.type === 'category').length, nChans = exported.channels.length - nCats;
    expect(nCats).toBeGreaterThanOrEqual(2);
    expect(dry.status).toBe(200); expect(dry.body).toMatchObject({ dryRun: true, source: 'jorcord', created: { roles: 1, categories: nCats, channels: nChans, emoji: 1 } });
    expect((await rolesOf(t.owner.token, t.guild.id)).length).toBe(1); // nothing was created (just @everyone)
    const before = (await channelsOf(t.owner.token, t.guild.id)).length;

    const res = await upload(t.owner.token, t.guild.id, z.raw.rawPayload, 'x.zip');
    expect(res.status).toBe(201); expect(res.body.created).toEqual({ roles: 1, categories: nCats, channels: nChans, emoji: 1 });
    const chans = await channelsOf(t.owner.token, t.guild.id);
    expect(chans.length).toBe(before + nCats + nChans);
    const cat = chans.find((c) => c.name === 'Staff'), staff = chans.find((c) => c.name === 'staff-chat'), lounge = chans.find((c) => c.name === 'Lounge');
    expect(cat.type).toBe('category'); expect(staff).toMatchObject({ parentId: cat.id, topic: 'private', slowmode: 5 }); expect(lounge).toMatchObject({ type: 'voice', userLimit: 5, parentId: cat.id });
    const roles = await rolesOf(t.owner.token, t.guild.id);
    const mod = roles.find((r) => r.name === 'Moderators');
    expect(mod).toMatchObject({ color: 0xff0000, hoist: true, mentionable: true, permissions: String(Perm.KICK_MEMBERS | Perm.MANAGE_MESSAGES) });
    const hidden = staff.overwrites.find((o: any) => o.id === t.guild.id);
    expect(BigInt(hidden.deny) & Perm.VIEW_CHANNEL).toBe(Perm.VIEW_CHANNEL);
    expect(staff.overwrites.find((o: any) => o.id === mod.id)).toBeTruthy(); // remapped to the NEW role id
    const emojis = (await api.req('GET', `/guilds/${t.guild.id}/emojis`, t.owner.token)).body;
    expect(emojis.map((e: any) => e.name)).toEqual(['party']);
    expect(emojis[0].url).toMatch(/^\/api\/v1\/files\/[a-f0-9]{48}\/party\.png$/);
    expect((await api.req('GET', emojis[0].url.replace('/api/v1', ''), null)).status).toBe(200);
    const log = (await api.req('GET', `/guilds/${t.guild.id}/audit-logs`, t.owner.token)).body as any[];
    expect(log.find((e) => e.action === 'GUILD_IMPORT')?.changes).toMatchObject({ roles: 1, channels: nChans, categories: nCats });
  });
});

describe('server import', () => {
  const discordTemplate = {
    code: 'abc', name: 'Gaming Hub', description: 'x', usage_count: 3,
    serialized_source_guild: {
      name: 'Gaming Hub', verification_level: 1, default_message_notifications: 1, explicit_content_filter: 2,
      roles: [
        { id: 0, name: '@everyone', permissions: String((1n << 10n) | (1n << 11n) | (1n << 6n)), color: 0, hoist: false, mentionable: false, position: 0 },
        { id: 1, name: 'Admin', permissions: String(1n << 3n), color: 255, hoist: true, mentionable: false, position: 2 },
        { id: 2, name: 'Raiders', permissions: String((1n << 10n) | (1n << 20n) | (1n << 21n)), color: 65280, hoist: false, mentionable: true, position: 1 },
      ],
      channels: [
        { id: 10, type: 4, name: 'Info', position: 0, parent_id: null, permission_overwrites: [] },
        { id: 11, type: 0, name: 'rules', position: 0, parent_id: 10, topic: 'Be nice', nsfw: false, rate_limit_per_user: 10, permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: String(1n << 11n) }, { id: 2, type: 0, allow: String(1n << 11n), deny: '0' }, { id: 999, type: 1, allow: '1', deny: '0' }] },
        { id: 12, type: 5, name: 'news', position: 1, parent_id: 10, permission_overwrites: [] },
        { id: 20, type: 4, name: 'Voice', position: 1, parent_id: null, permission_overwrites: [] },
        { id: 21, type: 2, name: 'Raid Room', position: 0, parent_id: 20, bitrate: 96000, user_limit: 10, permission_overwrites: [] },
        { id: 22, type: 13, name: 'Town Hall', position: 1, parent_id: 20, permission_overwrites: [] },
        { id: 30, type: 15, name: 'guides', position: 2, parent_id: null, permission_overwrites: [] },
        { id: 31, type: 3, name: 'unsupported', position: 3, parent_id: null },
      ],
    },
  };

  it('creates categories, channels and roles from a Discord template, mapping permissions through DISCORD_PERMISSION_BITS', async () => {
    const t = await target();
    const dry = await api.req('POST', `/guilds/${t.guild.id}/import?dryRun=true`, t.owner.token, discordTemplate);
    expect(dry.status).toBe(200); expect(dry.body).toMatchObject({ dryRun: true, source: 'discord-template', created: { roles: 2, categories: 2, channels: 5, emoji: 0 } });
    expect(dry.body.warnings.join(' ')).toMatch(/unsupported type/); expect(dry.body.warnings.join(' ')).toMatch(/member-specific/);
    const existingChannels = (await channelsOf(t.owner.token, t.guild.id)).length;

    const res = await api.req('POST', `/guilds/${t.guild.id}/import`, t.owner.token, discordTemplate);
    expect(res.status).toBe(201); expect(res.body.created).toEqual({ roles: 2, categories: 2, channels: 5, emoji: 0 });
    const roles = await rolesOf(t.owner.token, t.guild.id);
    const admin = roles.find((r) => r.name === 'Admin'), raiders = roles.find((r) => r.name === 'Raiders');
    expect(admin.permissions).toBe(String(Perm.ADMINISTRATOR)); expect(raiders.permissions).toBe(String(Perm.VIEW_CHANNEL | Perm.CONNECT | Perm.SPEAK));
    expect(admin).toMatchObject({ color: 255, hoist: true }); expect(raiders.mentionable).toBe(true);
    expect(admin.position).toBeGreaterThan(raiders.position); // relative order of the source is kept
    const everyone = roles.find((r) => r.id === t.guild.id);
    expect(BigInt(everyone.permissions) & Perm.SEND_MESSAGES).toBe(Perm.SEND_MESSAGES); // @everyone was NOT replaced (opt-in)

    const chans = await channelsOf(t.owner.token, t.guild.id);
    expect(chans.length).toBe(existingChannels + 7);
    const info = chans.find((c) => c.name === 'Info'), voice = chans.find((c) => c.name === 'Voice');
    const rules = chans.find((c) => c.name === 'rules'), news = chans.find((c) => c.name === 'news');
    expect(rules).toMatchObject({ type: 'text', parentId: info.id, topic: 'Be nice', slowmode: 10 }); expect(news).toMatchObject({ type: 'announcement', parentId: info.id });
    expect(chans.find((c) => c.name === 'Raid Room')).toMatchObject({ type: 'voice', parentId: voice.id, bitrate: 96000, userLimit: 10 });
    expect(chans.find((c) => c.name === 'Town Hall')).toMatchObject({ type: 'stage', parentId: voice.id });
    expect(chans.find((c) => c.name === 'guides')).toMatchObject({ type: 'forum', parentId: null });
    expect(chans.find((c) => c.name === 'unsupported')).toBeUndefined();
    expect(rules.overwrites.find((o: any) => o.id === t.guild.id).deny).toBe(String(Perm.SEND_MESSAGES)); // role id 0 -> @everyone
    expect(rules.overwrites.find((o: any) => o.id === raiders.id).allow).toBe(String(Perm.SEND_MESSAGES));
    expect(rules.overwrites.length).toBe(2); // the member-specific override was dropped
    expect(info.position).toBeLessThan(rules.position); expect(rules.position).toBeLessThan(news.position); expect(news.position).toBeLessThan(voice.position); // display order preserved, after existing channels

    const again = await api.req('POST', `/guilds/${t.guild.id}/import?applyEveryone=true`, t.owner.token, { ...discordTemplate, name: 'again' });
    expect(again.status).toBe(201);
    const ev = (await rolesOf(t.owner.token, t.guild.id)).find((r) => r.id === t.guild.id);
    expect(ev.permissions).toBe(String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.ADD_REACTIONS)); // opted in
  });

  it('is manager-only and never lets anyone mint permissions they lack', async () => {
    const t = await target();
    const member = await api.register('gp'); const stranger = await api.register('gq');
    const code = (await api.req('POST', `/guilds/${t.guild.id}/invites`, t.owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, member.token);
    expect((await api.req('POST', `/guilds/${t.guild.id}/import`, member.token, discordTemplate)).status).toBe(403);
    expect((await api.req('POST', `/guilds/${t.guild.id}/import`, stranger.token, discordTemplate)).status).toBe(404);
    // a MANAGE_GUILD (not administrator) manager: ADMINISTRATOR and other bits they do not hold are stripped
    const gm = (await api.req('POST', `/guilds/${t.guild.id}/roles`, t.owner.token, { name: 'Guild Manager', permissions: String(Perm.MANAGE_GUILD | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.CONNECT) })).body;
    await api.req('PATCH', `/guilds/${t.guild.id}/members/${member.id}`, t.owner.token, { roles: [gm.id] });
    const doc = { ...discordTemplate, serialized_source_guild: { ...discordTemplate.serialized_source_guild, roles: [...discordTemplate.serialized_source_guild.roles, { id: 3, name: 'Muter', permissions: String((1n << 10n) | (1n << 22n)), position: 3 }] } };
    const res = await api.req('POST', `/guilds/${t.guild.id}/import?applyEveryone=true`, member.token, doc);
    expect(res.status).toBe(201); expect(res.body.warnings.join(' ')).toMatch(/permissions you do not hold/);
    const roles = await rolesOf(t.owner.token, t.guild.id);
    expect(BigInt(roles.find((r) => r.name === 'Admin').permissions) & Perm.ADMINISTRATOR).toBe(0n);
    expect(roles.find((r) => r.name === 'Muter').permissions).toBe(String(Perm.VIEW_CHANNEL)); // MUTE_MEMBERS was not theirs to give
    const everyone = roles.find((r) => r.id === t.guild.id);
    expect(BigInt(everyone.permissions) & Perm.ADD_REACTIONS).toBe(Perm.ADD_REACTIONS); // unchanged baseline bits remain from the default; escalation masking only removes
    // imported roles sit below every pre-existing role, so the importer cannot out-rank anyone through an import
    const mgr = roles.find((r) => r.id === gm.id);
    for (const n of ['Admin', 'Raiders']) expect(roles.find((r) => r.name === n).position).toBeLessThan(mgr.position);
  });

  it('rejects garbage and oversized input with clean errors', async () => {
    const t = await target();
    const post = (b: unknown) => api.req('POST', `/guilds/${t.guild.id}/import`, t.owner.token, b);
    expect((await post({})).status).toBe(400);
    expect((await post({ hello: 'world' })).status).toBe(400);
    expect((await post({ format: 'jorcord-server-export', version: 9, roles: [] })).status).toBe(400);
    const roles = Array.from({ length: 251 }, (_, i) => ({ id: i + 1, name: `r${i}`, permissions: '0' }));
    expect((await post({ roles, channels: [] })).status).toBe(400);
    const chans = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, type: 0, name: `c${i}` }));
    expect((await post({ roles: [], channels: chans })).status).toBe(400);
    expect((await upload(t.owner.token, t.guild.id, Buffer.from('not json at all'), 'x.json')).status).toBe(400);
    expect((await upload(t.owner.token, t.guild.id, Buffer.from('PK\x03\x04garbage'), 'x.zip')).status).toBe(400);
    const empty = multipart(Buffer.alloc(0), 'e.json');
    expect((await api.req('POST', `/guilds/${t.guild.id}/import`, t.owner.token, empty.payload, empty.headers)).status).toBe(400);
    const big = await zipOf({ 'server.json': Buffer.alloc(3 * 1024 * 1024, 32) }); // 3 MB of spaces: tiny zip, over the 2 MB JSON cap once inflated
    expect((await upload(t.owner.token, t.guild.id, big, 'big.zip')).status).toBe(400);
    expect((await upload(t.owner.token, t.guild.id, Buffer.alloc(9 * 1024 * 1024, 1), 'huge.json')).status).toBe(413);
    // existing structure untouched by all the failures
    expect((await rolesOf(t.owner.token, t.guild.id)).length).toBe(1);
  });

  it('refuses images that are not images, oversized ones and duplicates; the rest still import', async () => {
    const t = await target();
    const doc = {
      format: 'jorcord-server-export', version: 1, roles: [], channels: [{ key: 'c', type: 'text', name: 'general-2', overwrites: [] }],
      emoji: [{ name: 'good', animated: false, file: 'emoji/good.png' }, { name: 'fake', animated: false, file: 'emoji/fake.png' }, { name: 'huge', animated: false, file: 'emoji/huge.png' }, { name: 'nofile', animated: false, file: null }, { name: 'good', animated: false, file: 'emoji/good.png' }],
    };
    const z = await zipOf({ 'server.json': JSON.stringify(doc), 'emoji/good.png': PNG, 'emoji/fake.png': Buffer.from('<svg onload=alert(1)>'), 'emoji/huge.png': Buffer.concat([PNG, Buffer.alloc(600 * 1024)]) });
    const res = await upload(t.owner.token, t.guild.id, z, 'e.zip');
    expect(res.status).toBe(201); expect(res.body.created).toMatchObject({ channels: 1, emoji: 1 });
    expect(res.body.warnings.join('\n')).toMatch(/fake.*not a PNG/s); expect(res.body.warnings.join('\n')).toMatch(/huge.*larger/s); expect(res.body.warnings.join('\n')).toMatch(/nofile.*no image/s); expect(res.body.warnings.join('\n')).toMatch(/good.*already exists/s);
    expect((await api.req('GET', `/guilds/${t.guild.id}/emojis`, t.owner.token)).body.map((e: any) => e.name)).toEqual(['good']);
  });
});

describe('rate limits', () => {
  it('limits imports per user and exports per user', async () => {
    const limited = await startServer({ rateLimit: true });
    try {
      const a = new Api(limited);
      const owner: Client = await a.register('rl');
      const guild = (await a.req('POST', '/guilds', owner.token, { name: 'RL' })).body;
      const tiny = { format: 'jorcord-server-export', version: 1, roles: [], channels: [{ key: 'c', type: 'text', name: 'x', overwrites: [] }], emoji: [] };
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await a.req('POST', `/guilds/${guild.id}/import`, owner.token, tiny)).status);
      expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]); expect(codes[5]).toBe(429);
      const exp: number[] = [];
      for (let i = 0; i < 11; i++) exp.push((await a.req('GET', `/guilds/${guild.id}/export`, owner.token)).status);
      expect(exp.slice(0, 10).every((s) => s === 200)).toBe(true); expect(exp[10]).toBe(429);
    } finally { await limited.close(); }
  });
});
