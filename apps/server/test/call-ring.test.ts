import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ callRingMs: 1500 }); api = new Api(env); });
afterAll(async () => { await env.close(); });

const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
const dmOf = async (a: Client, ...others: Client[]) => (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: others.map((o) => o.id) })).body;
const online = async (c: Client) => { const w = await WsClient.connect(env.port); await w.identify(c.token); return w; };
const join = (w: WsClient, channelId: string | null) => w.send({ op: 4, d: { channelId } });
const missed = async (u: Client, channelId: string) => (await api.req('GET', `/channels/${channelId}/messages`, u.token)).body.filter((m: any) => m.type === 'call');
const ringEnd = (w: WsClient, callId?: string) => w.waitEvent('CALL_RING_END', (d) => !callId || d.callId === callId);

async function pair() {
  const a = await api.register('ca'), b = await api.register('cb'); await befriend(a, b);
  const dm = await dmOf(a, b); const wa = await online(a); const wb = await online(b);
  return { a, b, dm, wa, wb, close: () => { wa.close(); wb.close(); } };
}

describe('call ringing', () => {
  it('rings the other participant (not the caller) with who/where/when', async () => {
    const { a, b, dm, wa, wb, close } = await pair();
    join(wa, dm.id);
    const ring = (await wb.waitEvent('CALL_RING', (d) => d.channelId === dm.id)).d;
    expect(ring).toMatchObject({ channelId: dm.id, userId: a.id, channelType: 'dm', groupName: null, silent: false });
    expect(ring.callId).toMatch(/^\d+$/); expect(new Date(ring.expiresAt).getTime() - new Date(ring.startedAt).getTime()).toBe(1500);
    await wa.expectNone((f) => f.t === 'CALL_RING');
    void b; close();
  });

  it('answering on one device stops the ring on the other devices and leaves no missed call', async () => {
    const { b, dm, wa, wb, close } = await pair();
    const wb2 = await online(b);
    join(wa, dm.id);
    const callId = (await wb.waitEvent('CALL_RING')).d.callId; await wb2.waitEvent('CALL_RING');
    join(wb, dm.id);
    expect((await ringEnd(wb2, callId)).d).toMatchObject({ reason: 'answered', channelId: dm.id, by: b.id });
    expect((await ringEnd(wb, callId)).d.reason).toBe('answered');
    await new Promise((r) => setTimeout(r, 1800));
    expect(await missed(b, dm.id)).toHaveLength(0);
    wb2.close(); close();
  });

  it('decline stops it on every device, ends a 1:1 ring for the caller and records a missed call', async () => {
    const { a, b, dm, wa, wb, close } = await pair();
    const wb2 = await online(b);
    join(wa, dm.id); const callId = (await wb.waitEvent('CALL_RING')).d.callId;
    expect((await api.req('POST', `/channels/${dm.id}/call/decline`, b.token)).status).toBe(204);
    expect((await ringEnd(wb2, callId)).d.reason).toBe('declined');
    expect((await ringEnd(wa, callId)).d).toMatchObject({ reason: 'declined' });
    const m = await missed(b, dm.id);
    expect(m).toHaveLength(1); expect(m[0]).toMatchObject({ type: 'call', content: 'missed', author: { id: a.id } });
    expect((await api.req('POST', `/channels/${dm.id}/call/decline`, b.token)).status).toBe(404); // nothing left to decline
    wb2.close(); close();
  });

  it('times out after the ring duration and posts a missed-call message', async () => {
    const { a, b, dm, wa, wb, close } = await pair();
    join(wa, dm.id); const callId = (await wb.waitEvent('CALL_RING')).d.callId;
    expect((await ringEnd(wb, callId)).d.reason).toBe('timeout');
    expect((await ringEnd(wa, callId)).d.reason).toBe('timeout');
    const m = await missed(a, dm.id);
    expect(m).toHaveLength(1); expect(m[0].author.id).toBe(a.id);
    void b; close();
  });

  it('caller hanging up before an answer cancels the ring', async () => {
    const { a, dm, wa, wb, close } = await pair();
    join(wa, dm.id); const callId = (await wb.waitEvent('CALL_RING')).d.callId;
    join(wa, null);
    expect((await ringEnd(wb, callId)).d.reason).toBe('cancelled');
    expect(await missed(a, dm.id)).toHaveLength(1);
    close();
  });

  it('never rings blockers or people you blocked, and answering a blocked DM call is refused', async () => {
    const { a, b, dm, wa, wb, close } = await pair();
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'blocked' }); // b blocks a
    join(wa, dm.id);
    await wb.expectNone((f) => f.t === 'CALL_RING', 400);
    close();
    const c = await api.register('cc'), d = await api.register('cd'); await befriend(c, d);
    const dm2 = await dmOf(c, d); await api.req('PUT', `/users/@me/relationships/${d.id}`, c.token, { type: 'blocked' }); // caller blocked callee
    const wc = await online(c), wd = await online(d);
    join(wc, dm2.id); await wd.expectNone((f) => f.t === 'CALL_RING', 400);
    expect(await env.ctx.voice.get(c.id)).toBeFalsy(); // the join itself was refused
    wc.close(); wd.close();
  });

  it('does not ring message requests (non-friend DMs)', async () => {
    const x = await api.register('rx'), y = await api.register('ry');
    const g = (await api.req('POST', '/guilds', x.token, { name: 'Shared Guild', template: 'community' })).body;
    await api.req('POST', `/invites/${(await api.req('POST', `/guilds/${g.id}/invites`, x.token, {})).body.code}`, y.token);
    const dm = await dmOf(x, y); expect(dm.id).toBeTruthy(); const wx = await online(x), wy = await online(y);
    const isRequest = (await env.ctx.db.query('SELECT request FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [dm.id, y.id]))[0]?.request;
    join(wx, dm.id);
    if (isRequest) await wy.expectNone((f) => f.t === 'CALL_RING', 400); else await wy.waitEvent('CALL_RING');
    expect(isRequest).toBe(true);
    wx.close(); wy.close();
  });

  it('group DM rings everyone; one pick-up keeps the others ringing and prevents a missed call', async () => {
    const a = await api.register('ga'), b = await api.register('gb'), c = await api.register('gc'); await befriend(a, b); await befriend(a, c); await befriend(b, c);
    const gdm = await dmOf(a, b, c); expect(gdm.type).toBe('group_dm');
    const [wa, wb, wc] = await Promise.all([online(a), online(b), online(c)]);
    join(wa, gdm.id);
    const callId = (await wb.waitEvent('CALL_RING')).d.callId; await wc.waitEvent('CALL_RING');
    join(wc, gdm.id);
    expect((await ringEnd(wc, callId)).d.reason).toBe('answered');
    expect((await ringEnd(wb, callId)).d.reason).toBe('timeout'); // b never picked up
    expect(await missed(a, gdm.id)).toHaveLength(0);
    [wa, wb, wc].forEach((w) => w.close());
  });

  it('a session that connects mid-ring still gets it in READY; permissions: only participants may decline', async () => {
    const { a, b, dm, wa, wb, close } = await pair();
    join(wa, dm.id); await wb.waitEvent('CALL_RING');
    const late = await WsClient.connect(env.port); const ready = await late.identify(b.token);
    expect(ready.d.calls).toHaveLength(1); expect(ready.d.calls[0]).toMatchObject({ channelId: dm.id, userId: a.id });
    const outsider = await api.register('co');
    expect((await api.req('POST', `/channels/${dm.id}/call/decline`, outsider.token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${dm.id}/call/decline`, a.token)).status).toBe(404); // the caller is not ringing
    const guild = (await api.req('POST', '/guilds', a.token, { name: 'Ring Guild', template: 'community' })).body;
    expect((await api.req('POST', `/channels/${guild.channels.find((c: any) => c.type === 'text').id}/call/decline`, a.token)).status).toBe(400);
    late.close(); close();
  });

  it('DND users get the invitation silently', async () => {
    const { b, dm, wa, wb, close } = await pair();
    await env.ctx.db.query("UPDATE users SET presence = 'dnd' WHERE id = $1", [b.id]);
    join(wa, dm.id);
    expect((await wb.waitEvent('CALL_RING')).d.silent).toBe(true);
    close();
  });
});
