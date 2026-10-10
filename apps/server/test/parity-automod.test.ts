import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Mod', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const u = await api.register('m'); await api.req('POST', `/invites/${code}`, u.token);
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const alerts = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'mod-log', type: 'text' })).body;
  const rule = (b: object) => api.req('POST', `/guilds/${guild.id}/automod/rules`, owner.token, b);
  return { owner, guild, u, general, alerts, rule };
}
const say = (c: Client, ch: string, content: string) => api.req('POST', `/channels/${ch}/messages`, c.token, { content });
const history = async (c: Client, ch: string) => (await api.req('GET', `/channels/${ch}/messages?limit=50`, c.token)).body;

describe('AutoMod v3', () => {
  it('regex rules: validated at save, linear-time at run, case-insensitive', async () => {
    const { owner, guild, u, general, rule } = await setup();
    for (const bad of ['(a)\\1', '(?=x)', '[a-', 'x'.repeat(101), '(((']) expect((await rule({ name: 'r', trigger: 'regex', regexPatterns: [bad], action: 'block' })).status, bad).toBe(400);
    expect((await rule({ name: 'r', trigger: 'regex', action: 'block' })).status).toBe(400); // needs a pattern
    expect((await rule({ name: 'r', trigger: 'regex', regexPatterns: Array(11).fill('a'), action: 'block' })).status).toBe(400);
    const r = await rule({ name: 'phone', trigger: 'regex', regexPatterns: ['\\d{3}-\\d{4}', '(a+)+$'], action: 'block' });
    expect(r.status).toBe(201); expect(r.body.regexPatterns).toHaveLength(2);
    expect((await say(u, general.id, 'call 555-1234')).body.code).toBe('AUTOMOD_BLOCKED');
    const t0 = Date.now();
    expect((await say(u, general.id, 'a'.repeat(1900) + '!')).status).toBe(201); // would hang a backtracking engine
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await say(owner, general.id, '555-1234')).status).toBe(201); // managers exempt
    expect((await api.req('PATCH', `/guilds/${guild.id}/automod/rules/${r.body.id}`, owner.token, { regexPatterns: ['(?<x>a)'] })).status).toBe(400);
  });

  it('invite links, caps, repeated characters, tunable spam, link', async () => {
    const { u, general, rule } = await setup();
    await rule({ name: 'inv', trigger: 'invite_link', action: 'block' });
    await rule({ name: 'caps', trigger: 'caps', action: 'block', options: { capsPercent: 80, capsMinLength: 10 } });
    await rule({ name: 'rep', trigger: 'repeated_chars', action: 'block', options: { repeatLimit: 8 } });
    const code = (s: string) => say(u, general.id, s).then((r) => r.body.code);
    expect(await code('join discord.gg/abcdef now')).toBe('AUTOMOD_BLOCKED');
    expect(await code('https://jorcord.example/invite/AbCd1234')).toBe('AUTOMOD_BLOCKED');
    expect(await code('THIS IS A VERY LOUD MESSAGE')).toBe('AUTOMOD_BLOCKED');
    expect(await code('I said HELLO to everyone here')).toBeUndefined();
    expect(await code('short LOUD')).toBeUndefined(); // below the minimum letter count
    expect(await code('noooooooooooo way')).toBe('AUTOMOD_BLOCKED');
    expect(await code('nooo way')).toBeUndefined();
  });

  it('spam trigger honours its options', async () => {
    const { u, general, rule } = await setup();
    expect((await rule({ name: 's', trigger: 'spam', action: 'block', options: { spamCount: 1 } })).status).toBe(400); // at least 2
    expect((await rule({ name: 's', trigger: 'spam', action: 'block', options: { spamCount: 3, spamSeconds: 30 } })).status).toBe(201);
    const codes: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) codes.push((await say(u, general.id, `m${i}`)).status);
    expect(codes).toEqual([201, 201, 201, 400]); // the fourth message would be the 3rd-already-posted + 1: blocked once 3 exist
  });

  it('alert channel gets an embed with rule, user, content and action; message passes for alert-only rules', async () => {
    const { owner, guild, u, general, alerts, rule } = await setup();
    expect((await rule({ name: 'x', trigger: 'keyword', keywords: ['spoiler'], action: 'alert' })).status).toBe(400); // alert needs a channel
    expect((await rule({ name: 'x', trigger: 'keyword', keywords: ['spoiler'], actions: ['alert'], alertChannelId: '999999999999' })).status).toBe(400);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    expect((await rule({ name: 'x', trigger: 'keyword', keywords: ['spoiler'], actions: ['alert'], alertChannelId: voice.id })).status).toBe(400);
    const r = await rule({ name: 'Spoilers', trigger: 'keyword', keywords: ['spoiler'], actions: ['alert'], alertChannelId: alerts.id });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ action: 'alert', actions: ['alert'], alertChannelId: alerts.id });
    expect((await say(u, general.id, 'a SPOILER here')).status).toBe(201); // alert-only: not blocked
    const log = (await history(owner, alerts.id)).find((m: any) => m.embeds.length);
    expect(log).toBeTruthy();
    expect(log.author.username).toBe('AutoMod');
    expect(log.embeds[0]).toMatchObject({ type: 'rich', title: 'AutoMod: Spoilers', description: 'a SPOILER here' });
    expect(log.embeds[0].author).toBe(u.username);
    const fields = Object.fromEntries(log.embeds[0].fields.map((f: any) => [f.name, f.value]));
    expect(fields.User).toContain(u.id); expect(fields.Channel).toBe(`<#${general.id}>`); expect(fields.Action).toBe('alert');
    expect(log.mentions).toEqual([]); // the alert never pings anyone
  });

  it('block + alert + warn + timeout combine; warn writes a warning, timeout sets timeout_until', async () => {
    const { owner, guild, u, general, alerts, rule } = await setup();
    await rule({ name: 'combo', trigger: 'keyword', keywords: ['nope'], actions: ['block', 'alert', 'warn', 'timeout'], alertChannelId: alerts.id, timeoutSeconds: 600, customMessage: 'Watch it' });
    const r = await say(u, general.id, 'nope nope');
    expect(r.status).toBe(400); expect(r.body).toMatchObject({ code: 'AUTOMOD_BLOCKED', message: 'Watch it' });
    expect((await history(owner, general.id)).some((m: any) => m.content === 'nope nope')).toBe(false); // blocked = never posted
    const w = await env.ctx.db.query('SELECT * FROM mod_warnings WHERE guild_id = $1 AND user_id = $2', [guild.id, u.id]);
    expect(w).toHaveLength(1); expect(w[0].source).toBe('automod'); expect(w[0].moderator_id).toBeNull();
    const [m] = await env.ctx.db.query('SELECT timeout_until FROM members WHERE guild_id = $1 AND user_id = $2', [guild.id, u.id]);
    expect(new Date(m.timeout_until).getTime()).toBeGreaterThan(Date.now() + 500_000);
    const log = (await history(owner, alerts.id)).find((m: any) => m.embeds.length);
    expect(log.embeds[0].fields.find((f: any) => f.name === 'Action').value).toContain('blocked message');
  });

  it('test mode: nothing is enforced, but the alert and audit log record the hit', async () => {
    const { owner, guild, u, general, alerts, rule } = await setup();
    await rule({ name: 'dry', trigger: 'keyword', keywords: ['maybe'], actions: ['block', 'warn'], alertChannelId: alerts.id, testMode: true });
    expect((await say(u, general.id, 'maybe later')).status).toBe(201);
    const log = (await history(owner, alerts.id)).find((m: any) => m.embeds.length);
    expect(log.embeds[0].title).toMatch(/^\[Test\] /); expect(log.embeds[0].fields.find((f: any) => f.name === 'Action').value).toContain('test mode');
    expect(await env.ctx.db.query('SELECT 1 FROM mod_warnings WHERE guild_id = $1', [guild.id])).toHaveLength(0);
    const audit = (await api.req('GET', `/guilds/${guild.id}/audit-logs?limit=20`, owner.token)).body;
    expect(audit.some((e: any) => e.action === 'AUTOMOD_TEST')).toBe(true);
  });

  it('POST /automod/test dry-runs the rules for managers only', async () => {
    const { owner, guild, u, rule } = await setup();
    await rule({ name: 'k', trigger: 'keyword', keywords: ['zzz'], action: 'block' });
    await rule({ name: 'caps', trigger: 'caps', action: 'block' });
    await rule({ name: 'sp', trigger: 'spam', action: 'block' });
    expect((await api.req('POST', `/guilds/${guild.id}/automod/test`, u.token, { content: 'zzz' })).status).toBe(403);
    const res = (await api.req('POST', `/guilds/${guild.id}/automod/test`, owner.token, { content: 'ZZZ ZZZ ZZZ ZZZ ZZZ' })).body;
    expect(res.map((x: any) => [x.name, x.matched])).toEqual([['k', true], ['caps', true], ['sp', false]]);
    expect(res.find((x: any) => x.name === 'sp').evaluated).toBe(false);
    expect((await api.req('POST', `/guilds/${guild.id}/automod/test`, owner.token, { content: 'x'.repeat(5000) })).status).toBe(400);
  });

  it('old single-action rules keep working; patching action syncs actions; rule count is capped', async () => {
    const { owner, guild, u, general, rule } = await setup();
    const r = await rule({ name: 'old', trigger: 'keyword', keywords: ['old'], action: 'block' });
    expect(r.body.actions).toEqual(['block']);
    const p = await api.req('PATCH', `/guilds/${guild.id}/automod/rules/${r.body.id}`, owner.token, { action: 'timeout', timeoutSeconds: 30 });
    expect(p.body).toMatchObject({ action: 'timeout', actions: ['timeout'] });
    expect((await say(u, general.id, 'old')).status).toBe(400);
    const outsider = await api.register('x');
    expect((await api.req('PATCH', `/guilds/${guild.id}/automod/rules/${r.body.id}`, outsider.token, { enabled: false })).status).toBe(404);
    for (let i = 0; i < 49; i++) await rule({ name: `n${i}`, trigger: 'link', action: 'alert', alertChannelId: general.id });
    expect((await rule({ name: 'one too many', trigger: 'link', action: 'block' })).body.code).toBe('LIMIT_REACHED');
  });
});
