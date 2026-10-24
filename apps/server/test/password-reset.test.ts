import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mailTo = (email: string, subject?: string) => env.ctx.mailer.outbox.filter((m) => m.to === email && (!subject || m.subject.includes(subject)));
const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;
const until = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('password reset email', () => {
  it('sends an HTML link, validates it, resets once and emails a security notice', async () => {
    const u = await api.register('htm');
    expect((await api.req('POST', '/auth/password/forgot', null, { email: u.user.email.toUpperCase() })).status).toBe(204);
    const mail = await until(() => mailTo(u.user.email, 'Reset')[0]);
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.html).toContain('Reset your password');
    expect(mail.html).toContain('Jorcord');
    expect(mail.text).toContain('expires in 1 hour');

    const token = tokenFrom(mail.text);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body).toEqual({ valid: true, mfaRequired: false });
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token: 'z'.repeat(64) })).body).toEqual({ valid: false, mfaRequired: false });

    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'a brand new password' })).status).toBe(204);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body).toEqual({ valid: false, mfaRequired: false });
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'another password!!' })).status).toBe(400);

    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery' })).status).toBe(401);
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'a brand new password' })).status).toBe(200);

    const notice = await until(() => mailTo(u.user.email, 'password was changed')[0]);
    expect(notice.html).toContain('Your password was changed');
    expect(notice.text).toContain('signed out');
  });

  it('rejects expired links before asking for a password', async () => {
    const u = await api.register('expd');
    await api.req('POST', '/auth/password/forgot', null, { email: u.user.email });
    const token = tokenFrom((await until(() => mailTo(u.user.email, 'Reset')[0])).text);
    await env.ctx.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND kind = 'reset_password'`, [u.id]);
    expect((await api.req('POST', '/auth/password/reset/validate', null, { token })).body).toEqual({ valid: false, mfaRequired: false });
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'a brand new password' })).status).toBe(400);
  });

  it('notifies the account when the password is changed from settings', async () => {
    const u = await api.register('chg');
    expect((await api.req('POST', '/auth/password', u.token, { currentPassword: 'correct horse battery', newPassword: 'changed from settings' })).status).toBe(204);
    const notice = await until(() => mailTo(u.user.email, 'password was changed')[0]);
    expect(notice.html).toContain('Reset your password');
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'changed from settings' })).status).toBe(200);
  });
});
