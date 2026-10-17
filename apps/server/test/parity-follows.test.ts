import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageFlags, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function two() {
  const pub = await api.register('pub'), sub = await api.register('sub');
  const src = (await api.req('POST', '/guilds', pub.token, { name: 'News HQ', template: 'community' })).body;
  const dst = (await api.req('POST', '/guilds', sub.token, { name: 'Reader Club' })).body;
  const ann = src.channels.find((c: any) => c.type === 'announcement');
  const target = dst.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const code = (await api.req('POST', `/guilds/${src.id}/invites`, pub.token, {})).body.code; await api.req('POST', `/invites/${code}`, sub.token); // the follower reads the announcement channel
  return { pub, sub, src, dst, ann, target };
}
const post = (c: Client, ch: string, content: string) => api.req('POST', `/channels/${ch}/messages`, c.token, { content }).then((r) => r.body);

describe('announcement follow + crosspost', () => {
  it('follows with MANAGE_WEBHOOKS, publishes into followers once, defangs pings, lists and unfollows', async () => {
    const { pub, sub, src, dst, ann, target } = await two();
    const f = await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: target.id });
    expect(f.status).toBe(201); expect(f.body).toMatchObject({ sourceChannelId: ann.id, targetChannelId: target.id });
    expect((await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: target.id })).status).toBe(409);
    // guard rails: not an announcement channel, self-follow, no access to the announcement channel, no MANAGE_WEBHOOKS on the target
    const text = src.channels.find((c: any) => c.type === 'text');
    expect((await api.req('POST', `/channels/${text.id}/followers`, sub.token, { webhookChannelId: target.id })).status).toBe(400);
    expect((await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: ann.id })).status).toBe(400);
    const stranger = await api.register('nope');
    expect((await api.req('POST', `/channels/${ann.id}/followers`, stranger.token, { webhookChannelId: target.id })).status).toBe(404);
    const code = (await api.req('POST', `/guilds/${dst.id}/invites`, sub.token, {})).body.code; await api.req('POST', `/invites/${code}`, stranger.token);
    expect((await api.req('POST', `/channels/${ann.id}/followers`, stranger.token, { webhookChannelId: target.id })).status).toBe(404); // cannot see the source
    expect((await api.req('GET', `/channels/${ann.id}/followers`, sub.token)).status).toBe(403); // readers cannot list followers (MANAGE_WEBHOOKS)
    expect((await api.req('GET', `/channels/${ann.id}/followers`, pub.token)).body).toHaveLength(1);
  });

  it('a public announcement channel of a Discovery server can be followed by outsiders only', async () => {
    const pub = await api.register('pub'), out = await api.register('out');
    const src = (await api.req('POST', '/guilds', pub.token, { name: 'Open News', template: 'community' })).body;
    const mine = (await api.req('POST', '/guilds', out.token, { name: 'Mine' })).body;
    const ann = src.channels.find((c: any) => c.type === 'announcement'); const target = mine.channels.find((c: any) => c.type === 'text');
    expect((await api.req('POST', `/channels/${ann.id}/followers`, out.token, { webhookChannelId: target.id })).status).toBe(404); // not discoverable
    await api.req('PATCH', `/guilds/${src.id}`, pub.token, { discoverable: true });
    expect((await api.req('POST', `/channels/${ann.id}/followers`, out.token, { webhookChannelId: target.id })).status).toBe(201);
    const priv = src.channels.find((c: any) => c.type === 'text');
    await api.req('PUT', `/channels/${ann.id}/permissions/${src.id}`, pub.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }); // now private
    const mine2 = (await api.req('POST', `/guilds/${mine.id}/channels`, out.token, { name: 'again', type: 'text' })).body;
    expect((await api.req('POST', `/channels/${ann.id}/followers`, out.token, { webhookChannelId: mine2.id })).status).toBe(404);
    void priv;
  });

  it('crossposting', async () => {
    const { pub, sub, ann, target, dst } = await two();
    // the publisher's own guild channel follows (publisher is owner of News HQ; give them a channel on the other side via a second guild member)
    const fol = await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: target.id });
    expect(fol.status).toBe(201);
    const ws = await WsClient.connect(env.port); await ws.identify(sub.token);
    const m = await post(pub, ann.id, 'Big news <@1234> @everyone <@&99> with a link');
    const r = await api.req('POST', `/channels/${ann.id}/messages/${m.id}/crosspost`, pub.token);
    expect(r.status).toBe(200); expect(r.body.flags & MessageFlags.CROSSPOSTED).toBe(MessageFlags.CROSSPOSTED);
    const ev = await ws.waitEvent('MESSAGE_CREATE', (d) => d.channelId === target.id);
    expect(ev.d.flags & MessageFlags.IS_CROSSPOST).toBe(MessageFlags.IS_CROSSPOST);
    expect(ev.d.crosspost).toMatchObject({ guildName: 'News HQ', channelId: ann.id, messageId: m.id });
    expect(ev.d.content).not.toContain('<@'); expect(ev.d.mentionEveryone).toBe(false); expect(ev.d.mentions).toEqual([]);
    expect(ev.d.author.id).toBe(pub.id);
    const history = (await api.req('GET', `/channels/${target.id}/messages`, sub.token)).body; expect(history.some((x: any) => x.crosspost?.messageId === m.id)).toBe(true);
    // once only; copies cannot be republished; plain channels refuse
    const again = await api.req('POST', `/channels/${ann.id}/messages/${m.id}/crosspost`, pub.token); expect(again.status).toBe(400); expect(again.body.code).toBe('ALREADY_CROSSPOSTED');
    const copy = history.find((x: any) => x.crosspost);
    expect((await api.req('POST', `/channels/${target.id}/messages/${copy.id}/crosspost`, sub.token)).status).toBe(400);
    // only the author or MANAGE_MESSAGES may publish
    const m2 = await post(pub, ann.id, 'second');
    const other = await api.register('other'); const code = (await api.req('POST', `/guilds/${ann.guildId}/invites`, pub.token, {})).body.code; await api.req('POST', `/invites/${code}`, other.token);
    expect((await api.req('POST', `/channels/${ann.id}/messages/${m2.id}/crosspost`, other.token)).status).toBe(403);
    // followers lists on both sides, and either side may unfollow
    expect((await api.req('GET', `/channels/${ann.id}/followers`, pub.token)).body[0]).toMatchObject({ id: fol.body.id, target: { guildName: 'Reader Club', channelName: 'general' } });
    expect((await api.req('GET', `/channels/${target.id}/follows`, sub.token)).body[0]).toMatchObject({ id: fol.body.id, source: { guildName: 'News HQ', channelName: ann.name } });
    expect((await api.req('DELETE', `/follows/${fol.body.id}`, other.token)).status).toBe(403);
    expect((await api.req('DELETE', `/follows/${fol.body.id}`, sub.token)).status).toBe(204);
    const m3 = await post(pub, ann.id, 'third'); await api.req('POST', `/channels/${ann.id}/messages/${m3.id}/crosspost`, pub.token);
    const after = (await api.req('GET', `/channels/${target.id}/messages`, sub.token)).body; expect(after.filter((x: any) => x.crosspost).length).toBe(1);
    // deleting the following channel drops the follow
    const fol2 = await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: target.id }); expect(fol2.status).toBe(201);
    const extra = (await api.req('POST', `/guilds/${dst.id}/channels`, sub.token, { name: 'extra', type: 'text' })).body;
    await api.req('POST', `/channels/${ann.id}/followers`, sub.token, { webhookChannelId: extra.id });
    await api.req('DELETE', `/channels/${extra.id}`, sub.token);
    expect((await api.req('GET', `/channels/${ann.id}/followers`, pub.token)).body).toHaveLength(1);
    ws.close(); void Perm;
  });
});
