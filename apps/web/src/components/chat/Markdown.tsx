import { getServerUrl } from '@/lib/server';
import { guardLink } from '@/lib/links';
import { apiBase } from '@/lib/server';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { parseMarkdown, isJumbo, formatTimestamp, type MdNode } from '@/lib/markdown';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { replaceShortcodes } from '@/lib/emoji';
import { intToHex } from '@/lib/perms';
import { displayName, fmtFull, fileUrl } from '@/lib/format';
import { Hash, Copy } from 'lucide-react';
import { useNav } from '@/lib/nav';
import { copyText } from '@/lib/format';
import { toast } from '@/stores/ui';
import { t } from '@/i18n';

export const emojiUrl = (id: string, animated: boolean) => `${apiBase()}/emojis/${id}.${animated ? 'gif' : 'webp'}`;

function Spoiler({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  return <span className={`spoiler ${on ? 'revealed' : ''}`} role="button" tabIndex={0} aria-label={on ? undefined : 'Spoiler, click to reveal'} onClick={() => setOn(true)} onKeyDown={(e) => { if (e.key === 'Enter') setOn(true); }}><span>{children}</span></span>;
}

function CodeBlock({ lang, v }: { lang: string; v: string }) {
  // highlight.js (core + ~15 languages) is its own lazy chunk: plain text renders first, colours arrive when it is loaded
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => { let dead = false; if (lang) void import('./highlight').then((m) => { if (!dead) setHtml(m.highlight(v, lang)); }); return () => { dead = true; }; }, [v, lang]);
  return (
    <div className="group/code relative">
      <pre className="block"><code className={html ? 'hljs' : undefined} dangerouslySetInnerHTML={html ? { __html: html } : undefined}>{html ? undefined : v}</code></pre>
      <button aria-label="Copy code" onClick={() => copyText(v).then(() => toast(t('Copied code'), 'success'))} className="absolute end-2 top-2 hidden rounded bg-chat/80 p-1 text-interactive hover:text-header group-hover/code:block"><Copy size={14} /></button>
    </div>
  );
}

function User({ id, guildId }: { id: string; guildId?: string | null }) {
  const u = useData((s) => s.users[id]); const m = useData((s) => (guildId ? s.guilds[guildId]?.members[id] : undefined));
  const open = useUI((s) => s.openPopout);
  return <span className="mention" role="button" tabIndex={0} onClick={(e) => open({ kind: 'user', userId: id, guildId: guildId ?? undefined, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>@{u ? displayName(u, m) : 'unknown-user'}</span>;
}

function CustomEmoji({ id, name, animated }: { id: string; name: string; animated: boolean }) {
  const url = useData((s) => { for (const g of Object.values(s.guilds)) { const e = g.emojis.find((x) => x.id === id); if (e) return fileUrl(e.url) ?? e.url; } return undefined; });
  return <img loading="lazy" decoding="async" className="emoji" src={url ?? emojiUrl(id, animated)} alt={`:${name}:`} title={`:${name}:`} draggable={false} />;
}

function Node({ n, ctx }: { n: MdNode; ctx: Ctx }) {
  const nav = useNav();
  const guild = useData((s) => (ctx.guildId ? s.guilds[ctx.guildId] : undefined));
  switch (n.t) {
    case 'text': return <>{n.v.includes(':') ? replaceShortcodes(n.v) : n.v}</>;
    case 'bold': return <strong><Nodes ns={n.c} ctx={ctx} /></strong>;
    case 'italic': return <em><Nodes ns={n.c} ctx={ctx} /></em>;
    case 'underline': return <u><Nodes ns={n.c} ctx={ctx} /></u>;
    case 'strike': return <s><Nodes ns={n.c} ctx={ctx} /></s>;
    case 'spoiler': return <Spoiler><Nodes ns={n.c} ctx={ctx} /></Spoiler>;
    case 'code': return <code className="inline">{n.v}</code>;
    case 'codeblock': return <CodeBlock lang={n.lang} v={n.v} />;
    case 'quote': return <blockquote><Nodes ns={n.c} ctx={ctx} /></blockquote>;
    case 'heading': { const H = (`h${n.level}`) as 'h1'; return <H><Nodes ns={n.c} ctx={ctx} /></H>; }
    case 'subtext': return <small className="subtext"><Nodes ns={n.c} ctx={ctx} /></small>;
    case 'list': { const L = n.ordered ? 'ol' : 'ul'; return <L>{n.items.map((it, i) => <li key={i}><Nodes ns={it} ctx={ctx} /></li>)}</L>; }
    case 'link': {
      const internal = n.href.startsWith(location.origin) || (!!getServerUrl() && n.href.startsWith(getServerUrl()));
      return <a href={n.href} target={internal ? undefined : '_blank'} rel="noopener noreferrer nofollow ugc" title={n.masked ? n.href : undefined} onClick={(e) => { if (internal) e.stopPropagation(); else guardLink(e, n.href); }}><Nodes ns={n.c} ctx={ctx} /></a>;
    }
    case 'user': return <User id={n.id} guildId={ctx.guildId} />;
    case 'role': { const r = guild?.roles[n.id]; return <span className="mention" style={r?.color ? { color: intToHex(r.color), background: intToHex(r.color) + '33' } : undefined}>@{r?.name ?? 'deleted-role'}</span>; }
    case 'channel': {
      const c = guild?.channels[n.id];
      return <span className="mention" role="link" tabIndex={0} onClick={() => nav.go(ctx.guildId, n.id)}><Hash size={13} className="me-0.5 inline -translate-y-px" />{c?.name ?? 'unknown'}</span>;
    }
    case 'everyone': return <span className="mention">@{n.v}</span>;
    case 'emoji': return <CustomEmoji id={n.id} name={n.name} animated={n.animated} />;
    case 'time': return <time className="timestamp" title={fmtFull(n.ts * 1000)} dateTime={new Date(n.ts * 1000).toISOString()}>{formatTimestamp(n.ts, n.style)}</time>;
    case 'br': return <br />;
  }
}
interface Ctx { guildId?: string | null }
function Nodes({ ns, ctx }: { ns: MdNode[]; ctx: Ctx }) { return <>{ns.map((n, i) => <Node key={i} n={n} ctx={ctx} />)}</>; }

export const Markdown = memo(function Markdown({ content, guildId, inline }: { content: string; guildId?: string | null; inline?: boolean }) {
  const ast = parseMarkdown(content);
  const jumbo = !inline && isJumbo(ast);
  return <div className={`md ${jumbo ? 'jumbo' : ''}`}><Nodes ns={ast} ctx={{ guildId }} /></div>;
});
