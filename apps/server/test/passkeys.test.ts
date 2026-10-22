import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';
import { SoftAuthenticator } from './softauthn';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });
const PW = 'correct horse battery';

async function enroll(u: Client, authn = new SoftAuthenticator(), name?: string) {
  const o = await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW });
  expect(o.status).toBe(200);
  const r = await api.req('POST', '/auth/passkeys/register/verify', u.token, { name, response: authn.register(o.body) });
  return { authn, r, options: o.body };
}
const handle = (u: Client) => Buffer.from(u.id, 'utf8').toString('base64url');
async function passkeyLogin(authn: SoftAuthenticator, u: Client, opts: Parameters<SoftAuthenticator['assert']>[1] = {}) {
  const o = await api.req('POST', '/auth/passkey/login/options', null, {});
  expect(o.body.allowCredentials).toBeUndefined(); // discoverable: no account hint leaks
  return api.req('POST', '/auth/passkey/login/verify', null, { response: authn.assert(o.body, { userHandle: handle(u), ...opts }) });
}

describe('passkeys: management', () => {
  it('registers, lists (no secrets), renames and deletes behind re-authentication', async () => {
    const u = await api.register('pk');
    const { r } = await enroll(u, undefined, 'Laptop');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Laptop', lastUsedAt: null });
    expect(Object.keys(r.body).sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'lastUsedAt', 'name', 'transports']);
    expect((await api.req('GET', '/auth/passkeys', u.token)).body).toHaveLength(1);
    expect((await api.req('PATCH', `/auth/passkeys/${r.body.id}`, u.token, { name: 'Work laptop' })).body.name).toBe('Work laptop');
    expect((await api.req('DELETE', `/auth/passkeys/${r.body.id}`, u.token, { password: 'wrong password!!' })).status).toBe(401);
    expect((await api.req('DELETE', `/auth/passkeys/${r.body.id}`, u.token, { password: PW })).status).toBe(204);
    expect((await api.req('GET', '/auth/passkeys', u.token)).body).toEqual([]);
    expect(env.ctx.mailer.outbox.filter((m) => m.to === u.user.email && m.subject.includes('passkey')).length).toBe(2); // added + removed notices
  });

  it('needs the password (and TOTP when on) to start registration', async () => {
    const u = await api.register('pkre');
    expect((await api.req('POST', '/auth/passkeys/register/options', u.token, { password: 'nope nope nope' })).status).toBe(401);
    expect((await api.req('POST', '/auth/passkeys/register/options', null, { password: PW })).status).toBe(401);
    const s = await api.req('POST', '/auth/mfa/setup', u.token);
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(s.body.secret) });
    const noCode = await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW });
    expect(noCode.body.code).toBe('MFA_REQUIRED');
    expect((await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW, totp: authenticator.generate(s.body.secret) })).status).toBe(200);
  });

  it('cannot touch or delete another user\'s passkey (IDOR)', async () => {
    const a = await api.register('pka'), b = await api.register('pkb');
    const { r } = await enroll(a);
    expect((await api.req('PATCH', `/auth/passkeys/${r.body.id}`, b.token, { name: 'mine now' })).status).toBe(404);
    expect((await api.req('DELETE', `/auth/passkeys/${r.body.id}`, b.token, { password: PW })).status).toBe(404);
    expect((await api.req('GET', '/auth/passkeys', b.token)).body).toEqual([]);
    expect((await api.req('GET', '/auth/passkeys', a.token)).body).toHaveLength(1);
  });

  it('rejects the same authenticator twice, a challenge from another user, a replay and a wrong origin', async () => {
    const a = await api.register('pkx'), b = await api.register('pky');
    const { authn } = await enroll(a);
    const o = await api.req('POST', '/auth/passkeys/register/options', a.token, { password: PW });
    expect(o.body.excludeCredentials).toHaveLength(1);
    expect((await api.req('POST', '/auth/passkeys/register/verify', a.token, { response: authn.register(o.body) })).status).toBe(409);
    // challenge issued to a, replayed by b
    const o2 = await api.req('POST', '/auth/passkeys/register/options', a.token, { password: PW });
    const fresh = new SoftAuthenticator();
    expect((await api.req('POST', '/auth/passkeys/register/verify', b.token, { response: fresh.register(o2.body) })).status).toBe(400);
    // the stolen challenge was burned by the failed attempt
    expect((await api.req('POST', '/auth/passkeys/register/verify', a.token, { response: fresh.register(o2.body) })).status).toBe(400);
    // wrong origin (phishing site)
    const o3 = await api.req('POST', '/auth/passkeys/register/options', a.token, { password: PW });
    expect((await api.req('POST', '/auth/passkeys/register/verify', a.token, { response: new SoftAuthenticator().register(o3.body, { origin: 'https://evil.example' }) })).status).toBe(400);
    // no user verification
    const o4 = await api.req('POST', '/auth/passkeys/register/options', a.token, { password: PW });
    expect((await api.req('POST', '/auth/passkeys/register/verify', a.token, { response: new SoftAuthenticator().register(o4.body, { uv: false }) })).status).toBe(400);
  });

  it('expired challenges are refused', async () => {
    const u = await api.register('pkexp');
    const o = await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW });
    await env.ctx.db.query(`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second'`);
    expect((await api.req('POST', '/auth/passkeys/register/verify', u.token, { response: new SoftAuthenticator().register(o.body) })).status).toBe(400);
  });
});

describe('passkeys: sign in', () => {
  it('signs in passwordless, issues a normal session, bumps counter and last-used', async () => {
    const u = await api.register('pkl');
    const { authn } = await enroll(u);
    const r = await passkeyLogin(authn, u);
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(u.id);
    expect((await api.req('GET', '/users/@me', r.body.accessToken)).status).toBe(200);
    expect((await api.req('POST', '/auth/refresh', null, { refreshToken: r.body.refreshToken })).status).toBe(200);
    const [row] = await env.ctx.db.query('SELECT counter, last_used_at FROM user_passkeys WHERE user_id = $1', [u.id]);
    expect(Number(row.counter)).toBe(authn.counter);
    expect(row.last_used_at).toBeTruthy();
    expect((await api.req('GET', '/auth/sessions', r.body.accessToken)).body.length).toBeGreaterThanOrEqual(2);
  });

  it('challenges are single use (replayed assertion fails)', async () => {
    const u = await api.register('pkr');
    const { authn } = await enroll(u);
    const o = await api.req('POST', '/auth/passkey/login/options', null, {});
    const assertion = authn.assert(o.body, { userHandle: handle(u) });
    expect((await api.req('POST', '/auth/passkey/login/verify', null, { response: assertion })).status).toBe(200);
    expect((await api.req('POST', '/auth/passkey/login/verify', null, { response: assertion })).status).toBe(400);
  });

  it('rejects a stale counter (cloned authenticator), wrong origin, missing UV and unknown credentials', async () => {
    const u = await api.register('pkc');
    const { authn } = await enroll(u);
    expect((await passkeyLogin(authn, u)).status).toBe(200);            // counter 1
    expect((await passkeyLogin(authn, u)).status).toBe(200);            // counter 2
    expect((await passkeyLogin(authn, u, { counter: 1 })).status).toBe(400); // clone replays an old counter
    expect((await passkeyLogin(authn, u, { counter: 50 })).status).toBe(200);
    expect((await passkeyLogin(authn, u, { origin: 'https://evil.example' })).status).toBe(400);
    expect((await passkeyLogin(authn, u, { uv: false })).status).toBe(400);
    expect((await passkeyLogin(new SoftAuthenticator(), u)).status).toBe(400);
  });

  it('allows authenticators that always report counter 0', async () => {
    const u = await api.register('pkz');
    const authn = new SoftAuthenticator(); authn.fixedCounter = 0;
    await enroll(u, authn);
    expect((await passkeyLogin(authn, u)).status).toBe(200);
    expect((await passkeyLogin(authn, u)).status).toBe(200);
  });

  it('does not sign in disabled or deleted accounts, and a deleted passkey stops working', async () => {
    const u = await api.register('pkd');
    const { authn, r } = await enroll(u);
    await env.ctx.db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [u.id]);
    expect((await passkeyLogin(authn, u)).status).toBe(403);
    await env.ctx.db.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [u.id]);
    await api.req('DELETE', `/auth/passkeys/${r.body.id}`, u.token, { password: PW });
    expect((await passkeyLogin(authn, u)).status).toBe(400);
  });

  it('removes passkeys when the account is deleted', async () => {
    const u = await api.register('pkdel');
    await enroll(u);
    expect((await api.req('DELETE', '/users/@me', u.token, { password: PW })).status).toBe(204);
    expect((await env.ctx.db.query('SELECT 1 FROM user_passkeys WHERE user_id = $1', [u.id])).length).toBe(0);
  });

  it('rate-limits failed passkey attempts per IP', async () => {
    const e2 = await startServer({ rateLimit: true });
    try {
      const a2 = new Api(e2);
      let last = 0;
      for (let i = 0; i < 20; i++) {
        const o = await a2.req('POST', '/auth/passkey/login/options', null, {});
        last = (await a2.req('POST', '/auth/passkey/login/verify', null, { response: new SoftAuthenticator().assert(o.body) })).status;
        if (last === 429) break;
      }
      expect(last).toBe(429);
    } finally { await e2.close(); }
  });
});

describe('passkeys: second factor', () => {
  it('without passkeys an MFA account only advertises TOTP', async () => {
    const u = await api.register('pkm');
    const s = await api.req('POST', '/auth/mfa/setup', u.token);
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(s.body.secret) });
    const noKey = await api.req('POST', '/auth/login', null, { email: u.user.email, password: PW });
    expect(noKey.body).toMatchObject({ code: 'MFA_REQUIRED', methods: ['totp'] });
    expect(noKey.body.mfaTicket).toBeUndefined();
  });

  it('full flow: password -> ticket -> assertion -> session; ticket is single use and bound to the user', async () => {
    const u = await api.register('pkm2'), other = await api.register('pkm3');
    const s = await api.req('POST', '/auth/mfa/setup', u.token);
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(s.body.secret) });
    const o0 = await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW, totp: authenticator.generate(s.body.secret) });
    const authn = new SoftAuthenticator();
    expect((await api.req('POST', '/auth/passkeys/register/verify', u.token, { response: authn.register(o0.body) })).status).toBe(201);
    const otherAuthn = (await enroll(other)).authn;

    const step1 = await api.req('POST', '/auth/login', null, { email: u.user.email, password: PW });
    expect(step1.body).toMatchObject({ code: 'MFA_REQUIRED', methods: ['totp', 'passkey'] });
    const ticket = step1.body.mfaTicket as string;

    // the other user's passkey cannot satisfy this ticket
    const oBad = await api.req('POST', '/auth/passkey/mfa/options', null, { ticket });
    expect(oBad.body.allowCredentials).toHaveLength(1);
    expect((await api.req('POST', '/auth/passkey/mfa/verify', null, { ticket, response: otherAuthn.assert(oBad.body) })).status).toBe(400);

    const o = await api.req('POST', '/auth/passkey/mfa/options', null, { ticket });
    const res = await api.req('POST', '/auth/passkey/mfa/verify', null, { ticket, response: authn.assert(o.body) });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(u.id);
    // ticket consumed
    const o2 = await api.req('POST', '/auth/passkey/mfa/options', null, { ticket });
    expect(o2.status).toBe(400);
    expect((await api.req('POST', '/auth/passkey/mfa/options', null, { ticket: 'x'.repeat(40) })).status).toBe(400);
  });
});
