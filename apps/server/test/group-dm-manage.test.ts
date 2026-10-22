import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
const FILE = '/api/v1/files/' + 'b'.repeat(48) + '/icon.png';
async function group() {
  const a = await api.register('ga'), b = await api.register('gb'), c = await api.register('gc'), d = await api.register('gd');
  await befriend(a, b); await befriend(a, c);
  const g = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id] })).body;
  return { a, b, c, d, g };
}

describe('group DM icon and ownership', () => {
  it('lets any participant set the icon and name; outsiders cannot', async () => {
    const { a, b, d, g } = await group();
    expect(g.type).toBe('group_dm'); expect(g.icon).toBeNull(); expect(g.ownerId).toBe(a.id);
    const w = await WsClient.connect(env.port); await w.identify(a.token);
    const r = await api.req('PATCH', `/channels/${g.id}`, b.token, { icon: FILE, name: 'Squad' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ icon: FILE, name: 'Squad', ownerId: a.id });
    const ev = await w.waitEvent('CHANNEL_UPDATE', (x) => x.id === g.id && x.icon === FILE);
    expect(ev.d.name).toBe('Squad');
    expect((await api.req('PATCH', `/channels/${g.id}`, b.token, { icon: 'https://evil.example/x.png' })).status).toBe(400); // own uploads only
    expect((await api.req('PATCH', `/channels/${g.id}`, d.token, { icon: FILE })).status).toBe(404);
    expect((await api.req('PATCH', `/channels/${g.id}`, b.token, { icon: null })).body.icon).toBeNull();
    w.close();
  });

  it('transfers ownership only from the owner to a participant', async () => {
    const { a, b, c, d, g } = await group();
    expect((await api.req('PATCH', `/channels/${g.id}`, b.token, { ownerId: b.id })).status).toBe(403); // not the owner
    expect((await api.req('PATCH', `/channels/${g.id}`, a.token, { ownerId: d.id })).status).toBe(400); // not a participant
    const ok = await api.req('PATCH', `/channels/${g.id}`, a.token, { ownerId: b.id });
    expect(ok.status).toBe(200); expect(ok.body.ownerId).toBe(b.id);
    // the old owner lost the right to remove people; the new one has it
    expect((await api.req('DELETE', `/channels/${g.id}/recipients/${c.id}`, a.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${g.id}/recipients/${c.id}`, b.token)).status).toBe(204);
    expect((await api.req('PATCH', `/channels/${g.id}`, a.token, { ownerId: a.id })).status).toBe(403);
  });
});
