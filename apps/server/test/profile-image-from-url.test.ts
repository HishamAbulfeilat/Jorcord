import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Api, startServer, type TestEnv } from './helpers';

/** 1x1 PNG (magic bytes + valid header) so the server sniffs a real image type. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

let env: TestEnv, api: Api, srv: http.Server, port: number;
beforeAll(async () => {
  env = await startServer({ allowPrivateUnfurl: true }); api = new Api(env);
  srv = http.createServer((req, r) => {
    if (req.url?.includes('not-an-image')) { r.setHeader('content-type', 'text/html'); return r.end('<html>nope</html>'); }
    r.setHeader('content-type', 'image/png'); r.end(PNG);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as any).port;
});
afterAll(async () => { srv.close(); await env.close(); });

const url = (p: string) => `http://127.0.0.1:${port}${p}`;

describe('avatar/banner from URL', () => {
  it('fetches, re-hosts and returns a stored URL for avatar and banner', async () => {
    const a = await api.register('g');
    const avatar = await api.req('POST', '/users/@me/avatar/from-url', a.token, { url: url('/pic.png') });
    expect(avatar.status).toBe(200);
    expect(avatar.body.url).toMatch(/^\/api\/v1\/files\/[0-9a-f]{48}\/avatar\.png$/);
    // not part of the profile until Save: GET /users/@me still has no avatar
    expect((await api.req('GET', '/users/@me', a.token)).body.avatar).toBeNull();

    const banner = await api.req('POST', '/users/@me/banner/from-url', a.token, { url: url('/pic.png') });
    expect(banner.status).toBe(200);
    expect(banner.body.url).toMatch(/^\/api\/v1\/files\/[0-9a-f]{48}\/banner\.png$/);

    // the staged file is downloadable and served inline as the sniffed type
    const file = await api.req('GET', avatar.body.url.replace('/api/v1', ''));
    expect(file.status).toBe(200);
    expect(file.raw.headers['content-type']).toBe('image/png');
  });

  it('rejects a missing/non-URL/oversized or extra-field body', async () => {
    const a = await api.register('h');
    const post = (body: unknown, path = '/users/@me/avatar/from-url') => api.req('POST', path, a.token, body);
    for (const body of [{}, { url: 'not a url' }, { url: `data:image/png;base64,${PNG.toString('base64')}` }, { url: `http://127.0.0.1:${port}/${'a'.repeat(2100)}.png` }, { url: url('/pic.png'), extra: 1 }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects a URL that is not an image', async () => {
    const a = await api.register('i');
    const r = await api.req('POST', '/users/@me/avatar/from-url', a.token, { url: url('/not-an-image.png') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('refuses private addresses unless the SSRF guard is relaxed', async () => {
    const strict = await startServer();
    const sa = new Api(strict); const a = await sa.register('j');
    expect((await sa.req('POST', '/users/@me/avatar/from-url', a.token, { url: url('/pic.png') })).status).toBe(400);
    await strict.close();
  });
});
