/** Discord-flavoured markdown -> AST. Pure and framework-free so it is easy to test. */
export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; c: MdNode[] }
  | { t: 'code'; v: string }
  | { t: 'codeblock'; lang: string; v: string }
  | { t: 'quote'; c: MdNode[] }
  | { t: 'heading'; level: 1 | 2 | 3; c: MdNode[] }
  /** `-# text`: small, muted line. */
  | { t: 'subtext'; c: MdNode[] }
  | { t: 'list'; ordered: boolean; items: MdNode[][] }
  | { t: 'link'; href: string; c: MdNode[]; masked: boolean }
  | { t: 'user' | 'role' | 'channel'; id: string }
  | { t: 'everyone'; v: 'everyone' | 'here' }
  | { t: 'emoji'; name: string; id: string; animated: boolean }
  | { t: 'time'; ts: number; style: string }
  | { t: 'br' };

const URL_RE = /^https?:\/\/[^\s<>]+/i;
const ESCAPABLE = '\\*_~`|>[]()#-<:@.!+';

export function parseMarkdown(src: string): MdNode[] {
  const out: MdNode[] = [];
  const fence = /```(?:([A-Za-z0-9_+#.-]+)[ \t]*\n)?([\s\S]*?)```/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) {
    if (m.index > last) pushBlocks(out, src.slice(last, m.index));
    let body = m[2];
    let lang = m[1] ?? '';
    // "```code```" with a single word and no newline is code, not a language
    if (!m[1] && /^\n/.test(body)) body = body.slice(1);
    out.push({ t: 'codeblock', lang: lang.toLowerCase(), v: body.replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushBlocks(out, src.slice(last));
  return out;
}

function pushBlocks(out: MdNode[], text: string) {
  const lines = text.split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length) { const n = parseInline(para.join('\n')); out.push(...n); para = []; } };
  // a newline directly following/preceding a block node is cosmetic: handled by skipping empty para
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let mm: RegExpMatchArray | null;
    if (/^>>> /.test(line)) { flush(); out.push({ t: 'quote', c: parseInline([line.slice(4), ...lines.slice(i + 1)].join('\n')) }); return; }
    if (/^> /.test(line) || line === '>') {
      flush();
      const q: string[] = [];
      while (i < lines.length && (/^> /.test(lines[i]) || lines[i] === '>')) { q.push(lines[i].slice(2)); i++; }
      i--; out.push({ t: 'quote', c: parseInline(q.join('\n')) }); continue;
    }
    if ((mm = line.match(/^(#{1,3}) (.+)$/))) { flush(); out.push({ t: 'heading', level: mm[1].length as 1 | 2 | 3, c: parseInline(mm[2]) }); continue; }
    if ((mm = line.match(/^-# (.+)$/))) { flush(); out.push({ t: 'subtext', c: parseInline(mm[1]) }); continue; }
    if (/^(?:[-*]) \S/.test(line) || /^\d+\. \S/.test(line)) {
      flush();
      const ordered = /^\d+\. /.test(line);
      const { node, next } = parseList(lines, i, ordered);
      i = next - 1; out.push(node); continue;
    }
    para.push(line);
    if (i < lines.length - 1) {
      // keep line breaks inside paragraphs; flush if next is block-ish handled on next iteration
    }
  }
  flush();
}

const LIST_LINE = /^([ \t]*)([-*]|\d+\.) \S/;
const indentOf = (s: string) => s.replace(/\t/g, '  ').length;
const stripMarker = (l: string) => l.replace(/^[ \t]*(?:[-*]|\d+\.) /, '');
/**
 * A list starting at `lines[start]` (top level, indent 0-1) of the given kind. Lines indented by 2+ spaces (or a tab) that are
 * themselves list items become ONE nested list under the preceding item; deeper levels are folded into that second level.
 */
function parseList(lines: string[], start: number, ordered: boolean): { node: MdNode; next: number } {
  const items: MdNode[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_LINE.exec(lines[i]);
    if (!m) break;
    const nested = indentOf(m[1]!) >= 2 && items.length > 0;
    if (!nested) {
      if (indentOf(m[1]!) >= 2 || /^\d+\.$/.test(m[2]!) !== ordered) break;
      items.push(parseInline(stripMarker(lines[i]))); i++; continue;
    }
    const subOrdered = /^\d+\.$/.test(m[2]!); const sub: MdNode[][] = [];
    while (i < lines.length) {
      const n = LIST_LINE.exec(lines[i]);
      if (!n || indentOf(n[1]!) < 2) break;
      sub.push(parseInline(stripMarker(lines[i]))); i++;
    }
    items[items.length - 1]!.push({ t: 'list', ordered: subOrdered, items: sub });
  }
  return { node: { t: 'list', ordered, items }, next: i };
}

function isWordChar(c: string | undefined) { return !!c && /[\p{L}\p{N}]/u.test(c); }

function findClose(s: string, from: number, d: string): number {
  let j = from;
  while (j < s.length) {
    const k = s.indexOf(d, j);
    if (k < 0) return -1;
    if (s[k - 1] === '\\') { j = k + 1; continue; }
    if (k === from) { j = k + 1; continue; }
    if (d === '*') { if (s[k + 1] === '*') { j = k + 2; continue; } if (s[k - 1] === '*' && k - 1 >= from) { j = k + 1; continue; } }
    if (d === '_' && (isWordChar(s[k + 1]) || s[k + 1] === '_')) { j = k + 1; continue; }
    if (d === '__' && s[k + 2] === '_') { j = k + 1; continue; }
    return k;
  }
  return -1;
}

export function parseInline(s: string): MdNode[] {
  const out: MdNode[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  const wrap = (t: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler', d: string): boolean => {
    const k = findClose(s, i + d.length, d);
    if (k < 0 || k === i + d.length) return false;
    const inner = s.slice(i + d.length, k);
    if (!inner.trim() && t !== 'spoiler') return false;
    flush(); out.push({ t, c: parseInline(inner) }); i = k + d.length; return true;
  };
  while (i < s.length) {
    const ch = s[i]; const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const ticks = rest.match(/^`+/)![0];
      const k = s.indexOf(ticks, i + ticks.length);
      if (k > i + ticks.length - 0 && k >= 0) {
        // closing run must be exactly the same length
        let kk = k; while (kk >= 0 && s[kk + ticks.length] === '`') kk = s.indexOf(ticks, kk + ticks.length + 1);
        if (kk >= 0) { flush(); out.push({ t: 'code', v: s.slice(i + ticks.length, kk).replace(/^ (.*) $/s, (x, a) => (a.trim() ? a : x)) }); i = kk + ticks.length; continue; }
      }
      buf += ticks; i += ticks.length; continue;
    }
    if (ch === '<') {
      if ((m = rest.match(/^<@!?(\d+)>/))) { flush(); out.push({ t: 'user', id: m[1] }); i += m[0].length; continue; }
      if ((m = rest.match(/^<@&(\d+)>/))) { flush(); out.push({ t: 'role', id: m[1] }); i += m[0].length; continue; }
      if ((m = rest.match(/^<#(\d+)>/))) { flush(); out.push({ t: 'channel', id: m[1] }); i += m[0].length; continue; }
      if ((m = rest.match(/^<(a?):([A-Za-z0-9_~]{2,32}):(\d+)>/))) { flush(); out.push({ t: 'emoji', name: m[2], id: m[3], animated: m[1] === 'a' }); i += m[0].length; continue; }
      if ((m = rest.match(/^<t:(-?\d+)(?::([tTdDfFR]))?>/))) { flush(); out.push({ t: 'time', ts: Number(m[1]), style: m[2] ?? 'f' }); i += m[0].length; continue; }
      if ((m = rest.match(/^<(https?:\/\/[^\s>]+)>/))) { flush(); out.push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }], masked: false }); i += m[0].length; continue; }
    }
    if (ch === '@' && (m = rest.match(/^@(everyone|here)\b/)) && !isWordChar(s[i - 1])) { flush(); out.push({ t: 'everyone', v: m[1] as 'everyone' | 'here' }); i += m[0].length; continue; }
    if (ch === '[' && (m = rest.match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/))) { flush(); out.push({ t: 'link', href: m[2], c: parseInline(m[1]), masked: true }); i += m[0].length; continue; }
    if (ch === 'h' && (m = rest.match(URL_RE)) && !isWordChar(s[i - 1])) {
      let url = m[0];
      while (/[.,;:!?'"]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))) url = url.slice(0, -1);
      flush(); out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }], masked: false }); i += url.length; continue;
    }
    if (ch === '|' && rest.startsWith('||') && wrap('spoiler', '||')) continue;
    if (ch === '*' && rest.startsWith('***')) {
      const k = findClose(s, i + 3, '***');
      if (k > i + 3) { flush(); out.push({ t: 'bold', c: [{ t: 'italic', c: parseInline(s.slice(i + 3, k)) }] }); i = k + 3; continue; }
    }
    if (ch === '*' && rest.startsWith('**') && wrap('bold', '**')) continue;
    if (ch === '_' && rest.startsWith('__') && !isWordChar(s[i - 1]) && wrap('underline', '__')) continue;
    if (ch === '~' && rest.startsWith('~~') && wrap('strike', '~~')) continue;
    if (ch === '*' && !rest.startsWith('* ') && wrap('italic', '*')) continue;
    if (ch === '_' && !isWordChar(s[i - 1]) && !rest.startsWith('_ ') && wrap('italic', '_')) continue;
    buf += ch; i++;
  }
  flush();
  return out;
}

/** True if message is only emojis (unicode or custom) and whitespace, max 27 -> render jumbo. */
export function isJumbo(nodes: MdNode[]): boolean {
  let n = 0;
  for (const x of nodes) {
    if (x.t === 'emoji') n++;
    else if (x.t === 'text') {
      const stripped = x.v.replace(/\s+/g, '');
      if (!stripped) continue;
      const only = stripped.replace(/\p{Extended_Pictographic}|‍|️|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]/gu, '');
      if (only.length) return false;
      n += [...stripped.matchAll(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu)].length;
    } else return false;
  }
  return n > 0 && n <= 27;
}

/** Plain-text rendering (previews, notifications, reply snippets). */
export function toPlain(nodes: MdNode[], resolve?: { user?: (id: string) => string; channel?: (id: string) => string; role?: (id: string) => string }): string {
  return nodes.map((n): string => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return n.v;
      case 'codeblock': return '[code]';
      case 'bold': case 'italic': case 'underline': case 'strike': case 'quote': return toPlain(n.c, resolve);
      case 'heading': case 'subtext': return toPlain(n.c, resolve);
      case 'spoiler': return '[spoiler]';
      case 'list': return n.items.map((i) => i.map((x) => (x.t === 'list' ? ' ' : '') + toPlain([x], resolve)).join('')).join(' ');
      case 'link': return n.masked ? toPlain(n.c, resolve) : n.href;
      case 'user': return '@' + (resolve?.user?.(n.id) ?? 'user');
      case 'role': return '@' + (resolve?.role?.(n.id) ?? 'role');
      case 'channel': return '#' + (resolve?.channel?.(n.id) ?? 'channel');
      case 'everyone': return '@' + n.v;
      case 'emoji': return `:${n.name}:`;
      case 'time': return new Date(n.ts * 1000).toLocaleString();
      case 'br': return ' ';
    }
  }).join('');
}

/** Extract language ids of fenced code blocks (used for lazy highlight loading and tests). */
export function firstUrl(nodes: MdNode[]): string | null {
  for (const n of nodes) {
    if (n.t === 'link' && !n.masked) return n.href;
    if ('c' in n && Array.isArray((n as any).c)) { const r = firstUrl((n as any).c); if (r) return r; }
  }
  return null;
}

export function formatTimestamp(ts: number, style: string, now = Date.now()): string {
  const d = new Date(ts * 1000);
  switch (style) {
    case 't': return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    case 'T': return d.toLocaleTimeString();
    case 'd': return d.toLocaleDateString();
    case 'D': return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    case 'F': return d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
    case 'R': return relativeTime(d.getTime() - now);
    default: return d.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  }
}
export function relativeTime(diffMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const s = Math.round(diffMs / 1000); const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 2592000) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 31536000) return rtf.format(Math.round(s / 2592000), 'month');
  return rtf.format(Math.round(s / 31536000), 'year');
}
