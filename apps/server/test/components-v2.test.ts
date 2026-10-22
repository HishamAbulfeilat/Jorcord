import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageFlags, Perm } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';
import { parseComponents } from '../src/lib/components';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const V2 = MessageFlags.IS_COMPONENTS_V2;
const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });
async function setup() {
  const owner = await api.register('v2o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'V2' })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  const app = (await api.req('POST', '/applications', owner.token, { name: 'v2bot', redirectUris: ['https://app.example/cb'] })).body;
  const perms = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY;
  expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: perms.toString(), guildId: guild.id })).status).toBe(200);
  return { owner, general, token: app.token as string };
}

const text = (content: string) => ({ type: 10, content });
const card = [{
  type: 17, accentColor: 0x5865f2, components: [
    { type: 9, components: [text('## Release 1.4'), text('Notes below')], accessory: { type: 11, media: { url: 'https://example.com/logo.png' }, description: 'logo' } },
    { type: 14, divider: true, spacing: 2 },
    { type: 12, items: [{ media: { url: 'https://example.com/a.png' }, description: 'a' }, { media: { url: 'https://example.com/b.png' }, spoiler: true }] },
    { type: 1, components: [{ type: 2, style: 1, label: 'Go', customId: 'go' }] },
  ],
}, text('footer')];

describe('Components V2 validation (pure)', () => {
  it('accepts the layout tree and keeps its shape', () => {
    const out = parseComponents(card, { v2: true });
    expect(out).toHaveLength(2); expect(out[0]!.components).toHaveLength(4); expect(out[0]!.accentColor).toBe(0x5865f2);
  });
  it('rejects V2 types without the flag, and classic-only rules still hold without V2', () => {
    expect(() => parseComponents([text('x')])).toThrow(/IS_COMPONENTS_V2/);
    expect(() => parseComponents([{ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'a' }] }])).not.toThrow();
  });
  it('enforces structure', () => {
    const bad: unknown[] = [
      [{ type: 17, components: [{ type: 17, components: [text('nested container')] }] }],               // containers do not nest
      [{ type: 17, components: [] }],                                                                   // empty container
      [{ type: 9, components: [text('a')], accessory: text('not an accessory') }],                      // accessory must be thumbnail or button
      [{ type: 9, components: [], accessory: { type: 11, media: { url: 'https://e.test/a.png' } } }],     // section needs text
      [{ type: 9, components: [text('1'), text('2'), text('3'), text('4')], accessory: { type: 11, media: { url: 'https://e.test/a.png' } } }],
      [{ type: 12, items: [] }], [{ type: 12, items: Array.from({ length: 11 }, () => ({ media: { url: 'https://e.test/a.png' } })) }],
      [{ type: 12, items: [{ media: { url: 'javascript:alert(1)' } }] }], [{ type: 11, media: { url: 'https://e.test/a.png' } }], // thumbnail only as accessory
      [{ type: 13, media: { url: 'https://e.test/file.zip' } }],                                         // file must be an attachment:// ref
      [{ type: 14, spacing: 3 }], [{ type: 10, content: '' }],
      [{ type: 9, components: [text('a')], accessory: { type: 2, style: 1, label: 'x' } }],             // button without customId
      [text('a'), { type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'dup' }] }, { type: 9, components: [text('b')], accessory: { type: 2, style: 1, label: 'y', customId: 'dup' } }],
      Array.from({ length: 11 }, () => text('x')),                                                      // > 10 top level
      [text('x'.repeat(2500)), text('y'.repeat(2500))],                                                 // > 4000 chars of text
      [{ type: 17, components: Array.from({ length: 11 }, () => text('x')) }],
      [{ type: 99, content: 'x' }],
    ];
    for (const b of bad) expect(() => parseComponents(b, { v2: true }), JSON.stringify(b).slice(0, 120)).toThrow();
  });
  it('counts nested components against the 40 limit', () => {
    const container = (n: number) => ({ type: 17, components: Array.from({ length: n }, () => text('x')) });
    expect(() => parseComponents([container(10), container(10), container(10)], { v2: true })).not.toThrow(); // 33
    expect(() => parseComponents([container(10), container(10), container(10), container(10)], { v2: true })).toThrow(/40/); // 44
  });
});

describe('Components V2 messages (API)', () => {
  it('bots send layout-only messages with the flag; users cannot; content/embeds are refused', async () => {
    const { owner, general, token } = await setup();
    const url = `/channels/${general.id}/messages`;
    expect((await api.req('POST', url, owner.token, { flags: V2, components: card })).status).toBe(400); // users cannot set the flag
    expect((await botReq('POST', url, token, { components: card })).status).toBe(400);                   // layout types need the flag
    expect((await botReq('POST', url, token, { flags: V2, content: 'hi', components: card })).status).toBe(400);
    expect((await botReq('POST', url, token, { flags: V2, embeds: [{ title: 't' }], components: card })).status).toBe(400);
    expect((await botReq('POST', url, token, { flags: V2 })).status).toBe(400);
    const ok = await botReq('POST', url, token, { flags: V2, components: card });
    expect(ok.status).toBe(201); expect(ok.body.flags & V2).toBe(V2); expect(ok.body.content).toBe(''); expect(ok.body.components[0].type).toBe(17);
    const listed = (await api.req('GET', url, owner.token)).body.find((m: any) => m.id === ok.body.id);
    expect(listed.components[0].components[0].accessory.type).toBe(11);
  });

  it('edits keep the mode: a V2 message takes V2 components only and no content; attachment:// must match', async () => {
    const { general, token, owner } = await setup();
    const url = `/channels/${general.id}/messages`;
    const m = (await botReq('POST', url, token, { flags: V2, components: [text('one')] })).body;
    expect((await botReq('PATCH', `${url}/${m.id}`, token, { content: 'nope' })).status).toBe(400);
    expect((await botReq('PATCH', `${url}/${m.id}`, token, { components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'a' }] }] })).status).toBe(200);
    const upd = await botReq('PATCH', `${url}/${m.id}`, token, { components: [text('two'), { type: 13, media: { url: 'attachment://missing.zip' } }] });
    expect(upd.status).toBe(400);
    const edited = await botReq('PATCH', `${url}/${m.id}`, token, { components: [text('two')] });
    expect(edited.body.components[0].content).toBe('two');
    // a classic message cannot be edited into V2 layout
    const classic = (await botReq('POST', url, token, { content: 'plain' })).body;
    expect((await botReq('PATCH', `${url}/${classic.id}`, token, { components: [text('x')] })).status).toBe(400);
    void owner;
  });

  it('buttons inside containers and sections can be pressed', async () => {
    const { owner, general, token } = await setup();
    const url = `/channels/${general.id}/messages`;
    const m = (await botReq('POST', url, token, { flags: V2, components: [
      { type: 17, components: [{ type: 1, components: [{ type: 2, style: 1, label: 'In row', customId: 'row-btn' }] }] },
      { type: 9, components: [text('side')], accessory: { type: 2, style: 2, label: 'Acc', customId: 'acc-btn' } },
    ] })).body;
    for (const id of ['row-btn', 'acc-btn']) {
      const r = await api.req('POST', '/interactions', owner.token, { type: 3, channelId: general.id, messageId: m.id, data: { customId: id } });
      expect(r.status, id).toBe(202);
    }
    expect((await api.req('POST', '/interactions', owner.token, { type: 3, channelId: general.id, messageId: m.id, data: { customId: 'nope' } })).status).toBe(404);
  });
});
