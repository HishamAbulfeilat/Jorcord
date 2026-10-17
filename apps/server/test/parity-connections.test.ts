import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { MAX_CONNECTIONS } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api, page: { body: string }, srv: http.Server, port: number;
beforeAll(async () => {
  env = await startServer({ allowPrivateUnfurl: true }); api = new Api(env); page = { body: '<html>hello</html>' };
  srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(page.body); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as any).port;
});
afterAll(async () => { srv.close(); await env.close(); });

describe('profile connections', () => {
  it('builds provider URLs from validated handles; lists, hides, deletes', async () => {
    const a = await api.register('a'), b = await api.register('b');
    const add = (body: object, c = a) => api.req('POST', '/users/@me/connections', c.token, body);
    expect((await api.req('GET', '/connections/providers', a.token)).body.map((p: any) => p.id)).toContain('github');
    const gh = await add({ type: 'github', handle: '@octo-cat' }); expect(gh.status).toBe(201);
    expect(gh.body).toMatchObject({ type: 'github', name: 'GitHub', handle: 'octo-cat', url: 'https://github.com/octo-cat', verified: false, visible: true }); expect(gh.body.verifyCode).toMatch(/^jorcord-verify=[0-9a-f]{18}$/);
    expect((await add({ type: 'mastodon', handle: 'me@mastodon.social' })).body.url).toBe('https://mastodon.social/@me');
    expect((await add({ type: 'youtube', handle: '@chan' })).body.url).toBe('https://www.youtube.com/@chan');
    expect((await add({ type: 'website', handle: 'https://example.com/me' })).body.url).toBe('https://example.com/me');
    // rejected input
    for (const body of [{ type: 'github', handle: 'bad name!' }, { type: 'github', handle: '../../x' }, { type: 'website', handle: 'http://insecure.example' }, { type: 'website', handle: 'javascript:alert(1)' }, { type: 'website', handle: 'https://user:pw@example.com' }, { type: 'nope', handle: 'x' }, { type: 'x', handle: 'a'.repeat(30) }]) expect((await add(body)).status, JSON.stringify(body)).toBe(400);
    expect((await add({ type: 'github', handle: 'octo-cat' })).status).toBe(409);
    // visibility on profiles: only visible ones, verified first; owner list shows all
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.connections.map((c: any) => c.type)).toEqual(['github', 'mastodon', 'youtube', 'website']);
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.connections[0]).toEqual({ type: 'github', name: 'GitHub', url: 'https://github.com/octo-cat', verified: false });
    await api.req('PATCH', `/users/@me/connections/${gh.body.id}`, a.token, { visible: false });
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.connections.map((c: any) => c.type)).not.toContain('github');
    expect((await api.req('GET', '/users/@me/connections', a.token)).body).toHaveLength(4);
    expect((await api.req('PATCH', `/users/@me/connections/${gh.body.id}`, b.token, { visible: true })).status).toBe(404);
    expect((await api.req('DELETE', `/users/@me/connections/${gh.body.id}`, b.token)).status).toBe(204); // someone else's: no effect
    expect((await api.req('GET', '/users/@me/connections', a.token)).body).toHaveLength(4);
    expect((await api.req('DELETE', `/users/@me/connections/${gh.body.id}`, a.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/connections', a.token)).body).toHaveLength(3);
  });

  it('verifies only when the code is on the linked page (and the cap holds)', async () => {
    const a = await api.register('v'), b = await api.register('w');
    // `website` must be https in production; the fixture is http://127.0.0.1, so insert the row the way the route would
    const c = (await api.req('POST', '/users/@me/connections', a.token, { type: 'website', handle: 'https://example.org/x' })).body;
    await env.ctx.db.query('UPDATE connections SET url = $2 WHERE id = $1', [c.id, `http://127.0.0.1:${port}/`]);
    const v = (tok = a.token) => api.req('POST', `/users/@me/connections/${c.id}/verify`, tok);
    page.body = '<html>nothing here</html>';
    const miss = await v(); expect(miss.status).toBe(422); expect(miss.body.code).toBe('VERIFICATION_FAILED'); expect(miss.body.message).toContain(c.verifyCode);
    expect((await v(b.token)).status).toBe(404); // not yours
    page.body = `<html><p>my bio ${c.verifyCode}</p></html>`;
    const ok = await v(); expect(ok.status).toBe(200); expect(ok.body.verified).toBe(true);
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.connections[0].verified).toBe(true);
    // somebody else's code does not verify mine
    const d = (await api.req('POST', '/users/@me/connections', a.token, { type: 'website', handle: 'https://example.org/y' })).body;
    await env.ctx.db.query('UPDATE connections SET url = $2 WHERE id = $1', [d.id, `http://127.0.0.1:${port}/`]);
    expect((await api.req('POST', `/users/@me/connections/${d.id}/verify`, a.token)).status).toBe(422);
    // blocked targets never verify (private addresses are refused when the guard is on)
    const strict = await startServer(); const sa = new Api(strict); const u = await sa.register('s');
    const e = (await sa.req('POST', '/users/@me/connections', u.token, { type: 'website', handle: 'https://example.org/z' })).body;
    await strict.ctx.db.query('UPDATE connections SET url = $2 WHERE id = $1', [e.id, `http://127.0.0.1:${port}/`]);
    page.body = `<html>${e.verifyCode}</html>`;
    expect((await sa.req('POST', `/users/@me/connections/${e.id}/verify`, u.token)).status).toBe(422);
    await strict.close();
    // cap
    const cap = await api.register('cap');
    for (let i = 0; i < MAX_CONNECTIONS; i++) await env.ctx.db.query('INSERT INTO connections (id, user_id, type, handle, url, verify_token) VALUES ($1,$2,$3,$4,$5,$6)', [String(800000000000 + i), cap.id, 'github', `u${i}`, 'https://github.com/x', 't']);
    expect((await api.req('POST', '/users/@me/connections', cap.token, { type: 'github', handle: 'another' })).status).toBe(400);
  });
});
