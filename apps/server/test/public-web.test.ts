import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm } from '@jorcord/shared';
import { parseMarkdown } from '@jorcord/shared/src/markdown';
import { renderMarkdown, renderNodes, safeHref, jsonLd, esc, clearPublicCache } from '../src/services/publicWeb';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ publicUrl: 'https://jorcord.example' }); api = new Api(env); });
afterAll(async () => { await env.close(); });
beforeEach(() => clearPublicCache());

const get = (url: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'GET', url, headers });

async function community(opts: { publish?: boolean; vanity?: string } = {}) {
  const owner = await api.register('own');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Pub Guild' })).body;
  const rules = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'rules', type: 'text' })).body;
  const c = await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { rulesChannelId: rules.id, community: true, ...(opts.vanity ? { vanityUrl: opts.vanity } : {}) });
  expect(c.status).toBe(200);
  const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'help', type: 'forum' })).body;
  if (opts.publish !== false) {
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { publicWeb: true })).status).toBe(200);
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { publicWeb: true })).status).toBe(200);
  }
  return { owner, guild, forum };
}
const post = async (token: string, forumId: string, name: string, content: string) => {
  const r = await api.req('POST', `/channels/${forumId}/forum/posts`, token, { name, content });
  expect(r.status).toBe(201);
  return r.body.channel.id as string;
};

describe('markdown rendering safety (unit)', () => {
  it('escapes raw HTML and never emits a script/event handler', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> "quoted" \'single\' & more');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
  });
  it('only keeps http(s) hrefs and adds nofollow ugc', () => {
    const html = renderMarkdown('[a](https://example.com/x?y=1&z=2) [b](javascript:alert(1)) [c](data:text/html,x) https://ok.example/path');
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(html).not.toMatch(/href="(javascript|data):/);
    expect(html).not.toMatch(/<a [^>]*(javascript|data):/);
    expect(html).toContain('href="https://example.com/x?y=1&amp;z=2"');
    expect(renderMarkdown('[q](https://a.example/"onmouseover="x)')).not.toContain('<a ');
    expect(html.match(/<a /g)!.length).toBe(2);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('https://a.example/ b')).toBeNull();
    expect(safeHref('HTTPS://A.example/')).toBe('https://a.example/');
  });
  it('renders formatting, code, lists and quotes; mentions are anonymised', () => {
    const html = renderMarkdown('# Title\n**bold** *it* ~~x~~ `a<b`\n```js\nconst a = "<b>";\n```\n- one\n- two\n> quote\n<@123456789> <#98765> <@&5>');
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>a&lt;b</code>');
    expect(html).toContain('<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(html).toContain('<ul><li>one');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('@member');
    expect(html).not.toContain('123456789');
  });
  it('is bounded: deep input does not blow the stack', () => {
    const html = renderNodes(parseMarkdown('||'.repeat(200) + 'x' + '||'.repeat(200)));
    expect(typeof html).toBe('string');
  });
  it('json-ld output cannot close its script element', () => {
    const j = jsonLd({ a: '</script><script>alert(1)</script>', b: ' ' });
    expect(j).not.toContain('</script');
    expect(j).not.toContain('<');
    expect(JSON.parse(j).a).toBe('</script><script>alert(1)</script>');
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('opt-in and permissions', () => {
  it('is off by default: nothing is served for a community that has not enabled it', async () => {
    const { guild, forum, owner } = await community({ publish: false });
    const tid = await post(owner.token, forum.id, 'Hidden', 'secret text');
    for (const u of [`/p/${guild.id}`, `/p/${guild.id}/${forum.id}`, `/p/${guild.id}/${forum.id}/${tid}`]) expect((await get(u)).statusCode).toBe(404);
  });
  it('needs a Community server and cannot be enabled on others', async () => {
    const owner = await api.register('nc');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Plain' })).body;
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { publicWeb: true })).body.code).toBeTruthy();
    const f = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'f', type: 'forum' })).body;
    expect((await api.req('PATCH', `/channels/${f.id}`, owner.token, { publicWeb: true })).status).toBe(400);
  });
  it('requires MANAGE_GUILD / MANAGE_CHANNELS to toggle', async () => {
    const { guild, forum } = await community({ publish: false });
    const rnd = await api.register('rnd');
    expect((await api.req('PATCH', `/guilds/${guild.id}`, rnd.token, { publicWeb: true })).status).toBeGreaterThanOrEqual(403);
    expect((await api.req('PATCH', `/channels/${forum.id}`, rnd.token, { publicWeb: true })).status).toBeGreaterThanOrEqual(403);
  });
  it('only exposes a forum when its own toggle is on, and text channels cannot be made public', async () => {
    const { guild, forum, owner } = await community();
    const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 'forum' })).body;
    const tid = await post(owner.token, other.id, 'Not public', 'private forum content');
    expect((await get(`/p/${guild.id}/${other.id}/${tid}`)).statusCode).toBe(404);
    const text = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'chat', type: 'text' })).body;
    expect((await api.req('PATCH', `/channels/${text.id}`, owner.token, { publicWeb: true })).status).toBe(400);
    expect(forum.id).toBeTruthy();
  });
  it('age-restricted channels are never public and going nsfw unpublishes', async () => {
    const { guild, forum, owner } = await community();
    expect((await get(`/p/${guild.id}/${forum.id}`)).statusCode).toBe(200);
    clearPublicCache();
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { nsfw: true })).status).toBe(200);
    expect((await get(`/p/${guild.id}/${forum.id}`)).statusCode).toBe(404);
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { publicWeb: true })).status).toBe(400);
    const f2 = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'adult', type: 'forum', nsfw: true })).body;
    expect((await api.req('PATCH', `/channels/${f2.id}`, owner.token, { publicWeb: true })).status).toBe(400);
  });
  it('a channel @everyone cannot read is never public even if flagged (overwrite deny)', async () => {
    const { guild, forum, owner } = await community();
    const tid = await post(owner.token, forum.id, 'Visible for now', 'hello world');
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).statusCode).toBe(200);
    clearPublicCache();
    await api.req('PUT', `/channels/${forum.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).statusCode).toBe(404);
    expect((await get(`/p/${guild.id}/${forum.id}`)).statusCode).toBe(404);
    expect((await get(`/p/${guild.id}`)).statusCode).toBe(404);
    const sm = await get(`/sitemaps/${guild.id}.xml`);
    expect(sm.body).not.toContain(forum.id);
  });
  it('private threads never render; leaving Community unpublishes', async () => {
    const { guild, forum, owner } = await community();
    const tid = await post(owner.token, forum.id, 'Will be private', 'content');
    await env.ctx.db.query('UPDATE channels SET thread_private = true WHERE id = $1', [tid]);
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).statusCode).toBe(404);
    expect((await get(`/p/${guild.id}/${forum.id}`)).body).not.toContain('Will be private');
    await env.ctx.db.query('UPDATE channels SET thread_private = false WHERE id = $1', [tid]);
    clearPublicCache();
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).statusCode).toBe(200);
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { community: false });
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).statusCode).toBe(404);
  });
  it('never serves DMs or non-forum channel ids', async () => {
    const { guild, owner } = await community();
    const b = await api.register('dmb');
    const dm = (await api.req('POST', '/users/@me/channels', owner.token, { recipientIds: [b.id] })).body;
    expect((await get(`/p/${guild.id}/${dm.id}`)).statusCode).toBe(404);
    expect((await get(`/p/${guild.id}/${dm.id}/1`)).statusCode).toBe(404);
    expect((await get(`/p/nope/123/456`)).statusCode).toBe(404);
  });
});

describe('thread page', () => {
  it('renders SEO tags, JSON-LD, canonical, OG/Twitter, lazy images and a join button', async () => {
    const { guild, forum, owner } = await community({ vanity: 'pubguild' });
    const tid = await post(owner.token, forum.id, 'How do I <b>fix</b> echo?', 'Try **headphones**. See [docs](https://docs.example/echo) and https://x.example/a');
    await api.req('POST', `/channels/${tid}/messages`, owner.token, { content: 'Second reply: `ok`' });
    const res = await get(`/p/pubguild/${forum.id}/${tid}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    const h = res.body;
    expect(h).toContain('<title>How do I &lt;b&gt;fix&lt;/b&gt; echo? - Pub Guild</title>');
    expect(h).toContain(`<link rel="canonical" href="https://jorcord.example/p/pubguild/${forum.id}/${tid}">`);
    expect(h).toContain('<meta name="description" content="Try headphones. See docs');
    expect(h).toContain('property="og:title"');
    expect(h).toContain('name="twitter:card"');
    expect(h).toContain('content="index,follow');
    expect(h).toContain('<strong>headphones</strong>');
    expect(h).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(h).toContain('Join the conversation');
    expect(h).toContain('href="https://jorcord.example/invite/pubguild"');
    expect(h).not.toContain('<b>fix</b>');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(h)![1]!);
    expect(ld['@type']).toBe('DiscussionForumPosting');
    expect(ld.headline).toContain('echo');
    expect(ld.url).toBe(`https://jorcord.example/p/pubguild/${forum.id}/${tid}`);
    expect(ld.comment.length).toBe(1);
    expect(ld.interactionStatistic.userInteractionCount).toBe(1);
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });
  it('escapes XSS payloads in titles, bodies, topics, names and attachments', async () => {
    const { guild, forum, owner } = await community();
    const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const tid = await post(owner.token, forum.id, evil, `${evil}\n[x](javascript:alert(3))\n[y](https://a.example/"onmouseover="alert(4))\n\`\`\`"><svg onload=alert(5)>\n\`\`\``);
    await api.req('PATCH', `/channels/${forum.id}`, owner.token, { topic: evil });
    await api.req('PATCH', `/users/@me`, owner.token, { displayName: evil });
    clearPublicCache();
    for (const url of [`/p/${guild.id}/${forum.id}/${tid}`, `/p/${guild.id}/${forum.id}`, `/p/${guild.id}`]) {
      const h = (await get(url)).body;
      const noLd = h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
      expect(noLd).not.toMatch(/<script/i);
      expect(noLd).not.toMatch(/<img[^>]*onerror/i);
      expect(noLd).not.toMatch(/<svg/i);
      expect(noLd).not.toMatch(/href="javascript:/i);
      expect(noLd).not.toMatch(/\sonmouseover=/i);
      expect(noLd).not.toContain('alert(1)</script>');
    }
  });
  it('lazy-loads images, uses alt text, hides spoiler images, and skips non-images', async () => {
    const { guild, forum, owner } = await community();
    const tid = await post(owner.token, forum.id, 'With picture', 'see attached');
    const [m] = await env.ctx.db.query('SELECT id FROM messages WHERE channel_id = $1', [tid]);
    const att = [
      { id: '1', filename: 'a.png', contentType: 'image/png', size: 10, url: '/api/v1/files/' + 'a'.repeat(48) + '/a.png', width: 640, height: 480, spoiler: false, description: 'A "diagram"' },
      { id: '2', filename: 'SPOILER_b.png', contentType: 'image/png', size: 10, url: '/api/v1/files/' + 'b'.repeat(48) + '/SPOILER_b.png', width: 1, height: 1, spoiler: true },
      { id: '3', filename: 'c.exe', contentType: 'application/octet-stream', size: 10, url: '/api/v1/files/' + 'c'.repeat(48) + '/c.exe', width: null, height: null, spoiler: false },
      { id: '4', filename: 'd.png', contentType: 'image/png', size: 10, url: 'javascript:alert(1)', width: null, height: null, spoiler: false },
    ];
    await env.ctx.db.query('UPDATE messages SET attachments = $2::jsonb WHERE id = $1', [m.id, JSON.stringify(att)]);
    const h = (await get(`/p/${guild.id}/${forum.id}/${tid}`)).body;
    expect(h).toContain('loading="lazy"');
    expect(h).toContain(`src="https://jorcord.example/api/v1/files/${'a'.repeat(48)}/a.png"`);
    expect(h).toContain('alt="A &quot;diagram&quot;"');
    expect(h).toContain('width="640" height="480"');
    expect(h).not.toContain('b'.repeat(48));
    expect(h).not.toContain('c.exe');
    expect(h).not.toContain('javascript:');
    expect(h).toContain(`<meta property="og:image" content="https://jorcord.example/api/v1/files/${'a'.repeat(48)}/a.png">`);
  });
  it('supports conditional GET (ETag -> 304) and HEAD', async () => {
    const { guild, forum, owner } = await community();
    const tid = await post(owner.token, forum.id, 'Cache me', 'body');
    const url = `/p/${guild.id}/${forum.id}/${tid}`;
    const a = await get(url);
    const b = await get(url, { 'if-none-match': a.headers.etag as string });
    expect(b.statusCode).toBe(304);
    expect((await env.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
  });
  it('paginates long threads with rel prev/next and a page-specific canonical', async () => {
    const { guild, forum, owner } = await community();
    const tid = await post(owner.token, forum.id, 'Long thread', 'start');
    for (let i = 0; i < 55; i++) await env.ctx.db.query(`INSERT INTO messages (id, channel_id, guild_id, author_id, content) VALUES ($1,$2,$3,$4,$5)`, [String(BigInt(tid) + BigInt(i + 1) * 4194304000n), tid, guild.id, owner.id, `reply ${i}`]);
    const p1 = (await get(`/p/${guild.id}/${forum.id}/${tid}`)).body;
    expect(p1).toContain('rel="next"');
    expect(p1).not.toContain('rel="prev"');
    const p2 = await get(`/p/${guild.id}/${forum.id}/${tid}?page=2`);
    expect(p2.body).toContain('rel="prev"');
    expect(p2.body).toContain(`?page=2">`);
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}?page=9`)).statusCode).toBe(404);
  });
});

describe('list pages, sitemap, robots', () => {
  it('lists posts with pagination and links to threads', async () => {
    const { guild, forum, owner } = await community({ vanity: 'listg' });
    for (let i = 0; i < 22; i++) await post(owner.token, forum.id, `Question ${i}`, `body ${i}`);
    const p1 = await get(`/p/listg/${forum.id}`);
    expect(p1.statusCode).toBe(200);
    expect(p1.body).toContain('Question 21');
    expect(p1.body).not.toContain('Question 0<');
    expect(p1.body).toContain('rel="next"');
    const p2 = await get(`/p/listg/${forum.id}?page=2`);
    expect(p2.body).toContain('Question 0');
    expect(p2.body).toContain(`<link rel="canonical" href="https://jorcord.example/p/listg/${forum.id}?page=2">`);
    expect((await get(`/p/${guild.id}`)).body).toContain('#help');
  });
  it('sitemap index + per-server sitemap only include public channels; noindex removes them', async () => {
    const { guild, forum, owner } = await community({ vanity: 'smap' });
    const tid = await post(owner.token, forum.id, 'In sitemap', 'x');
    const hidden = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'nopub', type: 'forum' })).body;
    const hiddenT = await post(owner.token, hidden.id, 'Not in sitemap', 'y');
    const idx = await get('/sitemap.xml');
    expect(idx.headers['content-type']).toContain('application/xml');
    expect(idx.body).toContain('https://jorcord.example/sitemaps/smap.xml');
    const sm = await get('/sitemaps/smap.xml');
    expect(sm.statusCode).toBe(200);
    expect(sm.body).toContain(`/p/smap/${forum.id}/${tid}`);
    expect(sm.body).toContain('<lastmod>');
    expect(sm.body).not.toContain(hiddenT);
    expect(sm.body).not.toContain(hidden.id);
    // noindex: pages stay readable but are excluded from sitemaps and carry robots noindex + X-Robots-Tag
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { publicNoindex: true })).status).toBe(200);
    const page = await get(`/p/smap/${forum.id}/${tid}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body).toContain('content="noindex,nofollow"');
    expect((await get('/sitemaps/smap.xml')).statusCode).toBe(404);
    clearPublicCache();
    expect((await get('/sitemap.xml')).body).not.toContain('sitemaps/smap.xml');
    expect((await get('/sitemaps/..%2Fetc.xml')).statusCode).toBe(404);
  });
  it('serves robots.txt pointing at the sitemap and blocking the API', async () => {
    const r = await get('/robots.txt');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Sitemap: https://jorcord.example/sitemap.xml');
    expect(r.body).toContain('Disallow: /api/');
    expect(r.body).toContain('Allow: /p/');
  });
});

describe('author privacy and freshness', () => {
  it("shows 'Member' and no avatar for authors who hide themselves on public pages", async () => {
    const { guild, forum, owner } = await community();
    const shy = await api.register('shy');
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, shy.token);
    await api.req('PATCH', '/users/@me', shy.token, { displayName: 'ShyPerson' });
    const tid = await post(shy.token, forum.id, 'Anonymous question', 'who am I');
    expect((await get(`/p/${guild.id}/${forum.id}/${tid}`)).body).toContain('ShyPerson');
    const u = (await api.req('GET', '/users/@me', shy.token)).body;
    expect((await api.req('PATCH', '/users/@me', shy.token, { settings: { ...(u.settings ?? {}), prefs: { hideOnPublicPages: true } } })).status).toBe(200);
    clearPublicCache();
    for (const url of [`/p/${guild.id}/${forum.id}/${tid}`, `/p/${guild.id}/${forum.id}`]) {
      const h = (await get(url)).body;
      expect(h).not.toContain('ShyPerson');
      expect(h).not.toContain(shy.username);
      expect(h).toContain('Member');
    }
    const ld = JSON.parse(/ld\+json">([\s\S]*?)<\/script>/.exec((await get(`/p/${guild.id}/${forum.id}/${tid}`)).body)![1]!);
    expect(ld.author.name).toBe('Member');
  });
  it('edits and deletions show up once the short cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { guild, forum, owner } = await community();
      const tid = await post(owner.token, forum.id, 'Edit me', 'original text');
      const reply = (await api.req('POST', `/channels/${tid}/messages`, owner.token, { content: 'reply to delete' })).body;
      const url = `/p/${guild.id}/${forum.id}/${tid}`;
      expect((await get(url)).body).toContain('reply to delete');
      const [first] = await env.ctx.db.query('SELECT id FROM messages WHERE channel_id = $1 ORDER BY id LIMIT 1', [tid]);
      await api.req('PATCH', `/channels/${tid}/messages/${first.id}`, owner.token, { content: 'edited text' });
      await api.req('DELETE', `/channels/${tid}/messages/${reply.id}`, owner.token);
      expect((await get(url)).body).toContain('original text'); // still inside the cache window
      vi.setSystemTime(Date.now() + 16_000);
      const h = (await get(url)).body;
      expect(h).toContain('edited text');
      expect(h).toContain('(edited)');
      expect(h).not.toContain('original text');
      expect(h).not.toContain('reply to delete');
      await api.req('DELETE', `/channels/${tid}`, owner.token);
      vi.setSystemTime(Date.now() + 16_000);
      expect((await get(url)).statusCode).toBe(404);
    } finally { vi.useRealTimers(); }
  });
});

describe('abuse protection', () => {
  it('rate limits crawlers per IP', async () => {
    const rl = await startServer({ rateLimit: true });
    try {
      let last = 200;
      for (let i = 0; i < 95; i++) last = (await rl.app.inject({ method: 'GET', url: '/p/x/1' })).statusCode;
      expect(last).toBe(429);
    } finally { await rl.close(); }
  });
});
