import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const react = (emoji: string) => encodeURIComponent(emoji);

/** Fields that must not depend on which member asks for the list (everything except reaction `me`). */
const stableView = (rows: any[]) => rows.map((m) => ({
  id: m.id, channelId: m.channelId, content: m.content, type: m.type, replyTo: m.replyTo,
  createdAt: m.createdAt, editedAt: m.editedAt, pinned: m.pinned,
  authorId: m.author.id,
  referenced: m.referenced ? { id: m.referenced.id, content: m.referenced.content, authorId: m.referenced.author.id } : null,
  reactions: m.reactions.map((r: any) => ({ emoji: r.emoji, emojiId: r.emojiId, count: r.count, ...(r.burstCount ? { burstCount: r.burstCount } : {}) }))
    .sort((a: any, b: any) => a.emoji.localeCompare(b.emoji)),
}));

describe('channel message list', () => {
  it('loads several messages with their authors and reactions without changing the response', async () => {
    const owner = await api.register('perfowner');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Perf' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const bob = await api.register('perfbob'); await api.req('POST', `/invites/${code}`, bob.token);
    const carol = await api.register('perfcarol'); await api.req('POST', `/invites/${code}`, carol.token);

    const send = async (c: Client, content: string, extra: Record<string, unknown> = {}) => {
      const r = await api.req('POST', `/channels/${general.id}/messages`, c.token, { content, ...extra });
      expect(r.status).toBe(201);
      return r.body;
    };
    const first = await send(owner, 'first message');
    const second = await send(bob, 'second message');
    const third = await send(carol, 'third message', { replyTo: first.id });
    const fourth = await send(owner, 'fourth message');

    const thumbs = react('👍'), heart = react('❤️');
    const addReaction = (user: Client, messageId: string, emoji: string) =>
      api.req('PUT', `/channels/${general.id}/messages/${messageId}/reactions/${emoji}/@me`, user.token);
    await addReaction(owner, first.id, thumbs);
    await addReaction(bob, first.id, thumbs);
    await addReaction(carol, first.id, thumbs);
    await addReaction(bob, first.id, heart);
    await addReaction(owner, third.id, thumbs);

    const asCarol = await api.req('GET', `/channels/${general.id}/messages?limit=50`, carol.token);
    const asBob = await api.req('GET', `/channels/${general.id}/messages?limit=50`, bob.token);
    expect(asCarol.status).toBe(200);

    // Newest first, all four messages present (older join system messages may follow).
    const byId = new Map<string, any>(asCarol.body.map((m: any) => [m.id, m]));
    expect([...byId.keys()].slice(0, 4)).toEqual([fourth.id, third.id, second.id, first.id]);

    // Authors are joined in one batch: every message keeps the right author.
    expect(byId.get(first.id).author).toMatchObject({ id: owner.id, username: owner.username });
    expect(byId.get(second.id).author).toMatchObject({ id: bob.id, username: bob.username });
    expect(byId.get(third.id).author).toMatchObject({ id: carol.id, username: carol.username });
    expect(byId.get(fourth.id).author).toMatchObject({ id: owner.id, username: owner.username });

    // The reply still carries its referenced message.
    expect(byId.get(third.id).referenced).toMatchObject({ id: first.id, content: 'first message' });
    expect(byId.get(second.id).referenced ?? null).toBeNull();

    // Reactions are grouped per emoji with the correct counts and per-viewer `me` flags.
    const firstReactions = byId.get(first.id).reactions;
    expect(firstReactions.find((r: any) => r.emoji === '👍')).toMatchObject({ emojiId: null, count: 3, me: true });
    expect(firstReactions.find((r: any) => r.emoji === '❤️')).toMatchObject({ emojiId: null, count: 1, me: false });
    expect(byId.get(third.id).reactions.find((r: any) => r.emoji === '👍')).toMatchObject({ count: 1, me: false });
    expect(byId.get(second.id).reactions).toEqual([]);
    expect(byId.get(fourth.id).reactions).toEqual([]);

    // Another member asking for the same channel sees an identical list (only `me` differs).
    expect(stableView(asBob.body)).toEqual(stableView(asCarol.body));
  });
});
