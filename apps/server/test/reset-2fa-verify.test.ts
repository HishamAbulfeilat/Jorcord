import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mailTo = (e: TestEnv, email: string, subject: string) => e.ctx.mailer.outbox.filter((m) => m.to === email && m.subject.includes(subject));
const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;
const until = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('password reset with two-factor', () => {
  const setupMfa = async (name: string) => {
    const u = await api.register(name);
    const s = (await api.req('POST', '/auth/mfa/setup', u.token)).body;
    expect((await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(s.secret) })).status).toBe(200);
    return { u, secret: s.secret as string };
  };
  const resetToken = async (email: string) => {
    const before = mailTo(env, email, 'Reset').length;
    await api.req('POST', '/auth/password/forgot', null, { email });
    return tokenFrom((await until(() => mailTo(env, email, 'Reset')[before])).text);
  };
  const wrongCode = (secret: string) => (authenticator.generate(secret) === '000000' ? '111111' : '000000');

  it('does not ask accounts without 2FA for a code', async () => {
    const u = await api.register('nomfa');
    const token = await resetToken(u.user.email);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body).toEqual({ valid: true, mfaRequired: false });
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'no mfa new password' })).status).toBe(204);
  });

  it('requires a second factor, keeps the token on a wrong code and accepts the right one', async () => {
    const { u, secret } = await setupMfa('mfa');
    const token = await resetToken(u.user.email);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body).toEqual({ valid: true, mfaRequired: true });

    const missing = await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'mfa new password!' });
    expect(missing.status).toBe(401); expect(missing.body.code).toBe('MFA_REQUIRED');
    const wrong = await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'mfa new password!', mfaCode: wrongCode(secret) });
    expect(wrong.status).toBe(400); expect(wrong.body.code).toBe('INVALID_CODE');

    // neither failure consumed the token or changed the password
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body.valid).toBe(true);
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'mfa new password!' })).status).toBe(401);

    const ok = await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'mfa new password!', mfaCode: authenticator.generate(secret) });
    expect(ok.status).toBe(204);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body.valid).toBe(false);
  });

  it('burns the token after 5 wrong codes, even for a later correct one', async () => {
    const { u, secret } = await setupMfa('burn');
    const token = await resetToken(u.user.email);
    for (let i = 0; i < 4; i++) expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'burned password!', mfaCode: wrongCode(secret) })).body.code).toBe('INVALID_CODE');
    const fifth = await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'burned password!', mfaCode: wrongCode(secret) });
    expect(fifth.status).toBe(400); expect(fifth.body.code).toBe('INVALID_TOKEN');
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body.valid).toBe(false);
    const late = await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'burned password!', mfaCode: authenticator.generate(secret) });
    expect(late.status).toBe(400); expect(late.body.code).toBe('INVALID_TOKEN');
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'burned password!' })).status).toBe(401);
  });
});

describe('REQUIRE_EMAIL_VERIFICATION', () => {
  let strict: TestEnv, sapi: Api;
  beforeAll(async () => { strict = await startServer({ requireEmailVerification: true }); sapi = new Api(strict); });
  afterAll(async () => { await strict.close(); });
  const mails = (to: string) => mailTo(strict, to, 'Verify');

  it('sends the link on sign-up, blocks login until verified, then lets the user in', async () => {
    const email = 'needs-verify@example.com';
    const reg = await sapi.req('POST', '/auth/register', null, { email, username: 'needsverify', password: 'correct horse battery' });
    expect(reg.status).toBe(201); expect(reg.body).toEqual({ verificationRequired: true, email });
    const mail = await until(() => mails(email)[0]);
    expect(mail.text).toContain(strict.ctx.config.publicUrl);

    const blocked = await sapi.req('POST', '/auth/login', null, { email, password: 'correct horse battery' });
    expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

    // resend: always 204 (even for unknown addresses) and mails only the unverified account
    expect((await sapi.req('POST', '/auth/verify-email/resend', null, { email: 'nobody@example.com' })).status).toBe(204);
    expect((await sapi.req('POST', '/auth/verify-email/resend', null, { email })).status).toBe(204);
    const second = await until(() => mails(email)[1]);
    expect((await sapi.req('POST', '/auth/verify-email', null, { token: tokenFrom(second.text) })).status).toBe(204);
    expect((await sapi.req('POST', '/auth/login', null, { email, password: 'correct horse battery' })).status).toBe(200);
    expect((await sapi.req('POST', '/auth/verify-email/resend', null, { email })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(mails(email).length).toBe(2); // already verified: nothing more is sent
  });

  it('leaves the default (flag off) instance unchanged', async () => {
    const u = await api.register('flagoff');
    expect(u.token).toBeTruthy();
  });
});
