import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Api, startServer, type TestEnv } from './helpers';

/** 1x1 PNG (magic bytes + valid header) so the server sniffs a real image type. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

/** 1x1 GIF89a. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
/** Minimal animated WebP (VP8X with the animation flag, 4x4 canvas). */
const WEBP = (() => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16); b[20] = 0x02; b.writeUIntLE(3, 24, 3); b.writeUIntLE(3, 27, 3); return b; })();

let env: TestEnv, api: Api, srv: http.Server, port: number;
beforeAll(async () => {
  env = await startServer({ allowPrivateUnfurl: true }); api = new Api(env);
  srv = http.createServer((req, r) => {
    if (req.url?.includes('not-an-image')) { r.setHeader('content-type', 'text/html'); return r.end('<html>nope</html>'); }
    // like imgur/some GIF CDNs: an HTML wrapper unless the client says it wants an image
    if (req.url?.includes('wrapped') && !/image\//.test(String(req.headers.accept))) { r.setHeader('content-type', 'text/html'); return r.end('<html>wrapper</html>'); }
    if (req.url?.endsWith('.gif')) { r.setHeader('content-type', 'image/gif'); return r.end(GIF); }
    if (req.url?.endsWith('.webp')) { r.setHeader('content-type', 'image/webp'); return r.end(WEBP); }
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

  it('stores animated GIF and WebP avatars/banners from a URL, even behind an HTML-wrapping CDN', async () => {
    const a = await api.register('k');
    const gif = await api.req('POST', '/users/@me/avatar/from-url', a.token, { url: url('/wrapped/cat.gif') });
    expect(gif.status).toBe(200);
    expect(gif.body.url).toMatch(/\/avatar\.gif$/);
    expect((await api.req('GET', gif.body.url.replace('/api/v1', ''))).raw.headers['content-type']).toBe('image/gif');
    const webp = await api.req('POST', '/users/@me/banner/from-url', a.token, { url: url('/anim.webp') });
    expect(webp.status).toBe(200);
    expect(webp.body.url).toMatch(/\/banner\.webp$/);
    // the staged URLs are accepted by the profile save
    const saved = await api.req('PATCH', '/users/@me', a.token, { avatar: gif.body.url, banner: webp.body.url });
    expect(saved.status).toBe(200);
    expect(saved.body.avatar).toBe(gif.body.url);
  });

  it('accepts a GIF and an animated WebP uploaded directly and serves them inline', async () => {
    const a = await api.register('l');
    for (const [name, type, buf] of [['me.gif', 'image/gif', GIF], ['me.webp', 'image/webp', WEBP]] as const) {
      const bd = 'XBOUNDARYX';
      const payload = Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), buf, Buffer.from(`\r\n--${bd}--\r\n`)]);
      const res = await api.req('POST', '/uploads', a.token, payload as any, { 'content-type': `multipart/form-data; boundary=${bd}` });
      expect(res.status, name + JSON.stringify(res.body)).toBe(201);
      const att = res.body;
      expect(att.contentType, name).toBe(type);
      expect((await api.req('PATCH', '/users/@me', a.token, { avatar: att.url })).status).toBe(200);
    }
  });

  it('GIF search proxy validates its paging offset', async () => {
    const a = await api.register('m');
    expect((await api.req('GET', '/gifs/trending?offset=30', a.token)).status).toBe(200);
    expect((await api.req('GET', '/gifs/search?q=cat&offset=-1', a.token)).status).toBe(400);
    expect((await api.req('GET', '/gifs/trending?offset=abc', a.token)).status).toBe(400);
  });
});
