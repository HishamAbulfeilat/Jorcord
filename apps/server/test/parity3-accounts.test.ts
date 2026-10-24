import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PW = 'correct horse battery';
const mailTo = (e: TestEnv, email: string, subject?: string) => e.ctx.mailer.outbox.filter((m) => m.to === email && (!subject || m.subject.includes(subject)));
const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;
const until = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('username change', () => {
  it('needs the password, validates, keeps case-folded uniqueness and updates the profile', async () => {
    const a = await api.register('una'); const b = await api.register('unb');
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'fresh.name' })).status).toBe(400); // no password
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'fresh.name', password: 'wrong password' })).status).toBe(401);
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'x', password: PW })).status).toBe(400);
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'bad name!', password: PW })).status).toBe(400);
    expect((await api.req('POST', '/users/@me/username', a.token, { username: b.username.toUpperCase(), password: PW })).status).toBe(409); // case-folded clash
    expect((await api.req('POST', '/users/@me/username', a.token, { username: a.username, password: PW })).status).toBe(400); // unchanged
    const ok = await api.req('POST', '/users/@me/username', a.token, { username: 'Fresh.Name', password: PW });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('fresh.name');
    expect(ok.body.changesLeft).toBe(1);
    expect((await api.req('GET', '/users/@me', a.token)).body.username).toBe('fresh.name');
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.username).toBe('fresh.name'); // others see it
    expect((await api.req('GET', `/users?username=fresh.name`, b.token)).body.id).toBe(a.id);
  });

  it('allows 2 changes per 30 days, then answers 429 with the date the next one opens', async () => {
    const a = await api.register('unc');
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'cool.one', password: PW })).status).toBe(200);
    const second = await api.req('POST', '/users/@me/username', a.token, { username: 'cool.two', password: PW });
    expect(second.status).toBe(200); expect(second.body.changesLeft).toBe(0); expect(second.body.nextChangeAt).toBeTruthy();
    const third = await api.req('POST', '/users/@me/username', a.token, { username: 'cool.three', password: PW });
    expect(third.status).toBe(429); expect(third.body.code).toBe('USERNAME_COOLDOWN'); expect(third.body.nextChangeAt).toBeTruthy();
    // the window rolls: pretend both changes are 31 days old
    await env.ctx.db.query(`UPDATE username_history SET changed_at = now() - interval '31 days' WHERE user_id = $1`, [a.id]);
    expect((await api.req('GET', '/users/@me/username', a.token)).body).toEqual({ changesLeft: 2, nextChangeAt: null });
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'cool.three', password: PW })).status).toBe(200);
  });

  it('reserves the released handle for 14 days: nobody else can register or switch to it, the old owner can take it back', async () => {
    const a = await api.register('res'); const b = await api.register('resb');
    const old = a.username;
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'moved.on.res', password: PW })).status).toBe(200);
    expect((await api.req('POST', '/users/@me/username', b.token, { username: old, password: PW })).status).toBe(409);
    expect((await api.req('POST', '/auth/register', null, { email: 'squat@example.com', username: old, password: PW })).status).toBe(400);
    await env.ctx.db.query(`UPDATE reserved_usernames SET reserved_until = now() - interval '1 minute' WHERE username = $1`, [old]); // 14 days later
    expect((await api.req('POST', '/auth/register', null, { email: 'squat2@example.com', username: old, password: PW })).status).toBe(201);
    // the previous owner's own reservation does not block them
    const c = await api.register('resc'); const cOld = c.username;
    await api.req('POST', '/users/@me/username', c.token, { username: 'moved.on.resc', password: PW });
    expect((await api.req('POST', '/users/@me/username', c.token, { username: cOld, password: PW })).status).toBe(200);
  });

  it('needs the 2FA code when two-factor is on', async () => {
    const a = await api.register('un2');
    const s = (await api.req('POST', '/auth/mfa/setup', a.token)).body;
    await api.req('POST', '/auth/mfa/enable', a.token, { code: authenticator.generate(s.secret) });
    const r = await api.req('POST', '/users/@me/username', a.token, { username: 'with.mfa.un2', password: PW });
    expect(r.status).toBe(401); expect(r.body.code).toBe('MFA_REQUIRED');
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'with.mfa.un2', password: PW, totp: '000000' })).status).toBe(401);
    expect((await api.req('POST', '/users/@me/username', a.token, { username: 'with.mfa.un2', password: PW, totp: authenticator.generate(s.secret) })).status).toBe(200);
  });
});

describe('email change', () => {
  it('verifies the new address, notices the old one, applies on confirm and signs every device out', async () => {
    const strict = await startServer({ requireEmailVerification: true });
    try {
      const sapi = new Api(strict);
      const reg = await sapi.req('POST', '/auth/register', null, { email: 'old@example.com', username: 'mover', password: PW });
      expect(reg.body.verificationRequired).toBe(true);
      const vt = tokenFrom(await until(() => mailTo(strict, 'old@example.com', 'Verify')[0]).then((m) => m.text));
      expect((await sapi.req('POST', '/auth/verify-email', null, { token: vt })).status).toBe(204);
      const login = await sapi.req('POST', '/auth/login', null, { email: 'old@example.com', password: PW });
      const tok = login.body.accessToken;

      expect((await sapi.req('POST', '/users/@me/email', tok, { newEmail: 'new@example.com' })).status).toBe(400);
      expect((await sapi.req('POST', '/users/@me/email', tok, { newEmail: 'new@example.com', password: 'nope nope nope' })).status).toBe(401);
      expect((await sapi.req('POST', '/users/@me/email', tok, { newEmail: 'old@example.com', password: PW })).status).toBe(400); // same address
      const start = await sapi.req('POST', '/users/@me/email', tok, { newEmail: 'New@Example.com', password: PW });
      expect(start.status).toBe(202); expect(start.body.pendingEmail).toBe('new@example.com');
      expect((await sapi.req('GET', '/users/@me/email-change', tok)).body.pendingEmail).toBe('new@example.com');
      // nothing changed yet
      expect((await sapi.req('GET', '/users/@me', tok)).body.email).toBe('old@example.com');

      const confirmMail = await until(() => mailTo(strict, 'new@example.com', 'Confirm')[0]);
      expect(confirmMail.html).toContain('<!doctype html>');
      expect(confirmMail.text).toContain('/verify-email-change?token=');
      const notice = await until(() => mailTo(strict, 'old@example.com', 'new email address was requested')[0]);
      expect(notice.text).toContain('new@example.com');
      expect(notice.text).not.toContain('verify-email-change'); // the old mailbox never gets the credential
      const token = tokenFrom(confirmMail.text);

      expect((await sapi.req('POST', '/auth/email-change/confirm', null, { token: 'z'.repeat(40) })).status).toBe(400);
      expect((await sapi.req('POST', '/auth/email-change/confirm', null, { token })).status).toBe(204);
      expect((await sapi.req('POST', '/auth/email-change/confirm', null, { token })).status).toBe(400); // single use

      expect((await sapi.req('GET', '/users/@me', tok)).status).toBe(401); // every session is gone
      expect((await sapi.req('POST', '/auth/login', null, { email: 'old@example.com', password: PW })).status).toBe(401);
      const again = await sapi.req('POST', '/auth/login', null, { email: 'new@example.com', password: PW });
      expect(again.status).toBe(200); expect(again.body.user.verified).toBe(true); expect(again.body.user.email).toBe('new@example.com');
      await until(() => mailTo(strict, 'old@example.com', 'was changed')[0]);
    } finally { await strict.close(); }
  });

  it('answers the same for a taken address, sends it nothing, and cannot be confirmed with an expired token', async () => {
    const a = await api.register('em1'); const b = await api.register('em2');
    const before = env.ctx.mailer.outbox.length;
    const r = await api.req('POST', '/users/@me/email', a.token, { newEmail: b.user.email, password: PW });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 100));
    expect(mailTo(env, b.user.email, 'Confirm')).toHaveLength(0);
    expect(env.ctx.mailer.outbox.length).toBe(before);
    expect((await api.req('GET', '/users/@me/email-change', a.token)).body.pendingEmail).toBeNull();

    await api.req('POST', '/users/@me/email', a.token, { newEmail: 'late@example.com', password: PW });
    const token = tokenFrom((await until(() => mailTo(env, 'late@example.com', 'Confirm')[0])).text);
    await env.ctx.db.query(`UPDATE email_changes SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [a.id]);
    expect((await api.req('POST', '/auth/email-change/confirm', null, { token })).status).toBe(400);
  });

  it('can be cancelled, and needs the 2FA code with two-factor on', async () => {
    const a = await api.register('em3');
    await api.req('POST', '/users/@me/email', a.token, { newEmail: 'cancel@example.com', password: PW });
    const token = tokenFrom((await until(() => mailTo(env, 'cancel@example.com', 'Confirm')[0])).text);
    expect((await api.req('DELETE', '/users/@me/email-change', a.token)).status).toBe(204);
    expect((await api.req('POST', '/auth/email-change/confirm', null, { token })).status).toBe(400);
    const s = (await api.req('POST', '/auth/mfa/setup', a.token)).body;
    await api.req('POST', '/auth/mfa/enable', a.token, { code: authenticator.generate(s.secret) });
    const r = await api.req('POST', '/users/@me/email', a.token, { newEmail: 'mfa@example.com', password: PW });
    expect(r.status).toBe(401); expect(r.body.code).toBe('MFA_REQUIRED');
    expect((await api.req('POST', '/users/@me/email', a.token, { newEmail: 'mfa@example.com', password: PW, totp: authenticator.generate(s.secret) })).status).toBe(202);
  });

  it('reports a mail failure instead of leaving a dead pending change', async () => {
    const a = await api.register('em4');
    const real = env.ctx.mailer.send;
    env.ctx.mailer.send = async () => { throw new Error('smtp down'); };
    try {
      expect((await api.req('POST', '/users/@me/email', a.token, { newEmail: 'smtpfail@example.com', password: PW })).status).toBe(503);
    } finally { env.ctx.mailer.send = real; }
    expect((await api.req('GET', '/users/@me/email-change', a.token)).body.pendingEmail).toBeNull();
  });
});

describe('self-service disable (reversible)', () => {
  it('signs out everywhere, refuses the old tokens, and reactivates on the next login', async () => {
    const a = await api.register('dis');
    expect((await api.req('POST', '/users/@me/disable', a.token, { password: 'wrong wrong wrong' })).status).toBe(401);
    expect((await api.req('POST', '/users/@me/disable', a.token, { password: PW })).status).toBe(204);
    expect((await api.req('GET', '/users/@me', a.token)).status).toBe(401);
    expect((await api.req('POST', '/auth/refresh', null, { refreshToken: a.refresh })).status).toBe(401);
    const row = (await env.ctx.db.query('SELECT self_disabled_at FROM users WHERE id = $1', [a.id]))[0];
    expect(row.self_disabled_at).toBeTruthy();
    const back = await api.req('POST', '/auth/login', null, { email: a.user.email, password: PW });
    expect(back.status).toBe(200); expect(back.body.reactivated).toBe(true);
    expect((await env.ctx.db.query('SELECT self_disabled_at FROM users WHERE id = $1', [a.id]))[0].self_disabled_at).toBeNull();
    expect((await api.req('GET', '/users/@me', back.body.accessToken)).status).toBe(200);
  });

  it('is different from an operator disable (still blocked) and from deletion', async () => {
    const a = await api.register('dis2');
    await env.ctx.db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [a.id]);
    const r = await api.req('POST', '/auth/login', null, { email: a.user.email, password: PW });
    expect(r.status).toBe(403); expect(r.body.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('display-name style', () => {
  it('accepts catalog presets only and shows them to others', async () => {
    const a = await api.register('dns'); const b = await api.register('dnb');
    expect((await api.req('PATCH', '/users/@me', a.token, { displayNameStyle: { font: 'comic-sans', effect: 'none' } })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', a.token, { displayNameStyle: { font: 'serif', effect: 'sparkle' } })).status).toBe(400);
    const ok = await api.req('PATCH', '/users/@me', a.token, { displayNameStyle: { font: 'serif', effect: 'gradient-ocean' } });
    expect(ok.status).toBe(200); expect(ok.body.displayNameStyle).toEqual({ font: 'serif', effect: 'gradient-ocean' });
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.displayNameStyle).toEqual({ font: 'serif', effect: 'gradient-ocean' });
    expect((await api.req('PATCH', '/users/@me', a.token, { displayNameStyle: null })).body.displayNameStyle).toBeNull();
  });
});
