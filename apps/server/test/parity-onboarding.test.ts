import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Onb', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  const ch = (name: string) => guild.channels.find((c: any) => c.name === name);
  const gamer = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'gamer' })).body;
  const artist = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'artist' })).body;
  return { owner, guild, m, ch, gamer, artist };
}

describe('onboarding', () => {
  it('managers configure prompts; members answer: roles granted/removed, channels recorded, validation enforced', async () => {
    const { owner, guild, m, ch, gamer, artist } = await setup();
    const cfg = {
      enabled: true, defaultChannelIds: [ch('general').id],
      prompts: [
        { title: 'What are you into?', singleSelect: false, required: true, options: [{ title: 'Games', emoji: '🎮', channelIds: [ch('introductions').id], roleIds: [gamer.id] }, { title: 'Art', channelIds: [ch('discussions').id], roleIds: [artist.id] }] },
        { title: 'Pick one vibe', singleSelect: true, required: false, options: [{ title: 'Chill', channelIds: [], roleIds: [] }, { title: 'Hype', channelIds: [], roleIds: [] }] },
      ],
    };
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, m.token, cfg)).status).toBe(403);
    const put = await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, cfg);
    expect(put.status).toBe(200); expect(put.body.prompts).toHaveLength(2); expect(put.body.prompts[0].options[0].id).toBeTruthy();
    expect((await api.req('GET', `/guilds/${guild.id}`, m.token)).body.features).toContain('ONBOARDING');
    const view = (await api.req('GET', `/guilds/${guild.id}/onboarding`, m.token)).body;
    expect(view).toMatchObject({ enabled: true, responses: null }); expect(view.prompts[0].title).toBe('What are you into?');
    const [games, art] = view.prompts[0].options; const [chill, hype] = view.prompts[1].options;
    const ans = (ids: string[]) => api.req('PUT', `/guilds/${guild.id}/onboarding/responses`, m.token, { optionIds: ids });
    expect((await ans([])).status).toBe(400); // required prompt unanswered
    expect((await ans([games.id, chill.id, hype.id])).status).toBe(400); // single select
    expect((await ans(['999'])).status).toBe(400);
    const wo = await WsClient.connect(env.port); await wo.identify(owner.token);
    const ok = await ans([games.id, chill.id]);
    expect(ok.status).toBe(200); expect(ok.body.channelIds).toEqual([ch('introductions').id]);
    const mem = (await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body.find((x: any) => x.user.id === m.id);
    expect(mem.roles).toEqual([gamer.id]);
    await wo.waitEvent('MEMBER_UPDATE', (d) => d.user.id === m.id && d.roles.includes(gamer.id));
    // changing answers swaps the roles
    await ans([art.id, hype.id]);
    const mem2 = (await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body.find((x: any) => x.user.id === m.id);
    expect(mem2.roles).toEqual([artist.id]);
    expect((await api.req('GET', `/guilds/${guild.id}/onboarding`, m.token)).body.responses).toMatchObject({ optionIds: [art.id, hype.id], channelIds: [ch('discussions').id] });
    // a role the member got by hand is left alone
    const hand = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'hand' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${m.id}`, owner.token, { roles: [artist.id, hand.id] });
    await ans([games.id]);
    expect((await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body.find((x: any) => x.user.id === m.id).roles.sort()).toEqual([gamer.id, hand.id].sort());
    wo.close();
  });

  it('refuses unsafe configuration and hides channels the member cannot see', async () => {
    const { owner, guild, m, ch, gamer } = await setup();
    const opt = (o: object) => ({ enabled: true, prompts: [{ title: 'q', options: [{ title: 'x', channelIds: [], roleIds: [], ...o }] }] });
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, opt({ roleIds: [guild.id] }))).status).toBe(400); // @everyone
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, opt({ roleIds: ['1'] }))).status).toBe(400);
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, opt({ channelIds: ['1'] }))).status).toBe(400);
    const cat = guild.channels.find((c: any) => c.type === 'category');
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, opt({ channelIds: [cat.id] }))).status).toBe(400);
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, { prompts: Array.from({ length: 6 }, () => ({ title: 'q', options: [{ title: 'x' }] })) })).status).toBe(400);
    // a moderator with MANAGE_GUILD + MANAGE_ROLES cannot hand out a role above their own or one with permissions they lack
    const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'mod', permissions: String(Perm.MANAGE_GUILD | Perm.MANAGE_ROLES) })).body;
    const boss = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'boss', permissions: String(Perm.BAN_MEMBERS) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/roles`, owner.token, [{ id: boss.id, position: 5 }, { id: modRole.id, position: 3 }]);
    await api.req('PATCH', `/guilds/${guild.id}/members/${m.id}`, owner.token, { roles: [modRole.id] });
    expect((await api.req('PUT', `/guilds/${guild.id}/onboarding`, m.token, opt({ roleIds: [boss.id] }))).status).toBe(403);
    // private channel ids are not leaked to people who cannot view them
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'secret', type: 'text' })).body;
    await api.req('PUT', `/channels/${secret.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    await api.req('PUT', `/guilds/${guild.id}/onboarding`, owner.token, opt({ channelIds: [secret.id, ch('general').id], roleIds: [gamer.id] }));
    const plain = await api.register('plain'); const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code; await api.req('POST', `/invites/${code}`, plain.token);
    expect((await api.req('GET', `/guilds/${guild.id}/onboarding`, plain.token)).body.prompts[0].options[0].channelIds).toEqual([ch('general').id]);
    expect((await api.req('GET', `/guilds/${guild.id}/onboarding`, owner.token)).body.prompts[0].options[0].channelIds).toContain(secret.id);
  });
});
