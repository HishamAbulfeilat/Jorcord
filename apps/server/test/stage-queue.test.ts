import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { runSweeps } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

/** An owner, a moderator-less audience of `n` members, and a stage everybody can join. */
async function stageWith(n: number) {
  const owner = await api.register('sqo');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Queue', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const people: Client[] = [];
  for (let i = 0; i < n; i++) { const u = await api.register('sq' + i); await api.req('POST', `/invites/${code}`, u.token); people.push(u); }
  const stage = guild.channels.find((c: any) => c.type === 'stage');
  const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
  const sockets = new Map<string, WsClient>();
  const sock = async (u: Client) => { if (!sockets.has(u.id)) { const w = await WsClient.connect(env.port); await w.identify(u.token); sockets.set(u.id, w); } return sockets.get(u.id)!; };
  /** Poll the voice store: the server writes the state after it restored a hand, so this is safe to assert on. */
  const settle = async (u: Client, inStage: boolean) => {
    for (let i = 0; i < 200; i++) { if (((await env.ctx.voice.get(u.id))?.channelId === stage.id) === inStage) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('voice state did not settle');
  };
  const join = async (u: Client) => { (await sock(u)).send({ op: 4, d: { guildId: guild.id, channelId: stage.id } }); await settle(u, true); };
  const leave = async (u: Client) => { (await sock(u)).send({ op: 4, d: { guildId: guild.id, channelId: null } }); await settle(u, false); };
  const queue = async (token = owner.token) => (await api.req('GET', `/channels/${stage.id}/stage/queue`, token));
  const ids = async () => (await queue()).body.map((e: any) => e.userId);
  const raise = (u: Client, body?: object) => api.req('PUT', `/channels/${stage.id}/stage/request`, u.token, body);
  const done = () => { wOwner.close(); for (const w of sockets.values()) w.close(); };
  return { owner, guild, people, stage, wOwner, sock, join, leave, queue, ids, raise, done };
}

describe('stage raised-hand queue', () => {
  it('is first come first served, persisted, and visible to moderators only', async () => {
    const { owner, people: [a, b, c], stage, wOwner, sock, join, queue, ids, raise, done } = await stageWith(3);
    for (const u of [a!, b!, c!]) await join(u);
    expect((await raise(a!)).status).toBe(200);
    expect((await raise(b!)).status).toBe(200);
    expect(await ids()).toEqual([a!.id, b!.id]);
    const q = (await queue()).body;
    expect(q.map((e: any) => e.position)).toEqual([1, 2]);
    expect(q.every((e: any) => typeof e.requestToSpeakAt === 'string' && e.anonymous === false)).toBe(true);
    // persisted: the rows are in the database, not only in the voice state
    expect((await env.ctx.db.query('SELECT user_id FROM stage_hand_queue WHERE channel_id = $1 ORDER BY seq', [stage.id])).map((r: any) => r.user_id)).toEqual([a!.id, b!.id]);
    // the audience cannot read the queue; non-stage channels are refused
    expect((await queue(a!.token)).status).toBe(403);
    const general = (await api.req('GET', `/guilds/${(await api.req('GET', `/channels/${stage.id}`, owner.token)).body.guildId}/channels`, owner.token)).body.find((x: any) => x.type === 'text');
    expect((await api.req('GET', `/channels/${general.id}/stage/queue`, owner.token)).status).toBe(400);
    // raising again keeps the place; lowering and raising again goes to the back
    const again = await raise(a!);
    expect(again.body).toMatchObject({ handPosition: 1, anonymous: false });
    expect(await ids()).toEqual([a!.id, b!.id]);
    await api.req('DELETE', `/channels/${stage.id}/stage/request`, a!.token);
    expect(await ids()).toEqual([b!.id]);
    await raise(a!);
    expect(await ids()).toEqual([b!.id, a!.id]);
    // everyone is told about the order, each member about their own place
    const ev = await wOwner.waitFor((f) => f.t === 'STAGE_QUEUE_UPDATE' && f.d.queue.length === 2 && f.d.queue[0].userId === b!.id);
    expect(ev.d.channelId).toBe(stage.id);
    const mine = await (await sock(a!)).waitFor((f) => f.t === 'STAGE_HAND_UPDATE' && f.d.position === 2);
    expect(mine.d).toEqual({ channelId: stage.id, raised: true, anonymous: false, position: 2 });
    // the invite removes the hand
    await api.req('PUT', `/channels/${stage.id}/stage/speakers/${b!.id}`, owner.token);
    expect(await ids()).toEqual([a!.id]);
    expect((await (await sock(b!)).waitFor((f) => f.t === 'STAGE_HAND_UPDATE' && f.d.raised === false)).d.position).toBeNull();
    done();
  });

  it('keeps a hand through a brief absence and forgets it after the grace period', async () => {
    const { people: [a, b, c], stage, join, leave, ids, raise, done } = await stageWith(3);
    for (const u of [a!, b!, c!]) await join(u);
    await raise(a!); await raise(b!); await raise(c!);
    // b drops out and is not in the queue while away, but keeps the place
    await leave(b!);
    expect(await ids()).toEqual([a!.id, c!.id]);
    expect((await env.ctx.db.query('SELECT 1 FROM stage_hand_queue WHERE channel_id = $1 AND user_id = $2', [stage.id, b!.id])).length).toBe(1);
    await join(b!);
    expect(await ids()).toEqual([a!.id, b!.id, c!.id]);
    expect((await env.ctx.voice.get(b!.id))?.requestToSpeakAt).toBeTruthy(); // the public state shows the restored hand again
    // away for longer than the grace period: a sweep drops the hand for good
    await leave(c!);
    await env.ctx.db.query(`UPDATE stage_hand_queue SET left_at = now() - interval '3 minutes' WHERE channel_id = $1 AND user_id = $2`, [stage.id, c!.id]);
    await runSweeps(env.ctx);
    expect((await env.ctx.db.query('SELECT 1 FROM stage_hand_queue WHERE channel_id = $1 AND user_id = $2', [stage.id, c!.id])).length).toBe(0);
    await join(c!);
    expect(await ids()).toEqual([a!.id, b!.id]);
    expect((await env.ctx.voice.get(c!.id))?.requestToSpeakAt).toBeNull();
    done();
  });

  it('survives a server restart: hands of members who are no longer connected are parked, and restored when they return', async () => {
    const { people: [a, b], stage, join, ids, raise, done } = await stageWith(2);
    await join(a!); await join(b!);
    await raise(a!); await raise(b!);
    await env.ctx.voice.delete(a!.id); // the in-memory voice state is gone, the database rows are not
    await runSweeps(env.ctx);
    expect(await ids()).toEqual([b!.id]);
    // a reconnects (the client re-announces its voice state) within the grace period and is first again
    await join(a!);
    expect(await ids()).toEqual([a!.id, b!.id]);
    expect(stage.id).toBeTruthy();
    done();
  });

  it('hides who asks when the hand is anonymous, except from moderators', async () => {
    const { owner, people: [a, b], stage, wOwner, sock, join, queue, raise, done } = await stageWith(2);
    await join(a!); await join(b!);
    await raise(a!);
    const r = await raise(b!, { anonymous: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ anonymous: true, handPosition: 2, requestToSpeakAt: null }); // the public voice state shows no hand
    expect((await env.ctx.voice.get(b!.id))?.requestToSpeakAt).toBeNull();
    // the channel hears the order without the identity; the member hears it is theirs
    const pub = await wOwner.waitFor((f) => f.t === 'STAGE_QUEUE_UPDATE' && f.d.queue.length === 2);
    expect(pub.d.queue.map((e: any) => e.userId)).toEqual([a!.id, null]);
    expect(pub.d.queue[1]).toMatchObject({ anonymous: true, position: 2 });
    expect(JSON.stringify(pub)).not.toContain(b!.id);
    expect((await (await sock(b!)).waitFor((f) => f.t === 'STAGE_HAND_UPDATE' && f.d.raised)).d).toEqual({ channelId: stage.id, raised: true, anonymous: true, position: 2 });
    // moderators read the real identity from the queue; the audience cannot
    expect((await queue()).body.map((e: any) => [e.userId, e.anonymous])).toEqual([[a!.id, false], [b!.id, true]]);
    expect((await queue(b!.token)).status).toBe(403);
    // and can invite the anonymous member
    expect((await api.req('PUT', `/channels/${stage.id}/stage/speakers/${b!.id}`, owner.token)).status).toBe(200);
    done();
  });

  it('lets moderators block a member from speaking, and unblock them', async () => {
    const { owner, guild, people: [a, b, mod], stage, join, ids, raise, done } = await stageWith(3);
    const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'stagemods', permissions: String(Perm.MUTE_MEMBERS | Perm.MOVE_MEMBERS | Perm.MANAGE_CHANNELS) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${mod!.id}`, owner.token, { roles: [modRole.id] });
    for (const u of [a!, b!]) await join(u);
    const url = (u: Client) => `/channels/${stage.id}/stage/blocked/${u.id}`;
    await raise(a!);
    // authorization: audience cannot block or list; the owner (target outranks nobody) works; nobody blocks themselves or a non-member
    expect((await api.req('PUT', url(b!), a!.token)).status).toBe(403);
    expect((await api.req('GET', `/channels/${stage.id}/stage/blocked`, a!.token)).status).toBe(403);
    expect((await api.req('PUT', url(owner), mod!.token)).status).toBe(403); // cannot outrank the owner
    expect((await api.req('PUT', url(mod!), mod!.token)).status).toBe(400);
    expect((await api.req('PUT', `/channels/${stage.id}/stage/blocked/${(await api.register('stranger')).id}`, owner.token)).status).toBe(404);
    // blocking removes the raised hand and refuses new ones
    const blocked = await api.req('PUT', url(a!), mod!.token, { reason: 'spam' });
    expect(blocked.status).toBe(200); expect(blocked.body).toMatchObject({ userId: a!.id, blockedBy: mod!.id, reason: 'spam' });
    expect(await ids()).toEqual([]);
    expect((await env.ctx.voice.get(a!.id))?.requestToSpeakAt).toBeNull();
    const refused = await raise(a!);
    expect(refused.status).toBe(403); expect(refused.body.code).toBe('STAGE_SPEAKER_BLOCKED');
    expect((await api.req('PUT', `/channels/${stage.id}/stage/speakers/${a!.id}`, owner.token)).body.code).toBe('STAGE_SPEAKER_BLOCKED');
    expect((await api.req('GET', `/channels/${stage.id}/stage/blocked`, mod!.token)).body.map((x: any) => x.userId)).toEqual([a!.id]);
    // a speaker who gets blocked goes back to the audience at once
    await api.req('PUT', `/channels/${stage.id}/stage/speakers/${b!.id}`, owner.token);
    expect((await env.ctx.voice.get(b!.id))?.suppress).toBe(false);
    await api.req('PUT', url(b!), owner.token);
    expect((await env.ctx.voice.get(b!.id))?.suppress).toBe(true);
    // a block survives leaving and rejoining; unblocking lets them ask again
    expect((await api.req('DELETE', url(a!), a!.token)).status).toBe(403);
    expect((await api.req('DELETE', url(a!), mod!.token)).status).toBe(204);
    expect((await api.req('DELETE', url(a!), mod!.token)).status).toBe(404);
    expect((await raise(a!)).status).toBe(200);
    // audited
    expect((await env.ctx.db.query("SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'STAGE_BLOCK_SPEAKER' AND action_type = 314", [guild.id])).length).toBe(2);
    expect((await env.ctx.db.query("SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'STAGE_UNBLOCK_SPEAKER'", [guild.id])).length).toBe(1);
    done();
  });

  it('refuses the hand of someone who and the stage host have blocked each other, either way round', async () => {
    const { owner, people: [a, b], stage, join, raise, done } = await stageWith(2);
    await join(a!); await join(b!);
    // a stage needs a host (the member who started it)
    expect((await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'Town hall' })).status).toBe(201);
    await api.req('PUT', `/users/@me/relationships/${a!.id}`, owner.token, { type: 'blocked' }); // host blocks a
    await api.req('PUT', `/users/@me/relationships/${owner.id}`, b!.token, { type: 'blocked' }); // b blocks the host
    for (const u of [a!, b!]) { const r = await raise(u); expect(r.status).toBe(403); expect(r.body.code).toBe('STAGE_SPEAKER_BLOCKED'); }
    done();
  });

  it('clears the queue and blocks when the stage ends', async () => {
    const { owner, people: [a, b], stage, wOwner, join, ids, raise, done } = await stageWith(2);
    await join(a!); await join(b!);
    await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'Short' });
    await raise(a!);
    await api.req('PUT', `/channels/${stage.id}/stage/blocked/${b!.id}`, owner.token);
    expect(await ids()).toEqual([a!.id]);
    const n = wOwner.frames.length;
    expect((await api.req('DELETE', `/stage-instances/${stage.id}`, owner.token)).status).toBe(204);
    await wOwner.waitFor((f) => wOwner.frames.indexOf(f) >= n && f.t === 'STAGE_QUEUE_UPDATE' && f.d.queue.length === 0);
    expect(await ids()).toEqual([]);
    expect((await api.req('GET', `/channels/${stage.id}/stage/blocked`, owner.token)).body).toEqual([]);
    expect((await raise(b!)).status).toBe(200);
    done();
  });
});
