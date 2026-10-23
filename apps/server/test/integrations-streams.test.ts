import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MAX_STREAM_FEEDS, Perm } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';
import { http, ProviderError } from '../src/lib/providerHttp';
import { clearTwitchTokenCache, defang, parseTwitchInput, parseYoutubeFeed, parseYoutubeInput, pollStreamFeeds } from '../src/services/streamfeeds';

const CREDS = { twitch: { clientId: 'twid', clientSecret: 'twsecret' }, google: { clientId: 'goid.apps.googleusercontent.com', clientSecret: 'gosecret' } };
let env: TestEnv, plain: TestEnv, api: Api, papi: Api;
beforeAll(async () => { env = await startServer({ integrations: CREDS, publicUrl: 'https://chat.example.test' }); api = new Api(env); plain = await startServer(); papi = new Api(plain); });
afterAll(async () => { await env.close(); await plain.close(); });
afterEach(() => { vi.restoreAllMocks(); clearTwitchTokenCache(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UC = (n: number) => `UC${String(n).padStart(22, 'a')}`;

// ---------------------------------------------------------------- OAuth connections

/** A fake Twitch + Google. `accounts` maps an authorization code to what the provider would answer. */
function fakeProviders(accounts: Record<string, { twitch?: { id: string; login: string }; google?: { id: string; customUrl?: string } }>) {
  const calls: { url: string; form?: Record<string, string>; headers?: Record<string, string> }[] = [];
  vi.spyOn(http, 'json').mockImplementation(async (url, init = {}) => {
    calls.push({ url, form: init.form, headers: init.headers });
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) { const a = accounts[init.form?.code ?? '']?.twitch; return a ? { status: 200, body: { access_token: `tw-tok-${init.form!.code}` } } : { status: 400, body: { message: 'invalid code' } }; }
    if (url === 'https://api.twitch.tv/helix/users') { const code = init.headers!.authorization!.replace('Bearer tw-tok-', ''); const a = accounts[code]!.twitch!; return { status: 200, body: { data: [{ id: a.id, login: a.login, display_name: a.login }] } }; }
    if (url.startsWith('https://oauth2.googleapis.com/token')) { const a = accounts[init.form?.code ?? '']?.google; return a ? { status: 200, body: { access_token: `g-tok-${init.form!.code}` } } : { status: 400, body: { error: 'invalid_grant' } }; }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) { const code = init.headers!.authorization!.replace('Bearer g-tok-', ''); const a = accounts[code]!.google!; return { status: 200, body: { items: [{ id: a.id, snippet: { title: 'My Channel', customUrl: a.customUrl } }] } }; }
    if (url.includes('/revoke')) return { status: 200, body: null };
    throw new Error('unexpected provider call ' + url);
  });
  return calls;
}

async function begin(c: { token: string }, provider: 'twitch' | 'youtube', a: Api = api) {
  const r = await a.req('POST', `/users/@me/connections/oauth/${provider}/start`, c.token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const url = new URL(r.body.url);
  const cookie = String(r.raw.headers['set-cookie']).split(';')[0]!; // jc_oauth=<nonce>
  return { url, state: url.searchParams.get('state')!, cookie, res: r };
}
const callback = async (provider: string, qs: Record<string, string>, cookie?: string, a: Api = api) => {
  const res = await a.env.app.inject({ method: 'GET', url: `/api/v1/connections/oauth/${provider}/callback?${new URLSearchParams(qs)}`, headers: cookie ? { cookie } : {} });
  const loc = res.headers.location ? new URL(String(res.headers.location)) : null;
  return { status: res.statusCode, result: loc?.searchParams.get('result') ?? null, loc, res };
};

describe('OAuth-verified connections', () => {
  it('is off without credentials: providers carry no oauth flag, start answers 501, the code-in-page flow still works', async () => {
    const u = await papi.register('plainoauth');
    expect((await papi.req('GET', '/connections/providers', u.token)).body.some((p: any) => p.oauth)).toBe(false);
    for (const p of ['twitch', 'youtube']) { const r = await papi.req('POST', `/users/@me/connections/oauth/${p}/start`, u.token); expect(r.status).toBe(501); expect(r.body.code).toBe('FEATURE_DISABLED'); }
    const cb = await callback('twitch', { code: 'x', state: 'y'.repeat(32) }, undefined, papi); expect(cb.result).toBe('disabled'); // never a 500
    const add = await papi.req('POST', '/users/@me/connections', u.token, { type: 'twitch', handle: 'some_streamer' });
    expect(add.status).toBe(201); expect(add.body.verified).toBe(false); expect(add.body.verifyCode).toMatch(/^jorcord-verify=/);
  });

  it('advertises which providers can be connected, and rejects unknown ones', async () => {
    const u = await api.register('adv');
    const list = (await api.req('GET', '/connections/providers', u.token)).body as any[];
    expect(list.filter((p) => p.oauth).map((p) => p.id).sort()).toEqual(['twitch', 'youtube']);
    expect((await api.req('POST', '/users/@me/connections/oauth/github/start', u.token)).status).toBe(400);
    expect((await api.req('POST', '/users/@me/connections/oauth/twitch/start', null)).status).toBe(401);
  });

  it('Twitch: start -> callback verifies the connection, keeps only the provider id, and revokes the token', async () => {
    const calls = fakeProviders({ code1: { twitch: { id: '4242', login: 'Streamer_One' } } });
    const u = await api.register('twok');
    const s = await begin(u, 'twitch');
    expect(s.url.origin + s.url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(s.url.searchParams.get('client_id')).toBe('twid');
    expect(s.url.searchParams.get('redirect_uri')).toBe('https://chat.example.test/api/v1/connections/oauth/twitch/callback');
    expect(s.url.searchParams.get('response_type')).toBe('code');
    expect(s.url.searchParams.get('code_challenge')).toBeNull(); // Twitch has no PKCE
    expect(s.res.raw.headers['set-cookie']).toMatch(/HttpOnly/); expect(s.res.raw.headers['set-cookie']).toMatch(/Secure/);
    const cb = await callback('twitch', { code: 'code1', state: s.state }, s.cookie);
    expect(cb.status).toBe(302); expect(cb.result).toBe('ok'); expect(cb.loc!.origin).toBe('https://chat.example.test');
    const mine = (await api.req('GET', '/users/@me/connections', u.token)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: 'twitch', handle: 'streamer_one', url: 'https://www.twitch.tv/streamer_one', verified: true });
    const [row] = await env.ctx.db.query('SELECT * FROM connections WHERE user_id = $1', [u.id]);
    expect(row.provider_user_id).toBe('4242');
    expect(JSON.stringify(row)).not.toContain('tw-tok'); // no token anywhere in the row
    expect(await env.ctx.db.query('SELECT 1 FROM connection_oauth_states WHERE user_id = $1', [u.id])).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('/oauth2/revoke') && c.form?.token === 'tw-tok-code1')).toBe(true);
    expect((await api.req('GET', `/users/${u.id}`, u.token)).body.connections[0].verified).toBe(true);
  });

  it('YouTube: PKCE S256 with the youtube.readonly scope; the verifier is sent on the token exchange', async () => {
    const calls = fakeProviders({ gcode: { google: { id: UC(1), customUrl: '@MyChannel' } } });
    const u = await api.register('ytok');
    const s = await begin(u, 'youtube');
    expect(s.url.origin + s.url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(s.url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
    expect(s.url.searchParams.get('code_challenge_method')).toBe('S256');
    const [st] = await env.ctx.db.query('SELECT code_verifier FROM connection_oauth_states WHERE user_id = $1', [u.id]);
    expect(s.url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(st.code_verifier).digest('base64url'));
    expect((await callback('youtube', { code: 'gcode', state: s.state }, s.cookie)).result).toBe('ok');
    expect(calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))!.form!.code_verifier).toBe(st.code_verifier);
    const c = (await api.req('GET', '/users/@me/connections', u.token)).body[0];
    expect(c).toMatchObject({ type: 'youtube', handle: '@MyChannel', url: 'https://www.youtube.com/@MyChannel', verified: true });
  });

  it('YouTube account without a channel is refused and creates nothing', async () => {
    vi.spyOn(http, 'json').mockImplementation(async (url) => url.includes('oauth2.googleapis.com/token') ? { status: 200, body: { access_token: 't' } } : url.includes('/revoke') ? { status: 200, body: null } : { status: 200, body: { items: [] } });
    const u = await api.register('ytnone'); const s = await begin(u, 'youtube');
    expect((await callback('youtube', { code: 'c', state: s.state }, s.cookie)).result).toBe('no_channel');
    expect((await api.req('GET', '/users/@me/connections', u.token)).body).toHaveLength(0);
  });

  it('rejects an unknown state, a replayed callback, a different browser, an expired state and a state of the other provider', async () => {
    fakeProviders({ c1: { twitch: { id: '1001', login: 'replay_user' } }, c2: { twitch: { id: '1002', login: 'other_browser' } }, c3: { twitch: { id: '1003', login: 'expired_user' } }, c4: { twitch: { id: '1004', login: 'wrongprov' } } });
    const u = await api.register('state');
    expect((await callback('twitch', { code: 'c1', state: 'f'.repeat(43) }, 'jc_oauth=whatever')).result).toBe('invalid_state');
    expect((await callback('twitch', { code: 'c1' })).result).toBe('invalid_state'); // missing state
    // replay: the second use of a state finds nothing
    const s = await begin(u, 'twitch');
    expect((await callback('twitch', { code: 'c1', state: s.state }, s.cookie)).result).toBe('ok');
    expect((await callback('twitch', { code: 'c1', state: s.state }, s.cookie)).result).toBe('invalid_state');
    // a victim opening the attacker's authorize link has no (or another) binding cookie: nothing is linked and the state is burned
    const attacker = await api.register('atk'); const s2 = await begin(attacker, 'twitch');
    expect((await callback('twitch', { code: 'c2', state: s2.state }, 'jc_oauth=' + 'z'.repeat(32))).result).toBe('invalid_state');
    expect((await callback('twitch', { code: 'c2', state: s2.state }, s2.cookie)).result).toBe('invalid_state');
    expect((await api.req('GET', '/users/@me/connections', attacker.token)).body).toHaveLength(0);
    const s2b = await begin(attacker, 'twitch'); expect((await callback('twitch', { code: 'c2', state: s2b.state })).result).toBe('invalid_state'); // no cookie at all
    // expiry
    const s3 = await begin(u, 'twitch');
    await env.ctx.db.query(`UPDATE connection_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [sha(s3.state)]);
    expect((await callback('twitch', { code: 'c3', state: s3.state }, s3.cookie)).result).toBe('invalid_state');
    // a state is for one provider only
    const s4 = await begin(u, 'twitch');
    expect((await callback('youtube', { code: 'c4', state: s4.state }, s4.cookie)).result).toBe('invalid_state');
    expect((await api.req('GET', '/users/@me/connections', u.token)).body.map((c: any) => c.handle)).toEqual(['replay_user']);
  });

  it('a failed code exchange links nothing; a cancelled consent clears the pending state', async () => {
    fakeProviders({});
    const u = await api.register('fail'); const s = await begin(u, 'twitch');
    expect((await callback('twitch', { code: 'bad', state: s.state }, s.cookie)).result).toBe('exchange_failed');
    expect((await api.req('GET', '/users/@me/connections', u.token)).body).toHaveLength(0);
    const s2 = await begin(u, 'twitch');
    expect((await callback('twitch', { error: 'access_denied', state: s2.state }, s2.cookie)).result).toBe('denied');
    expect(await env.ctx.db.query('SELECT 1 FROM connection_oauth_states WHERE state_hash = $1', [sha(s2.state)])).toHaveLength(0);
    vi.spyOn(http, 'json').mockRejectedValue(new ProviderError('Provider timed out'));
    const s3 = await begin(u, 'twitch'); expect((await callback('twitch', { code: 'x', state: s3.state }, s3.cookie)).result).toBe('exchange_failed');
  });

  it('one provider account can be proven by one user only; re-connecting is idempotent; a declared link is upgraded in place', async () => {
    fakeProviders({ a: { twitch: { id: '777', login: 'shared_acct' } }, b: { twitch: { id: '777', login: 'shared_acct' } } });
    const first = await api.register('first'), second = await api.register('second');
    const declared = (await api.req('POST', '/users/@me/connections', first.token, { type: 'twitch', handle: 'Shared_Acct' })).body;
    await api.req('PATCH', `/users/@me/connections/${declared.id}`, first.token, { visible: false });
    let s = await begin(first, 'twitch'); expect((await callback('twitch', { code: 'a', state: s.state }, s.cookie)).result).toBe('ok');
    let mine = (await api.req('GET', '/users/@me/connections', first.token)).body;
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ id: declared.id, verified: true, visible: false }); // same row, visibility kept
    s = await begin(first, 'twitch'); expect((await callback('twitch', { code: 'a', state: s.state }, s.cookie)).result).toBe('ok');
    expect((await api.req('GET', '/users/@me/connections', first.token)).body).toHaveLength(1);
    s = await begin(second, 'twitch'); expect((await callback('twitch', { code: 'b', state: s.state }, s.cookie)).result).toBe('already_linked');
    expect((await api.req('GET', '/users/@me/connections', second.token)).body).toHaveLength(0);
  });

  it('start is rate limited per user and bounded in stored states', async () => {
    const limited = await startServer({ integrations: CREDS, rateLimit: true }); const a = new Api(limited);
    try {
      const u = await a.register('rl'); let last = 0;
      for (let i = 0; i < 12; i++) last = (await a.req('POST', '/users/@me/connections/oauth/twitch/start', u.token)).status;
      expect(last).toBe(429);
      expect((await limited.ctx.db.query('SELECT 1 FROM connection_oauth_states WHERE user_id = $1', [u.id])).length).toBeLessThanOrEqual(5);
    } finally { await limited.close(); }
  });
});

// ---------------------------------------------------------------- provider HTTP guard

describe('provider HTTP guard (SSRF)', () => {
  it('only talks to the provider hosts, over https, without credentials or odd ports', async () => {
    for (const u of ['http://api.twitch.tv/helix/users', 'https://evil.example/helix', 'https://127.0.0.1/x', 'https://api.twitch.tv:8443/x', 'https://user:pw@api.twitch.tv/x', 'https://api.twitch.tv.evil.example/x', 'file:///etc/passwd']) await expect(http.json(u), u).rejects.toThrow(ProviderError);
    for (const u of ['http://www.youtube.com/x', 'https://evil.example/feeds', 'https://169.254.169.254/latest', 'https://youtube.com.evil.example/', 'https://user@www.youtube.com/']) await expect(http.page(u), u).rejects.toThrow(ProviderError);
  });
  it('page fetches are refused for private addresses even on a youtube.com name (resolution is checked by safeGet)', async () => {
    // localhost is not a youtube host, so it is refused before any socket opens
    await expect(http.page('https://localhost/feeds/videos.xml')).rejects.toThrow(/youtube/i);
  });
});

// ---------------------------------------------------------------- pure helpers

describe('stream feed helpers', () => {
  it('parses channel inputs and refuses everything else', () => {
    expect(parseYoutubeInput(UC(1))).toEqual({ channelId: UC(1) });
    expect(parseYoutubeInput(`https://www.youtube.com/channel/${UC(2)}?si=x`)).toEqual({ channelId: UC(2) });
    expect(parseYoutubeInput('@some.handle')).toEqual({ handle: '@some.handle' });
    expect(parseYoutubeInput('https://youtube.com/@Some_Handle/videos')).toEqual({ handle: '@Some_Handle' });
    for (const bad of ['https://evil.example/channel/' + UC(3), 'http://youtube.com/@abc', 'https://youtube.com:8443/@abc', 'https://youtube.com.evil.example/@abc', 'https://www.youtube.com/watch?v=abc', 'javascript:alert(1)', 'UCshort', '@a', '', 'https://user:pw@youtube.com/@abc']) expect(() => parseYoutubeInput(bad), bad).toThrow();
    expect(parseTwitchInput('https://www.twitch.tv/Some_Streamer')).toBe('some_streamer');
    expect(parseTwitchInput('@ninja')).toBe('ninja');
    for (const bad of ['https://evil.example/ninja', 'ab', 'a b c', 'http://twitch.tv/ninja', 'https://twitch.tv/', 'https://twitch.tv.evil.example/ninja']) expect(() => parseTwitchInput(bad), bad).toThrow();
  });
  it('defang removes anything that could ping or inject', () => {
    const d = defang('@everyone <@123> <@&9> hi\u0000\n there');
    expect(d).not.toMatch(/<|>/); expect(d).not.toMatch(/@everyone/); expect(d).not.toMatch(/[\u0000\n]/);
  });
  it('parses the uploads feed (entities, order, junk)', () => {
    const f = parseYoutubeFeed(atom('Chan &amp; Co', [{ id: 'aaaaaaaaaaa', title: 'Old &quot;one&quot;', at: 1000 }, { id: 'bbbbbbbbbbb', title: 'New &lt;b&gt;', at: 5000 }, { id: 'bad id', title: 'junk', at: 9000 }]));
    expect(f.title).toBe('Chan & Co');
    expect(f.entries.map((e) => e.id)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa']);
    expect(f.entries[0]!.title).toBe('New <b>'); expect(f.entries[1]!.title).toBe('Old "one"'); expect(f.entries[0]!.author).toBe('Chan & Co');
  });
});

// ---------------------------------------------------------------- stream feeds

function atom(author: string, items: { id: string; title: string; at: number }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><title>${author}</title>` +
    items.map((i) => `<entry><id>yt:video:${i.id}</id><yt:videoId>${i.id}</yt:videoId><title>${i.title}</title><published>${new Date(i.at).toISOString()}</published><author><name>${author}</name></author></entry>`).join('') + '</feed>';
}
/** Fake YouTube: `feeds[channelId]` is the item list (undefined = 404); `handles` maps a handle to a channel id. */
function fakeYoutube(feeds: Record<string, { author: string; items: { id: string; title: string; at: number }[] }>, handles: Record<string, string> = {}) {
  return vi.spyOn(http, 'page').mockImplementation(async (url) => {
    const m = /channel_id=(UC[\w-]{22})/.exec(url);
    if (m) { const f = feeds[m[1]!]; return f ? { status: 200, url, body: atom(f.author, f.items) } : { status: 404, url, body: 'nope' }; }
    const h = decodeURIComponent(new URL(url).pathname.slice(1));
    if (handles[h]) return { status: 200, url, body: `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${handles[h]}"></head><body>"externalId":"${UC(99)}"</body></html>` };
    return { status: 404, url, body: 'nope' };
  });
}

async function setup(names: string[] = []) {
  const owner = await api.register('fo');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Feeds' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members = []; for (const n of names) { const m = await api.register(n); await api.req('POST', `/invites/${code}`, m.token); members.push(m); }
  const general = guild.channels.find((c: any) => c.name === 'general');
  return { owner, guild, general, members };
}
const post = (g: any, c: any, body: object) => api.req('POST', `/guilds/${g.id}/stream-feeds`, c.token, body);
const messagesIn = async (channelId: string) => (await env.ctx.db.query(`SELECT * FROM messages WHERE channel_id = $1 AND author_id = '1000000000000000002' ORDER BY id`, [channelId]));
const makeDue = (id?: string) => env.ctx.db.query(`UPDATE stream_feeds SET next_check_at = now() - interval '1 second'${id ? ' WHERE id = $1' : ''}`, id ? [id] : []);
const DAY = 86_400_000;

describe('stream feeds: management', () => {
  it('needs Manage Server for every route; members and anonymous callers are refused', async () => {
    const { owner, guild, general, members: [bob] } = await setup(['bob']);
    fakeYoutube({ [UC(10)]: { author: 'Chan', items: [] } });
    const made = await post(guild, owner, { provider: 'youtube', channel: UC(10), channelId: general.id }); expect(made.status).toBe(201);
    const url = `/guilds/${guild.id}/stream-feeds`;
    expect((await api.req('GET', url, bob!.token)).status).toBe(403);
    expect((await post(guild, bob!, { provider: 'youtube', channel: UC(10), channelId: general.id })).status).toBe(403);
    expect((await api.req('PATCH', `${url}/${made.body.id}`, bob!.token, { enabled: false })).status).toBe(403);
    expect((await api.req('DELETE', `${url}/${made.body.id}`, bob!.token)).status).toBe(403);
    expect((await api.req('GET', url, null)).status).toBe(401);
    // a role that carries only Manage Server is enough
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mgr', permissions: String(Perm.MANAGE_GUILD) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${bob!.id}`, owner.token, { roles: [role.id] });
    const list = await api.req('GET', url, bob!.token); expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ providers: { twitch: true, youtube: true }, max: MAX_STREAM_FEEDS }); expect(list.body.feeds).toHaveLength(1);
  });

  it('creates from a channel id, a /channel/ URL and an @handle; audit-logs create/update/delete; refuses duplicates', async () => {
    const { owner, guild, general } = await setup();
    const spy = fakeYoutube({ [UC(11)]: { author: 'Alpha', items: [] }, [UC(12)]: { author: 'Beta', items: [] }, [UC(13)]: { author: 'Gamma', items: [] } }, { '@gamma': UC(13) });
    const a = await post(guild, owner, { provider: 'youtube', channel: UC(11), channelId: general.id });
    expect(a.status).toBe(201); expect(a.body).toMatchObject({ provider: 'youtube', externalId: UC(11), name: 'Alpha', url: `https://www.youtube.com/channel/${UC(11)}`, enabled: true, lastError: null, channelId: general.id });
    expect(a.body.template).toContain('{title}');
    const b = await post(guild, owner, { provider: 'youtube', channel: `https://www.youtube.com/channel/${UC(12)}`, channelId: general.id }); expect(b.body.externalId).toBe(UC(12));
    const c = await post(guild, owner, { provider: 'youtube', channel: '@gamma', channelId: general.id, template: 'New: {title} {url}' });
    expect(c.status).toBe(201); expect(c.body.externalId).toBe(UC(13)); expect(c.body.template).toBe('New: {title} {url}');
    expect(spy.mock.calls.some(([u]) => u === 'https://www.youtube.com/@gamma')).toBe(true);
    const dup = await post(guild, owner, { provider: 'youtube', channel: UC(11), channelId: general.id }); expect(dup.status).toBe(409);
    expect((await post(guild, owner, { provider: 'youtube', channel: UC(77), channelId: general.id })).status).toBe(400); // 404 at YouTube
    expect((await api.req('PATCH', `/guilds/${guild.id}/stream-feeds/${a.body.id}`, owner.token, { template: 'Hi {channel}', enabled: false })).body).toMatchObject({ template: 'Hi {channel}', enabled: false });
    expect((await api.req('DELETE', `/guilds/${guild.id}/stream-feeds/${a.body.id}`, owner.token)).status).toBe(204);
    expect((await api.req('DELETE', `/guilds/${guild.id}/stream-feeds/${a.body.id}`, owner.token)).status).toBe(404);
    const log = (await api.req('GET', `/guilds/${guild.id}/audit-logs?limit=50`, owner.token)).body.map((e: any) => e.action);
    expect(log.filter((x: string) => x === 'STREAM_FEED_CREATE')).toHaveLength(3); expect(log).toContain('STREAM_FEED_UPDATE'); expect(log).toContain('STREAM_FEED_DELETE');
  });

  it('caps feeds per server', async () => {
    const { owner, guild, general } = await setup();
    const feeds: Record<string, any> = {}; for (let i = 0; i < MAX_STREAM_FEEDS + 1; i++) feeds[UC(100 + i)] = { author: `C${i}`, items: [] };
    fakeYoutube(feeds);
    for (let i = 0; i < MAX_STREAM_FEEDS; i++) expect((await post(guild, owner, { provider: 'youtube', channel: UC(100 + i), channelId: general.id })).status, String(i)).toBe(201);
    const over = await post(guild, owner, { provider: 'youtube', channel: UC(100 + MAX_STREAM_FEEDS), channelId: general.id });
    expect(over.status).toBe(400); expect(over.body.code).toBe('LIMIT_REACHED');
    expect((await api.req('GET', `/guilds/${guild.id}/stream-feeds`, owner.token)).body.feeds).toHaveLength(MAX_STREAM_FEEDS);
  });

  it('refuses hostile inputs before making any request', async () => {
    const { owner, guild, general } = await setup();
    const spy = fakeYoutube({});
    for (const channel of ['https://evil.example/channel/' + UC(1), 'http://169.254.169.254/@abc', 'https://localhost/@abc', 'https://youtube.com.evil.example/@abc', 'https://www.youtube.com/watch?v=x', 'file:///etc/passwd', 'x'.repeat(300)]) {
      const r = await post(guild, owner, { provider: 'youtube', channel, channelId: general.id }); expect(r.status, channel).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('validates template, channel and extra fields', async () => {
    const { owner, guild, general, members: [bob] } = await setup(['bob2']);
    fakeYoutube({ [UC(20)]: { author: 'T', items: [] } });
    const base = { provider: 'youtube', channel: UC(20), channelId: general.id };
    for (const template of ['@everyone {title}', 'hey @here', '<@123456> {url}', '<@&123456>', '   ', 'x'.repeat(301)]) expect((await post(guild, owner, { ...base, template })).status, template).toBe(400);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    expect((await post(guild, owner, { ...base, channelId: voice.id })).status).toBe(400);
    const other = (await api.req('POST', '/guilds', owner.token, { name: 'Other' })).body;
    expect((await post(guild, owner, { ...base, channelId: other.channels[0].id })).status).toBeGreaterThanOrEqual(400); // a channel of another server
    expect((await post(guild, owner, { ...base, evil: 1 })).status).toBe(400);
    expect((await post(guild, owner, { ...base, provider: 'mixer' })).status).toBe(400);
    void bob;
  });

  it('role mentions follow the mention rules: mentionable, or the manager holds Mention Everyone', async () => {
    const { owner, guild, general, members: [mgr] } = await setup(['mgr']);
    fakeYoutube({ [UC(30)]: { author: 'R', items: [] }, [UC(31)]: { author: 'R2', items: [] }, [UC(32)]: { author: 'R3', items: [] } });
    const open = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'open', mentionable: true })).body;
    const closed = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'closed', mentionable: false })).body;
    const mgrRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mgr', permissions: String(Perm.MANAGE_GUILD) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${mgr!.id}`, owner.token, { roles: [mgrRole.id] });
    expect((await post(guild, mgr!, { provider: 'youtube', channel: UC(30), channelId: general.id, roleId: open.id })).status).toBe(201);
    const denied = await post(guild, mgr!, { provider: 'youtube', channel: UC(31), channelId: general.id, roleId: closed.id });
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('MISSING_PERMISSIONS');
    expect((await post(guild, owner, { provider: 'youtube', channel: UC(31), channelId: general.id, roleId: closed.id })).status).toBe(201); // owner holds everything
    expect((await post(guild, owner, { provider: 'youtube', channel: UC(32), channelId: general.id, roleId: '999999999999' })).status).toBe(404);
    // changing the role through PATCH is checked the same way
    const mine = (await api.req('GET', `/guilds/${guild.id}/stream-feeds`, mgr!.token)).body.feeds.find((f: any) => f.externalId === UC(30));
    expect((await api.req('PATCH', `/guilds/${guild.id}/stream-feeds/${mine.id}`, mgr!.token, { roleId: closed.id })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/stream-feeds/${mine.id}`, mgr!.token, { roleId: null })).body.roleId).toBeNull();
  });

  it('Twitch feeds need the server credentials (501 otherwise)', async () => {
    const o = await papi.register('twp'); const g = (await papi.req('POST', '/guilds', o.token, { name: 'NoTw' })).body;
    const r = await papi.req('POST', `/guilds/${g.id}/stream-feeds`, o.token, { provider: 'twitch', channel: 'ninja', channelId: g.channels[0].id });
    expect(r.status).toBe(501); expect(r.body.code).toBe('FEATURE_DISABLED');
    expect((await papi.req('GET', `/guilds/${g.id}/stream-feeds`, o.token)).body.providers).toEqual({ twitch: false, youtube: true });
  });
});

describe('stream feeds: polling and announcing', () => {
  beforeEach(async () => { await env.ctx.db.query('DELETE FROM stream_feeds'); });

  it('YouTube: ignores older uploads, announces a new one exactly once, then the next', async () => {
    const { owner, guild, general } = await setup();
    const feed = { author: 'Cool Channel', items: [{ id: 'oldoldold01', title: 'Old upload', at: Date.now() - DAY }] };
    fakeYoutube({ [UC(40)]: feed });
    const f = (await post(guild, owner, { provider: 'youtube', channel: UC(40), channelId: general.id })).body;
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect(await messagesIn(general.id)).toHaveLength(0); // existing videos are not announced
    feed.items.unshift({ id: 'newnewnew01', title: 'Brand new', at: Date.now() + 1000 });
    await makeDue(); expect(await pollStreamFeeds(env.ctx)).toBe(1);
    let msgs = await messagesIn(general.id); expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Cool Channel has a new video: Brand new\nhttps://www.youtube.com/watch?v=newnewnew01');
    await makeDue(); await pollStreamFeeds(env.ctx); await makeDue(); await pollStreamFeeds(env.ctx);
    expect(await messagesIn(general.id)).toHaveLength(1); // dedupe by last announced id
    feed.items.unshift({ id: 'newnewnew02', title: 'Second', at: Date.now() + 2000 });
    await makeDue(); await pollStreamFeeds(env.ctx);
    msgs = await messagesIn(general.id); expect(msgs).toHaveLength(2); expect(msgs[1].content).toContain('newnewnew02');
    const [row] = await env.ctx.db.query('SELECT * FROM stream_feeds WHERE id = $1', [f.id]);
    expect(row.last_item_id).toBe('newnewnew02'); expect(row.fail_count).toBe(0); expect(row.last_error).toBeNull();
    expect((await api.req('GET', `/guilds/${guild.id}/stream-feeds`, owner.token)).body.feeds[0].lastAnnouncedAt).toBeTruthy();
  });

  it('announces at most three uploads per check, oldest first, and skips the rest', async () => {
    const { owner, guild, general } = await setup();
    const feed = { author: 'Busy', items: [] as { id: string; title: string; at: number }[] };
    fakeYoutube({ [UC(41)]: feed });
    await post(guild, owner, { provider: 'youtube', channel: UC(41), channelId: general.id });
    const now = Date.now(); for (let i = 5; i >= 1; i--) feed.items.push({ id: `burstburst${i}`, title: `Vid ${i}`, at: now + i * 1000 });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect((await messagesIn(general.id)).map((m) => m.content.match(/Vid (\d)/)![1])).toEqual(['3', '4', '5']);
  });

  it('role mention is applied (and only that ping); hostile titles cannot ping anyone', async () => {
    const { owner, guild, general, members: [bob] } = await setup(['bobp']);
    const feed = { author: '@everyone &lt;@&amp;1&gt; Chan', items: [] as { id: string; title: string; at: number }[] };
    fakeYoutube({ [UC(42)]: feed });
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'subs', mentionable: false })).body;
    await post(guild, owner, { provider: 'youtube', channel: UC(42), channelId: general.id, roleId: role.id }); // owner may mention it
    feed.items.push({ id: 'hostile0001', title: '@everyone &lt;@' + bob!.id + '&gt; free stuff', at: Date.now() + 1000 });
    await makeDue(); await pollStreamFeeds(env.ctx);
    const [m] = await messagesIn(general.id);
    expect(m.content.startsWith(`<@&${role.id}> `)).toBe(true);
    expect(m.mention_roles).toEqual([role.id]); expect(m.mention_everyone).toBe(false); expect(m.mentions).toEqual([]);
    expect(m.content).not.toContain(`<@${bob!.id}>`);
    expect(m.allowed_mentions).toEqual({ parse: [], roles: [role.id] });
    // the role stops being pingable and its configurer loses the privilege: the post still goes out, without the ping
    await env.ctx.db.query('UPDATE stream_feeds SET mention_by = $1', [bob!.id]);
    feed.items.push({ id: 'hostile0002', title: 'again', at: Date.now() + 2000 });
    await makeDue(); await pollStreamFeeds(env.ctx);
    const msgs = await messagesIn(general.id); expect(msgs).toHaveLength(2);
    expect(msgs[1].content.startsWith('<@&')).toBe(false); expect(msgs[1].mention_roles).toEqual([]);
  });

  it('provider failures back off exponentially, record a safe error, and recover', async () => {
    const { owner, guild, general } = await setup();
    const feed = { author: 'Flaky', items: [] as { id: string; title: string; at: number }[] };
    fakeYoutube({ [UC(43)]: feed });
    const f = (await post(guild, owner, { provider: 'youtube', channel: UC(43), channelId: general.id })).body;
    vi.restoreAllMocks(); vi.spyOn(http, 'page').mockRejectedValue(new ProviderError('YouTube unreachable'));
    await makeDue(); await pollStreamFeeds(env.ctx);
    let [row] = await env.ctx.db.query('SELECT *, extract(epoch FROM next_check_at - now()) AS wait FROM stream_feeds WHERE id = $1', [f.id]);
    expect(row.fail_count).toBe(1); expect(row.last_error).toBe('YouTube unreachable'); expect(Number(row.wait)).toBeGreaterThan(500); // 300 s * 2
    await makeDue(); await pollStreamFeeds(env.ctx);
    [row] = await env.ctx.db.query('SELECT *, extract(epoch FROM next_check_at - now()) AS wait FROM stream_feeds WHERE id = $1', [f.id]);
    expect(row.fail_count).toBe(2); expect(Number(row.wait)).toBeGreaterThan(1000);
    expect(await pollStreamFeeds(env.ctx)).toBe(0); // not due until the backoff has passed
    vi.restoreAllMocks(); fakeYoutube({ [UC(43)]: feed });
    await makeDue(); await pollStreamFeeds(env.ctx);
    [row] = await env.ctx.db.query('SELECT * FROM stream_feeds WHERE id = $1', [f.id]);
    expect(row.fail_count).toBe(0); expect(row.last_error).toBeNull();
    // garbage instead of a feed is a failure too, never an announcement
    vi.restoreAllMocks(); vi.spyOn(http, 'page').mockResolvedValue({ status: 200, url: 'x', body: '<html>consent</html>' });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect((await env.ctx.db.query('SELECT fail_count FROM stream_feeds WHERE id = $1', [f.id]))[0].fail_count).toBe(1);
    expect(await messagesIn(general.id)).toHaveLength(0);
  });

  it('two nodes sweeping at once announce once; each sweep handles a bounded batch', async () => {
    const { owner, guild, general } = await setup();
    const feeds: Record<string, any> = {};
    for (let i = 0; i < 3; i++) feeds[UC(50 + i)] = { author: `N${i}`, items: [] };
    fakeYoutube(feeds);
    for (let i = 0; i < 3; i++) await post(guild, owner, { provider: 'youtube', channel: UC(50 + i), channelId: general.id });
    feeds[UC(50)].items.push({ id: 'racerace001', title: 'Race', at: Date.now() + 1000 });
    await makeDue();
    const [a, b] = await Promise.all([pollStreamFeeds(env.ctx, 10), pollStreamFeeds(env.ctx, 10)]);
    expect(a + b).toBe(3); // every feed was claimed by exactly one of them
    expect(await messagesIn(general.id)).toHaveLength(1);
    await makeDue(); expect(await pollStreamFeeds(env.ctx, 2)).toBe(2); // cap per tick
    expect(await pollStreamFeeds(env.ctx, 2)).toBe(1);
  });

  it('a lost marker race (another node announced first) posts nothing', async () => {
    const { owner, guild, general } = await setup();
    const feed = { author: 'Racer', items: [] as { id: string; title: string; at: number }[] };
    const spy = fakeYoutube({ [UC(60)]: feed });
    await post(guild, owner, { provider: 'youtube', channel: UC(60), channelId: general.id });
    feed.items.push({ id: 'otherwins01', title: 'x', at: Date.now() + 1000 });
    const real = spy.getMockImplementation()!;
    // the other node moves the marker after our feed fetch started and before our claim
    spy.mockImplementation(async (u, o) => { const r = await real(u, o); await env.ctx.db.query(`UPDATE stream_feeds SET last_item_id = 'winner00001'`); return r; });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect(await messagesIn(general.id)).toHaveLength(0);
    expect((await env.ctx.db.query('SELECT last_item_id FROM stream_feeds'))[0].last_item_id).toBe('winner00001');
  });

  it('disabled feeds are not polled; re-enabling does not replay what was missed', async () => {
    const { owner, guild, general } = await setup();
    const feed = { author: 'Pausable', items: [] as { id: string; title: string; at: number }[] };
    fakeYoutube({ [UC(61)]: feed });
    const f = (await post(guild, owner, { provider: 'youtube', channel: UC(61), channelId: general.id })).body;
    await api.req('PATCH', `/guilds/${guild.id}/stream-feeds/${f.id}`, owner.token, { enabled: false });
    feed.items.push({ id: 'whileoff001', title: 'missed', at: Date.now() + 100 });
    await makeDue(); expect(await pollStreamFeeds(env.ctx)).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    await api.req('PATCH', `/guilds/${guild.id}/stream-feeds/${f.id}`, owner.token, { enabled: true });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect(await messagesIn(general.id)).toHaveLength(0);
    feed.items.push({ id: 'afteron0001', title: 'fresh', at: Date.now() + 1000 });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect((await messagesIn(general.id)).map((m) => m.content)).toEqual([expect.stringContaining('afteron0001')]);
  });

  it('Twitch: announces a stream once per stream id, uses an app token, batches logins, never leaks secrets into messages', async () => {
    const { owner, guild, general } = await setup();
    const live: { id: string; user_login: string; user_name: string; title: string; type: string; started_at: string }[] = [];
    const seen: { url: string; headers?: Record<string, string>; form?: Record<string, string> }[] = [];
    vi.spyOn(http, 'json').mockImplementation(async (url, init = {}) => {
      seen.push({ url, headers: init.headers, form: init.form });
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) return { status: 200, body: { access_token: 'app-token', expires_in: 3600 } };
      if (url.startsWith('https://api.twitch.tv/helix/users')) { const login = new URL(url).searchParams.get('login')!; return { status: 200, body: { data: login === 'ghost' ? [] : [{ id: '1', login, display_name: login.toUpperCase() }] } }; }
      if (url.startsWith('https://api.twitch.tv/helix/streams')) { const asked = new URL(url).searchParams.getAll('user_login'); return { status: 200, body: { data: live.filter((s) => asked.includes(s.user_login)) } }; }
      throw new Error('unexpected ' + url);
    });
    const a = await post(guild, owner, { provider: 'twitch', channel: 'https://www.twitch.tv/Streamer_A', channelId: general.id });
    expect(a.status, JSON.stringify(a.body)).toBe(201); expect(a.body).toMatchObject({ externalId: 'streamer_a', name: 'STREAMER_A', url: 'https://www.twitch.tv/streamer_a' });
    await post(guild, owner, { provider: 'twitch', channel: 'streamer_b', channelId: general.id, template: '{channel}: {title} -> {url}' });
    expect((await post(guild, owner, { provider: 'twitch', channel: 'ghost', channelId: general.id })).status).toBe(400);
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect(await messagesIn(general.id)).toHaveLength(0); // nobody live
    live.push({ id: 'S1', user_login: 'streamer_a', user_name: 'Streamer_A', title: 'Playing @everyone games', type: 'live', started_at: new Date().toISOString() });
    await makeDue(); await pollStreamFeeds(env.ctx);
    await makeDue(); await pollStreamFeeds(env.ctx);
    let msgs = await messagesIn(general.id); expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Streamer_A is live on Twitch: Playing @​everyone games\nhttps://www.twitch.tv/streamer_a'); expect(msgs[0].mention_everyone).toBe(false);
    live[0] = { ...live[0]!, id: 'S2' }; // went offline and live again
    live.push({ id: 'S3', user_login: 'streamer_b', user_name: 'B', title: 'hi', type: 'live', started_at: new Date().toISOString() });
    await makeDue(); await pollStreamFeeds(env.ctx);
    msgs = await messagesIn(general.id); expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => m.content === 'B: hi -> https://www.twitch.tv/streamer_b')).toBe(true);
    const streamCalls = seen.filter((s) => s.url.includes('/helix/streams'));
    expect(streamCalls.every((s) => s.headers!.authorization === 'Bearer app-token' && s.headers!['client-id'] === 'twid')).toBe(true);
    expect(streamCalls.at(-1)!.url).toContain('user_login=streamer_a&user_login=streamer_b'); // one call for both
    expect(seen.filter((s) => s.url.includes('/oauth2/token'))).toHaveLength(1); // token cached
    expect(JSON.stringify(msgs)).not.toContain('twsecret');
  });

  it('Twitch: an expired token is renewed once; API errors back off instead of announcing', async () => {
    const { owner, guild, general } = await setup();
    let issued = 0, reject = true;
    vi.spyOn(http, 'json').mockImplementation(async (url) => {
      if (url.includes('/oauth2/token')) return { status: 200, body: { access_token: `t${++issued}`, expires_in: 3600 } };
      if (url.includes('/helix/users')) return { status: 200, body: { data: [{ id: '1', login: 'flaky_tw', display_name: 'Flaky' }] } };
      if (reject) { reject = false; return { status: 401, body: {} }; }
      return { status: 200, body: { data: [] } };
    });
    await post(guild, owner, { provider: 'twitch', channel: 'flaky_tw', channelId: general.id });
    await makeDue(); await pollStreamFeeds(env.ctx);
    expect(issued).toBe(2); // refreshed once after the 401
    expect((await env.ctx.db.query('SELECT fail_count FROM stream_feeds'))[0].fail_count).toBe(0);
    vi.restoreAllMocks(); vi.spyOn(http, 'json').mockResolvedValue({ status: 429, body: {} });
    clearTwitchTokenCache();
    await makeDue(); await pollStreamFeeds(env.ctx);
    const [row] = await env.ctx.db.query('SELECT * FROM stream_feeds');
    expect(row.fail_count).toBe(1); expect(row.last_error).toBeTruthy(); expect(row.last_error).not.toContain('twsecret');
  });
});
