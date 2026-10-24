import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api, sup: Client, deleg: Client, other: Client, plain: Client;
const audit = async (action: string) => (await env.ctx.db.query('SELECT * FROM admin_audit WHERE action = $1', [action])) as any[];
beforeAll(async () => {
  env = await startServer(); api = new Api(env);
  sup = await api.register('sup'); deleg = await api.register('deleg'); other = await api.register('other'); plain = await api.register('plain');
  (env.ctx.config as any).superAdminId = sup.id;
});
afterAll(async () => { await env.close(); });

describe('delegated instance admins', () => {
  it('nobody but the super admin is an admin by default; strangers get 404', async () => {
    for (const c of [deleg, plain]) {
      expect((await api.req('GET', '/admin/me', c.token)).status).toBe(404);
      expect((await api.req('GET', '/admin/users', c.token)).status).toBe(404);
      expect((await api.req('POST', `/admin/users/${other.id}/admin`, c.token)).status).toBe(404);
      expect((await api.req('DELETE', `/admin/users/${other.id}/admin`, c.token)).status).toBe(404);
    }
    expect((await api.req('GET', '/admin/me', sup.token)).body).toMatchObject({ admin: true, role: 'super' });
  });

  it('super admin grants; the grant is audited and the delegated admin gets ordinary moderation routes', async () => {
    expect((await api.req('POST', `/admin/users/${deleg.id}/admin`, sup.token)).status).toBe(200);
    expect((await audit('GRANT_ADMIN')).length).toBe(1);
    expect((await api.req('GET', '/admin/me', deleg.token)).body).toMatchObject({ admin: true, role: 'delegated' });
    expect((await api.req('GET', '/admin/stats', deleg.token)).status).toBe(200);
    expect((await api.req('GET', '/admin/users', deleg.token)).body.find((u: any) => u.id === deleg.id).instanceAdmin).toBe(true);
    expect((await api.req('GET', `/admin/users/${other.id}`, deleg.token)).status).toBe(200);
    expect((await api.req('GET', '/admin/guilds', deleg.token)).status).toBe(200);
    expect((await api.req('GET', '/admin/reports', deleg.token)).status).toBe(200);
    expect((await api.req('GET', '/admin/admins', deleg.token)).body.map((a: any) => a.id)).toContain(deleg.id);
    expect((await api.req('POST', `/admin/users/${other.id}/disable`, deleg.token)).status).toBe(200);
    expect((await api.req('POST', `/admin/users/${other.id}/enable`, deleg.token)).status).toBe(200);
    expect((await audit('DISABLE_USER')).length).toBe(1);
  });

  it('a delegated admin is not leaked as admin/STAFF in the public user DTO', async () => {
    const me = (await api.req('GET', '/users/@me', deleg.token)).body;
    expect(JSON.stringify(me)).not.toMatch(/instance_?admin/i);
    expect(me.publicFlags ?? 0).toBe(0);
  });

  it('a delegated admin cannot grant/revoke, use god mode, or touch the super admin or other admins', async () => {
    expect((await api.req('POST', `/admin/users/${other.id}/admin`, deleg.token)).status).toBe(404);
    expect((await api.req('DELETE', `/admin/users/${deleg.id}/admin`, deleg.token)).status).toBe(404);
    expect((await api.req('POST', '/admin/god-mode', deleg.token, { enabled: true, password: 'correct horse battery' })).status).toBe(404);
    expect((await api.req('POST', '/admin/god-mode', deleg.token, { enabled: false })).status).toBe(404);
    expect((await api.req('PATCH', `/admin/users/${other.id}/flags`, deleg.token, { flags: 1 })).status).toBe(404);
    expect((await api.req('GET', '/admin/audit', deleg.token)).status).toBe(404);
    expect((await api.req('POST', `/admin/guilds/x/join`, deleg.token)).status).toBe(404);
    expect((await api.req('POST', `/admin/users/${sup.id}/disable`, deleg.token)).status).toBe(400);
    expect((await api.req('POST', `/admin/users/${sup.id}/enable`, deleg.token)).status).toBe(403);
    // other admin
    await api.req('POST', `/admin/users/${other.id}/admin`, sup.token);
    expect((await api.req('POST', `/admin/users/${other.id}/disable`, deleg.token)).status).toBe(403);
    expect((await api.req('POST', `/admin/users/${other.id}/clear-dm-limit`, deleg.token)).status).toBe(403);
    await api.req('DELETE', `/admin/users/${other.id}/admin`, sup.token);
  });

  it('a delegated admin cannot read DMs', async () => {
    const dm = (await api.req('POST', '/users/@me/channels', plain.token, { recipientId: other.id })).body;
    if (dm?.id) expect((await api.req('GET', `/admin/channels/${dm.id}/messages`, deleg.token)).status).toBe(404);
  });

  it('refuses the super admin, bots, deleted and disabled users, unknown ids', async () => {
    expect((await api.req('POST', `/admin/users/${sup.id}/admin`, sup.token)).status).toBe(400);
    expect((await api.req('DELETE', `/admin/users/${sup.id}/admin`, sup.token)).status).toBe(400);
    expect((await api.req('POST', `/admin/users/999999999999/admin`, sup.token)).status).toBe(404);
    const b = await api.register('botty'), d = await api.register('gone'), x = await api.register('off');
    await env.ctx.db.query('UPDATE users SET bot = true WHERE id = $1', [b.id]);
    await env.ctx.db.query('UPDATE users SET deleted_at = now() WHERE id = $1', [d.id]);
    await env.ctx.db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [x.id]);
    for (const c of [b, d, x]) expect((await api.req('POST', `/admin/users/${c.id}/admin`, sup.token)).status).toBe(400);
  });

  it('revoke takes effect on the very next request with the same live session; audited', async () => {
    expect((await api.req('GET', '/admin/stats', deleg.token)).status).toBe(200);
    expect((await api.req('DELETE', `/admin/users/${deleg.id}/admin`, sup.token)).status).toBe(200);
    expect((await api.req('GET', '/admin/stats', deleg.token)).status).toBe(404);
    expect((await api.req('GET', '/admin/me', deleg.token)).status).toBe(404);
    expect((await audit('REVOKE_ADMIN')).some((a) => a.path === `/admin/users/${deleg.id}/admin` && a.user_id === sup.id)).toBe(true);
  });

  it('disabling a delegated admin also ends their admin access immediately', async () => {
    const o = await api.register('lateadmin');
    await api.req('POST', `/admin/users/${o.id}/admin`, sup.token);
    expect((await api.req('GET', '/admin/stats', o.token)).status).toBe(200);
    await env.ctx.db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [o.id]);
    expect((await api.req('GET', '/admin/stats', o.token)).status).not.toBe(200);
  });
});
