import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(name: string) {
  const owner = await api.register('bowner');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Burst' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const other = await api.register(name);
  await api.req('POST', `/invites/${code}`, other.token);
  return { owner, guild, general: guild.channels.find((c: any) => c.name === 'general'), other };
}
const E = (e: string) => encodeURIComponent(e);
const reactUrl = (channelId: string, messageId: string, emoji: string) => `/channels/${channelId}/messages/${messageId}/reactions/${E(emoji)}/@me`;
const latest = async (channelId: string, messageId: string, token: string) =>
  (await api.req('GET', `/channels/${channelId}/messages?limit=20`, token)).body.find((m: any) => m.id === messageId);
const ids = (body: any[]) => new Set(body.map((u: any) => u.id));

describe('burst (super) reactions', () => {
  it('adds a burst reaction separately from the regular one, broadcasting burst + colour', async () => {
    const { owner, general } = await guildWith('b1');
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'react to me' })).body;
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);

    expect((await api.req('PUT', reactUrl(general.id, m.id, '👍'), owner.token)).status).toBe(204);
    const put = await api.req('PUT', reactUrl(general.id, m.id, '👍'), owner.token, { burst: true, burstColor: '#EB459E' });
    expect(put.status).toBe(204);
    const ev = await ws.waitEvent('MESSAGE_REACTION_ADD', (d: any) => d.burst === true);
    expect(ev.d).toMatchObject({ emoji: '👍', burst: true, burstColor: '#EB459E' });

    const got = await latest(general.id, m.id, owner.token);
    expect(got.reactions).toEqual([{ emoji: '👍', emojiId: null, count: 1, me: true, burstCount: 1, meBurst: true, burstColors: ['#EB459E'] }]);
    ws.close();
  });

  it('defaults the burst colour and rejects an off-palette one', async () => {
    const { owner, general } = await guildWith('b2');
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'x' })).body;
    expect((await api.req('PUT', reactUrl(general.id, m.id, '🎉'), owner.token, { burst: true })).status).toBe(204);
    const got = await latest(general.id, m.id, owner.token);
    expect(got.reactions[0]).toMatchObject({ count: 0, burstCount: 1, meBurst: true, burstColors: [LIMITS.burstColors[0]] });
    expect((await api.req('PUT', reactUrl(general.id, m.id, '🎊'), owner.token, { burst: true, burstColor: '#000000' })).status).toBe(400);
  });

  it('removes only the requested variant and lists burst reactors via ?burst=true', async () => {
    const { owner, general, other } = await guildWith('b3');
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'y' })).body;
    await api.req('PUT', reactUrl(general.id, m.id, '🔥'), owner.token);
    await api.req('PUT', reactUrl(general.id, m.id, '🔥'), owner.token, { burst: true });

    // dropping the regular reaction leaves the burst in place
    expect((await api.req('DELETE', reactUrl(general.id, m.id, '🔥'), owner.token)).status).toBe(204);
    expect((await latest(general.id, m.id, owner.token)).reactions).toEqual([
      { emoji: '🔥', emojiId: null, count: 0, me: false, burstCount: 1, meBurst: true, burstColors: [LIMITS.burstColors[0]] },
    ]);
    // dropping the burst finally clears the entry
    expect((await api.req('DELETE', `${reactUrl(general.id, m.id, '🔥')}?burst=true`, owner.token)).status).toBe(204);
    expect((await latest(general.id, m.id, owner.token)).reactions).toEqual([]);

    // burst reactors are a separate list from regular reactors
    await api.req('PUT', reactUrl(general.id, m.id, '❤️'), owner.token, { burst: true });
    await api.req('PUT', reactUrl(general.id, m.id, '❤️'), other.token, { burst: true });
    expect(ids((await api.req('GET', `/channels/${general.id}/messages/${m.id}/reactions/${E('❤️')}?burst=true`, owner.token)).body)).toEqual(ids([owner, other]));
    expect((await api.req('GET', `/channels/${general.id}/messages/${m.id}/reactions/${E('❤️')}?burst=false`, owner.token)).body).toEqual([]);
  });

  it('meters bursts per user per day and refuses the sixth distinct one', async () => {
    const { owner, general } = await guildWith('b4');
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'cap' })).body;
    const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄'];
    for (let i = 0; i < LIMITS.burstReactionsPerDay; i++) {
      expect((await api.req('PUT', reactUrl(general.id, m.id, emojis[i]!), owner.token, { burst: true })).status).toBe(204);
    }
    const over = await api.req('PUT', reactUrl(general.id, m.id, emojis[LIMITS.burstReactionsPerDay]!), owner.token, { burst: true });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('BURST_LIMIT');
    // re-sending an existing burst is a no-op and does not consume the exhausted allowance
    expect((await api.req('PUT', reactUrl(general.id, m.id, emojis[0]!), owner.token, { burst: true })).status).toBe(204);
  });
});
