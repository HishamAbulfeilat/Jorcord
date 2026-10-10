import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Safe', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); const r = await api.req('POST', `/invites/${code}`, u.token); return { u, r }; };
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  return { owner, guild, code, join, general };
}
const say = (c: Client, ch: string, content = 'hi') => api.req('POST', `/channels/${ch}/messages`, c.token, { content });
const setUser = (id: string, set: string) => env.ctx.db.query(`UPDATE users SET ${set} WHERE id = $1`, [id]);
const setMember = (g: string, id: string, set: string) => env.ctx.db.query(`UPDATE members SET ${set} WHERE guild_id = $1 AND user_id = $2`, [g, id]);

describe('verification levels', () => {
  it('only managers may read/change safety settings; validates input', async () => {
    const { owner, guild, join } = await setup(); const { u } = await join();
    expect((await api.req('GET', `/guilds/${guild.id}/safety`, u.token)).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, u.token, { verificationLevel: 2 })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { verificationLevel: 9 })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { maxJoins: 1 } })).status).toBe(400);
    const r = await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { verificationLevel: 2, explicitFilter: 1, defaultNotifications: 'all', raidProtection: { enabled: true, maxJoins: 5 } });
    expect(r.body).toMatchObject({ verificationLevel: 2, explicitFilter: 1, defaultNotifications: 'all', raidProtection: { enabled: true, maxJoins: 5, windowSeconds: 60 } });
    expect((await api.req('GET', `/guilds/${guild.id}`, u.token)).body).toMatchObject({ verificationLevel: 2, explicitFilter: 1, defaultNotifications: 'all' });
  });

  it('level 1-4 gate messages, reactions and threads; roles, owner and bots are exempt', async () => {
    const { owner, guild, join, general } = await setup(); const { u } = await join();
    const lvl = (n: number) => api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { verificationLevel: n });
    expect((await say(u, general.id)).status).toBe(201); // level 0
    await lvl(1);
    const r1 = await say(u, general.id); expect(r1.status).toBe(403); expect(r1.body.code).toBe('VERIFICATION_REQUIRED');
    const m = (await say(owner, general.id, 'owner talks')).body; // owner exempt
    expect((await api.req('PUT', `/channels/${general.id}/messages/${m.id}/reactions/${encodeURIComponent('👍')}/@me`, u.token)).status).toBe(403);
    expect((await api.req('POST', `/channels/${general.id}/messages/${m.id}/threads`, u.token, { name: 'x' })).status).toBe(403);
    await setUser(u.id, 'verified = true');
    expect((await say(u, general.id)).status).toBe(201);
    await lvl(2); expect((await say(u, general.id)).status).toBe(403); // account is only seconds old
    await setUser(u.id, `created_at = now() - interval '10 minutes'`);
    expect((await say(u, general.id)).status).toBe(201);
    await lvl(3); expect((await say(u, general.id)).status).toBe(403); // member for seconds
    await setMember(guild.id, u.id, `joined_at = now() - interval '11 minutes'`);
    expect((await say(u, general.id)).status).toBe(201);
    await lvl(4); expect((await say(u, general.id)).status).toBe(403); // account younger than 7 days
    await setUser(u.id, `created_at = now() - interval '8 days'`);
    expect((await say(u, general.id)).status).toBe(201);
    // a role exempts
    await setUser(u.id, `verified = false`);
    expect((await say(u, general.id)).status).toBe(403);
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'regular' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${u.id}`, owner.token, { roles: [role.id] });
    expect((await say(u, general.id)).status).toBe(201);
  });
});

describe('raid protection', () => {
  it('pauses invites after a burst of joins, refuses new joins, can be resumed', async () => {
    const { owner, guild, join } = await setup();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { enabled: true, maxJoins: 3, windowSeconds: 60, lockMinutes: 30 } });
    const wo = await WsClient.connect(env.port); await wo.identify(owner.token);
    expect((await join('r1')).r.status).toBe(200); expect((await join('r2')).r.status).toBe(200);
    const third = await join('r3'); expect(third.r.status).toBe(200); // the tripping join itself still lands
    const upd = await wo.waitEvent('GUILD_UPDATE', (d) => d.id === guild.id && !!d.invitesPausedUntil);
    expect(Date.parse(upd.d.invitesPausedUntil)).toBeGreaterThan(Date.now() + 25 * 60_000);
    const late = await join('r4'); expect(late.r.status).toBe(403); expect(late.r.body.code).toBe('INVITES_PAUSED');
    const audit = (await api.req('GET', `/guilds/${guild.id}/audit-logs?action=RAID_DETECTED`, owner.token)).body; expect(audit).toHaveLength(1);
    const s = await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { pauseInvites: false }); expect(s.body.invitesPausedUntil).toBeNull();
    expect((await join('r5')).r.status).toBe(200);
    // manual pause
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { pauseInvites: true })).body.invitesPausedUntil).toBeTruthy();
    expect((await join('r6')).r.status).toBe(403);
    wo.close();
  });
});

describe('explicit media filter and presets', () => {
  it('blurs media from covered members in normal channels only', async () => {
    const { owner, guild, join, general } = await setup(); const { u } = await join();
    const up = async (c: Client) => { const b = 'XB'; const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${b}--\r\n`)]); return (await api.req('POST', '/uploads', c.token, payload as any, { 'content-type': `multipart/form-data; boundary=${b}` })).body; };
    const send = async (c: Client, ch: string) => (await api.req('POST', `/channels/${ch}/messages`, c.token, { content: 'pic', attachments: [(await up(c)).id] })).body;
    expect((await send(u, general.id)).attachments[0].spoiler).toBe(false);
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { explicitFilter: 1 });
    expect((await send(u, general.id)).attachments[0].spoiler).toBe(true);
    expect((await send(owner, general.id)).attachments[0].spoiler).toBe(false); // the owner is never filtered
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'trusted' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${u.id}`, owner.token, { roles: [role.id] });
    expect((await send(u, general.id)).attachments[0].spoiler).toBe(false); // role holders exempt at level 1
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { explicitFilter: 2 });
    expect((await send(u, general.id)).attachments[0].spoiler).toBe(true);
    const nsfw = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'spicy', type: 'text', nsfw: true })).body;
    await api.req('POST', '/users/@me/age-confirm', u.token, { confirm: true });
    expect((await send(u, nsfw.id)).attachments[0].spoiler).toBe(false);
  });
  it('presets set everything at once and report a checklist', async () => {
    const { owner, guild } = await setup();
    const before = (await api.req('GET', `/guilds/${guild.id}/safety`, owner.token)).body; expect(before.score).toBeLessThan(100);
    const r = await api.req('POST', `/guilds/${guild.id}/safety/preset`, owner.token, { preset: 'strict' });
    expect(r.body).toMatchObject({ verificationLevel: 4, explicitFilter: 2, raidProtection: { enabled: true, maxJoins: 5, lockMinutes: 120 } });
    expect(r.body.checklist.find((c: any) => c.id === 'raid_protection').done).toBe(true);
    expect((await api.req('POST', `/guilds/${guild.id}/safety/preset`, owner.token, { preset: 'nope' })).status).toBe(400);
  });
});
