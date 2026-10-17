import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(name: string) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'ForumDefs' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const u = await api.register(name);
  await api.req('POST', `/invites/${code}`, u.token);
  return { owner, guild, members: [u] };
}

describe('forum channel defaults', () => {
  it('patches and returns defaultSortOrder / defaultForumLayout / defaultReactionEmoji', async () => {
    const { owner, guild } = await guildWith('p1');
    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'ideas', type: 'forum' })).body;
    const res = await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultSortOrder: 'creation_date', defaultForumLayout: 'gallery', defaultReactionEmoji: '👋' });
    expect(res.status).toBe(200);
    expect(res.body.defaultSortOrder).toBe('creation_date');
    expect(res.body.defaultForumLayout).toBe('gallery');
    expect(res.body.defaultReactionEmoji).toBe('👋');
    const [row] = await env.ctx.db.query('SELECT default_sort_order, default_forum_layout, default_reaction_emoji FROM channels WHERE id = $1', [forum.id]);
    expect(row.default_sort_order).toBe('creation_date');
    expect(row.default_forum_layout).toBe('gallery');
    expect(row.default_reaction_emoji).toBe('👋');
    // clearing works
    const cleared = await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultReactionEmoji: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.defaultReactionEmoji).toBeNull();
  });

  it('rejects invalid values, unknown fields and non-forum channels', async () => {
    const { owner, guild } = await guildWith('p2');
    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'ideas', type: 'forum' })).body;
    const text = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'talk', type: 'text' })).body;
    for (const body of [{ defaultSortOrder: 'newest' }, { defaultForumLayout: 'grid' }, { defaultReactionEmoji: 'way too long an emoji string here' }, { defaultReactionEmoji: '' }]) {
      const st = (await api.req('PATCH', `/channels/${forum.id}`, owner.token, body)).status;
      expect(st).toBe(400);
    }
    expect((await api.req('PATCH', `/channels/${text.id}`, owner.token, { defaultSortOrder: 'creation_date' })).status).toBe(400);
  });

  it('adds the default reaction emoji to every new forum post', async () => {
    const { owner, guild, members: [bob] } = await guildWith('p3');
    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'ideas', type: 'forum' })).body;
    await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultReactionEmoji: '🔥' });
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    const post = await api.req('POST', `/channels/${forum.id}/forum/posts`, bob!.token, { name: 'post one', content: 'hello' });
    expect(post.status).toBe(201);
    expect(post.body.message.reactions).toEqual([{ emoji: '🔥', emojiId: null, count: 1, me: true }]);
    await ws.waitEvent('MESSAGE_REACTION_ADD', (d: any) => d.emoji === '🔥');
    const post2 = await api.req('POST', `/channels/${forum.id}/forum/posts`, owner.token, { name: 'post two', content: 'again' });
    expect(post2.body.message.reactions).toEqual([{ emoji: '🔥', emojiId: null, count: 1, me: true }]);
    ws.close();
  });

  it('leaves posts unreacted when no default emoji is set and honours newer defaults per channel', async () => {
    const { owner, guild, members: [bob] } = await guildWith('p4');
    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'plain', type: 'forum' })).body;
    await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultSortOrder: 'creation_date', defaultForumLayout: 'list' });
    const post = await api.req('POST', `/channels/${forum.id}/forum/posts`, bob!.token, { name: 'plain post', content: 'hi' });
    expect(post.status).toBe(201);
    expect(post.body.message.reactions).toEqual([]);
    const ch = await api.req('GET', `/channels/${forum.id}`, owner.token);
    expect(ch.body.defaultSortOrder).toBe('creation_date');
    expect(ch.body.defaultForumLayout).toBe('list');
  });
});
