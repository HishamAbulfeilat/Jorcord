import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('owner');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Trust', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  return { owner, guild, code, join, general };
}
const say = (c: Client, ch: string, content: string) => api.req('POST', `/channels/${ch}/messages`, c.token, { content });
const dm = (c: Client, to: string) => api.req('POST', '/users/@me/channels', c.token, { recipientIds: [to] });
const safety = (c: Client, g: string, body: unknown) => api.req('PATCH', `/guilds/${g}/safety`, c.token, body);

describe('members may DM each other (per server)', () => {
  it('is open by default, opt-in for later joiners, and enforced on DM creation', async () => {
    const { owner, guild, join } = await setup();
    const early = await join('early'); const early2 = await join('early2');
    expect((await dm(early, early2.id)).status).toBe(201); // historical behaviour is untouched
    const r = await safety(owner, guild.id, { memberDms: 'optin' });
    expect(r.body.memberDms).toBe('optin');
    const late = await join('late'); const late2 = await join('late2');
    const blocked = await dm(early, late.id);
    expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('SERVER_DMS_DISABLED');
    expect((await dm(late, late2.id)).body.code).toBe('SERVER_DMS_DISABLED');
    // the grandfathered members still reach each other; opting in opens the door for the new member
    expect((await dm(late, early.id)).status).toBe(403); // late has not opted in
    expect((await api.req('GET', `/guilds/${guild.id}/members/@me/dms`, late.token)).body).toMatchObject({ policy: 'optin', optIn: false, reachable: false });
    expect((await api.req('PUT', `/guilds/${guild.id}/members/@me/dms`, late.token, { allow: true })).body).toMatchObject({ optIn: true, reachable: true });
    expect((await dm(early, late.id)).status).toBe(201);
    expect((await dm(late, late2.id)).status).toBe(403); // late2 has not opted in
    // anyone can write to the owner, but the owner only reaches members who opted in
    expect((await dm(late2, owner.id)).status).toBe(201);
    expect((await dm(owner, late2.id)).status).toBe(200); // the existing channel is returned
    const late3 = await join('late3');
    expect((await dm(owner, late3.id)).body.code).toBe('SERVER_DMS_DISABLED');
  });

  it('can apply to existing members, friends bypass it, and a second open server re-enables DMs', async () => {
    const { owner, guild, join } = await setup();
    const a = await join('a'); const b = await join('b');
    await safety(owner, guild.id, { memberDms: 'optin', memberDmsApplyToExisting: true });
    expect((await dm(a, b.id)).body.code).toBe('SERVER_DMS_DISABLED');
    // a second server that stays open
    const g2 = (await api.req('POST', '/guilds', owner.token, { name: 'Open', template: 'community' })).body;
    const c2 = (await api.req('POST', `/guilds/${g2.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${c2}`, a.token); await api.req('POST', `/invites/${c2}`, b.token);
    expect((await dm(a, b.id)).status).toBe(201);
    // friends
    const c = await join('c'); const d = await join('d');
    await api.req('PUT', `/users/@me/relationships/${d.id}`, c.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${c.id}`, d.token, { type: 'friend' });
    expect((await dm(c, d.id)).status).toBe(201);
    // back to open
    await safety(owner, guild.id, { memberDms: 'open' });
    const e = await join('e'); const f = await join('f');
    expect((await dm(e, f.id)).status).toBe(201);
  });

  it('only managers change it', async () => {
    const { guild, join } = await setup(); const u = await join();
    expect((await safety(u, guild.id, { memberDms: 'optin' })).status).toBe(403);
    expect((await safety(u, guild.id, { memberDms: 'bogus' })).status).toBe(400);
  });
});

describe('scam link protection', () => {
  it('adds warnings to suspicious links in messages and DMs, honouring allow/deny lists', async () => {
    const { owner, guild, join, general } = await setup(); const u = await join();
    const bad = await say(u, general.id, 'free nitro https://discord-nitro.gift/claim');
    expect(bad.status).toBe(201);
    expect(bad.body.linkWarnings[0]).toMatchObject({ host: 'discord-nitro.gift', level: 'dangerous' });
    const ok = await say(u, general.id, 'docs https://github.com/a/b and https://discord.com/channels/1');
    expect(ok.body.linkWarnings).toBeUndefined();
    const list = (await api.req('GET', `/channels/${general.id}/messages`, u.token)).body;
    expect(list.find((m: any) => m.id === bad.body.id).linkWarnings).toHaveLength(1);
    // lists
    expect((await safety(u, guild.id, { linkDeny: ['x.example'] })).status).toBe(403);
    const r = await safety(owner, guild.id, { linkAllow: ['HTTPS://Discord-Nitro.gift/'], linkDeny: ['evil.example', 'bad entry'] });
    expect(r.body).toMatchObject({ linkAllow: ['discord-nitro.gift'], linkDeny: ['evil.example'] });
    const allowed = await say(u, general.id, 'again https://discord-nitro.gift/claim');
    expect(allowed.body.linkWarnings).toBeUndefined();
    const denied = await say(u, general.id, 'see https://cdn.evil.example/x');
    expect(denied.body.linkWarnings[0]).toMatchObject({ level: 'dangerous', reasons: ['denied'] });
    // DMs are scored with the built-in rules
    const other = await join('other');
    const ch = (await dm(owner, other.id)).body;
    const sent = await say(owner, ch.id, 'claim your free nitro at https://dlscord.com/gift');
    expect(sent.body.linkWarnings?.length).toBe(1);
  });

  it('suspicious_links AutoMod rule blocks, respects allow lists and tuning', async () => {
    const { owner, guild, join, general } = await setup(); const u = await join();
    const rule = await api.req('POST', `/guilds/${guild.id}/automod/rules`, owner.token, { name: 'Scam links', trigger: 'suspicious_links', actions: ['block'] });
    expect(rule.status).toBe(201); expect(rule.body.trigger).toBe('suspicious_links');
    const blocked = await say(u, general.id, 'hey https://steamcommunlty.com/trade/abc');
    expect(blocked.status).toBe(400); expect(blocked.body.code).toBe('AUTOMOD_BLOCKED');
    expect((await say(u, general.id, 'https://store.steampowered.com/app/10 and https://bit.ly/abc')).status).toBe(201);
    expect((await api.req('POST', `/guilds/${guild.id}/automod/test`, owner.token, { content: 'https://steamcommunlty.com' })).body.find((r: any) => r.ruleId === rule.body.id).matched).toBe(true);
    await safety(owner, guild.id, { linkAllow: ['steamcommunlty.com'] });
    expect((await say(u, general.id, 'https://steamcommunlty.com/trade/abc')).status).toBe(201);
    // a high threshold lets weaker signals through; a shortener alone never reaches 50 anyway
    await api.req('PATCH', `/guilds/${guild.id}/automod/rules/${rule.body.id}`, owner.token, { options: { linkMinScore: 90 } });
    expect((await say(u, general.id, 'https://discord-nitro.xyz/x')).status).toBe(201); // scores 85: below the raised threshold
    expect((await say(u, general.id, 'https://discordnitro.gift/claim')).status).toBe(400); // 100
  });
});

describe('impersonation guard', () => {
  it('flags look-alike names on join and rename, holds when configured, and lets moderators clear', async () => {
    const { owner, guild, join, general } = await setup();
    const off = await join('owner'); // guard is off: nothing happens
    expect((await say(off, general.id, 'hi')).status).toBe(201);
    expect((await safety(owner, guild.id, { impersonationGuard: { enabled: true, action: 'hold' } })).body.impersonationGuard).toEqual({ enabled: true, action: 'hold' });
    const fake = await join('owner'); // username owner<n>x vs the owner's owner<k>x: one edit apart
    const other = await join('zed');
    const q = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q.map((x: any) => x.userId)).toContain(fake.id);
    expect(q.find((x: any) => x.userId === fake.id)).toMatchObject({ held: true, match: { kind: 'owner' } });
    expect(q.map((x: any) => x.userId)).not.toContain(other.id);
    expect((await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, other.token)).status).toBe(403);
    expect((await say(fake, general.id, 'I am the owner')).status).toBe(403); // held: read-only
    const view = (await api.req('GET', `/guilds/${guild.id}/members/${fake.id}/mod-view`, owner.token)).body;
    expect(view.flags).toContain('impersonation');
    expect((await api.req('POST', `/guilds/${guild.id}/members/${fake.id}/impersonation/clear`, other.token)).status).toBe(403);
    expect((await api.req('POST', `/guilds/${guild.id}/members/${fake.id}/impersonation/clear`, owner.token)).status).toBe(200);
    expect((await say(fake, general.id, 'sorry')).status).toBe(201);
    expect((await api.req('POST', `/guilds/${guild.id}/members/${fake.id}/impersonation/clear`, owner.token)).status).toBe(404);
    // a rename into a staff-like name is caught too, in "flag" mode nobody is silenced
    await safety(owner, guild.id, { impersonationGuard: { action: 'flag' } });
    const renamed = await join('zed');
    const ownerName = (await api.req('PATCH', '/users/@me', owner.token, { displayName: 'Hisham Admin' })).body.displayName;
    expect(ownerName).toBe('Hisham Admin');
    expect((await api.req('PATCH', '/users/@me', renamed.token, { displayName: 'H1sham Admin' })).status).toBe(200);
    const q2 = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q2.find((x: any) => x.userId === renamed.id)).toMatchObject({ held: false });
    expect((await say(renamed, general.id, 'still talking')).status).toBe(201);
  });

  it('matches the server name', async () => {
    const owner = await api.register('owner');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Jorcord Official' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { impersonationGuard: { enabled: true } });
    const u = await api.register('x'); await api.req('POST', `/invites/${code}`, u.token);
    await api.req('PATCH', '/users/@me', u.token, { displayName: 'J0rcord 0fficial' });
    const q = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q).toHaveLength(1); expect(q[0].match.kind).toBe('server');
  });
});

describe('mass-DM spam detection', () => {
  it('limits a sender who sends identical first messages to many strangers, and logs it', async () => {
    const { join } = await setup();
    const spammer = await join('spam');
    const targets: Client[] = []; for (let i = 0; i < 6; i++) targets.push(await join('t'));
    // one normal conversation that the target answers
    const friendly = (await dm(spammer, targets[0]!.id)).body;
    expect((await say(spammer, friendly.id, 'hi, welcome to the server')).status).toBe(201);
    expect((await say(targets[0]!, friendly.id, 'thanks')).status).toBe(201);
    const text = 'Hey! Claim your reward now at https://dlscord.com/gift';
    const results: number[] = [];
    for (const t of targets.slice(1)) {
      const ch = await dm(spammer, t.id);
      if (ch.status !== 201) { results.push(ch.status); continue; }
      results.push((await say(spammer, ch.body.id, text)).status);
    }
    // identical text with a suspicious link: limited at the 3rd distinct stranger
    expect(results.slice(0, 2)).toEqual([201, 201]);
    expect(results[2]).toBe(403);
    expect(results.slice(3).every((s) => s === 403)).toBe(true);
    const again = await dm(spammer, targets[5]!.id);
    expect(again.status).toBe(403); expect(again.body.code).toBe('DM_LIMITED');
    // established conversations are untouched
    expect((await say(spammer, friendly.id, 'still here')).status).toBe(201);
    const inc = await env.ctx.db.query('SELECT reason, recipients FROM mass_dm_incidents WHERE sender_id = $1', [spammer.id]);
    expect(inc).toHaveLength(1); expect(inc[0].reason).toBe('identical_dm_with_link');
    expect((await env.ctx.db.query('SELECT dm_limited_until FROM users WHERE id = $1', [spammer.id]))[0].dm_limited_until).toBeTruthy();
  });

  it('plain identical text needs more recipients; different texts to few people are fine', async () => {
    const { join } = await setup();
    const s = await join('sender'); const rs: Client[] = []; for (let i = 0; i < 6; i++) rs.push(await join('r'));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) { const ch = (await dm(s, rs[i]!.id)).body; codes.push((await say(s, ch.id, `unique message number ${'abcdefg'[i]} about topic ${'xyzuvw'[i]}${'qrstuv'.repeat(i)}`)).status); }
    expect(codes.every((c) => c === 201)).toBe(true);
    const s2 = await join('sender'); const codes2: number[] = [];
    for (let i = 0; i < 6; i++) { const ch = await dm(s2, rs[i]!.id); codes2.push(ch.status === 201 ? (await say(s2, ch.body.id, 'Join my server for giveaways')).status : ch.status); }
    expect(codes2).toEqual([201, 201, 201, 201, 403, 403]);
  });
});
