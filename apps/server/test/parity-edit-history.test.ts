import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

// R19 (message edit history): every content edit keeps the replaced version in `message_edits`
// and GET /channels/:id/messages/:mid/edits reads it back, newest first, author-bound.
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

interface Fixture { owner: Client; bob: Client; outsider: Client; guildId: string; channelId: string }

async function fixture(): Promise<Fixture> {
  const owner = await api.register('own'), bob = await api.register('bob'), outsider = await api.register('out');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'History' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  await api.req('POST', `/invites/${code}`, bob.token);
  const ch = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'c', type: 'text' })).body;
  return { owner, bob, outsider, guildId: guild.id, channelId: ch.id };
}

describe('message edit history (R19)', () => {
  it('keeps the replaced content on each edit and returns it newest first', async () => {
    const f = await fixture();
    const m = (await api.req('POST', `/channels/${f.channelId}/messages`, f.owner.token, { content: 'v1' })).body;
    await api.req('PATCH', `/channels/${f.channelId}/messages/${m.id}`, f.owner.token, { content: 'v2' });
    await api.req('PATCH', `/channels/${f.channelId}/messages/${m.id}`, f.owner.token, { content: 'v3' });
    const r = await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.owner.token);
    expect(r.status).toBe(200);
    expect(r.body.map((e: any) => e.content)).toEqual(['v2', 'v1']); // v3 is the current content, not history
    for (const e of r.body as any[]) {
      expect(e.id).toMatch(/^\d+$/);
      expect(e.messageId).toBe(m.id);
      expect(new Date(e.editedAt).toString()).not.toBe('Invalid Date');
    }
  });

  it('is empty for a message that was never edited', async () => {
    const f = await fixture();
    const m = (await api.req('POST', `/channels/${f.channelId}/messages`, f.owner.token, { content: 'stays' })).body;
    const r = await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.owner.token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('is visible to the author and moderators only (ordinary readers get 403, outsiders 404)', async () => {
    const f = await fixture();
    const m = (await api.req('POST', `/channels/${f.channelId}/messages`, f.owner.token, { content: 'hi' })).body;
    await api.req('PATCH', `/channels/${f.channelId}/messages/${m.id}`, f.owner.token, { content: 'ho' });
    const peek = await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.bob.token);
    expect(peek.status).toBe(403); // an ordinary member who can read the message cannot read what it said before
    expect((await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.owner.token)).body.map((e: any) => e.content)).toEqual(['hi']);
    const out = await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.outsider.token);
    expect(out.status).toBe(404); // not a guild member: the channel is invisible to them
  });

  it('404s for an unknown message or a message in another channel', async () => {
    const f = await fixture();
    const other = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'd', type: 'text' })).body;
    const m = (await api.req('POST', `/channels/${other.id}/messages`, f.owner.token, { content: 'x' })).body;
    await api.req('PATCH', `/channels/${other.id}/messages/${m.id}`, f.owner.token, { content: 'y' });
    expect((await api.req('GET', `/channels/${other.id}/messages/1234567890/edits`, f.owner.token)).status).toBe(404);
    expect((await api.req('GET', `/channels/${f.channelId}/messages/${m.id}/edits`, f.owner.token)).status).toBe(404); // wrong channel for the message
  });
});
