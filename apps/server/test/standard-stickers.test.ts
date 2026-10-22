import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STANDARD_STICKERS, STANDARD_STICKER_PACKS, isStandardStickerId, standardStickerSvg } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('standard sticker catalogue', () => {
  it('has unique ids, valid SVG and no script content', () => {
    const ids = STANDARD_STICKERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(16);
    for (const id of ids) {
      const svg = standardStickerSvg(id)!;
      expect(svg.startsWith('<svg ')).toBe(true); expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/<script|onload|javascript:/i);
    }
    expect(isStandardStickerId('std_gg')).toBe(true);
    expect(isStandardStickerId('std_nope')).toBe(false);
    expect(standardStickerSvg('123')).toBeNull();
  });
});

describe('standard stickers over the API', () => {
  it('lists the packs and serves each image publicly with safe headers', async () => {
    const list = await api.req('GET', '/stickers/standard', null);
    expect(list.status).toBe(200);
    expect(list.body.map((p: any) => p.id)).toEqual(STANDARD_STICKER_PACKS.map((p) => p.id));
    const one = list.body[0].stickers[0];
    const svg = await env.app.inject({ method: 'GET', url: one.url });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['content-security-policy']).toContain("default-src 'none'");
    expect(svg.body).toBe(standardStickerSvg(one.id));
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/stickers/standard/std_zzz.svg' })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/stickers/standard/..%2Fx.svg' })).statusCode).toBe(400);
  });

  it('can be sent in a server channel and in a DM; unknown ones are dropped', async () => {
    const owner = await api.register('o'), friend = await api.register('f');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Stk', template: 'community' })).body;
    const general = guild.channels.find((c: any) => c.type === 'text');
    const sent = await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: '', stickerIds: ['std_gg', 'std_bogus'] });
    expect(sent.status).toBe(201); expect(sent.body.stickerIds).toEqual(['std_gg']);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'x', stickerIds: ['not valid!'] })).status).toBe(400);
    await api.req('PUT', `/users/@me/relationships/${friend.id}`, owner.token, { type: 'friend' });
    await api.req('PUT', `/users/@me/relationships/${owner.id}`, friend.token, { type: 'friend' });
    const dm = (await api.req('POST', '/users/@me/channels', owner.token, { recipientIds: [friend.id] })).body;
    const dmMsg = await api.req('POST', `/channels/${dm.id}/messages`, owner.token, { content: '', stickerIds: ['std_lol'] });
    expect(dmMsg.status).toBe(201); expect(dmMsg.body.stickerIds).toEqual(['std_lol']);
  });
});
