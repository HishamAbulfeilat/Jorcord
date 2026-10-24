/** Helpers for the search panel: recent searches, highlight matching, token chips. All pure or storage-guarded. */

const KEY = 'jorcord.recentSearches.v1';
export const MAX_RECENT = 8;

export function loadRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []; } catch { return []; }
}
/** Adds a query to the front (case-insensitive de-dupe), ignoring blanks and one-letter queries. */
export function pushRecent(list: string[], q: string): string[] {
  const s = q.trim().replace(/\s+/g, ' ');
  if (s.length < 2) return list;
  return [s, ...list.filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, MAX_RECENT);
}
export function saveRecent(list: string[]): void { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } }
export function clearRecent(): void { try { localStorage.removeItem(KEY); } catch { /* private mode */ } }

/** Words to highlight: the free text of the query, lowercased, deduped, longest first, 1-letter words dropped. */
export function highlightTerms(text: string): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 8);
}

/** [start, end) ranges of every term occurrence in `text` (case-insensitive, non-overlapping, merged). */
export function findMatches(text: string, terms: string[]): [number, number][] {
  if (!terms.length) return [];
  const hay = text.toLowerCase(); const out: [number, number][] = [];
  for (const t of terms) { for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + t.length)) out.push([i, i + t.length]); }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of out) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); }
  return merged;
}

/** Splits text into plain / hit segments for components that render text themselves. */
export function splitHits(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []; let at = 0;
  for (const [s, e] of findMatches(text, terms)) { if (s > at) out.push({ text: text.slice(at, s), hit: false }); out.push({ text: text.slice(s, e), hit: true }); at = e; }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/**
 * Highlights terms inside `root` with the CSS Custom Highlight API (no DOM mutation, so React stays in charge of the
 * nodes). Returns a disposer. Browsers without the API just show the results unhighlighted.
 */
export function applyHighlight(root: HTMLElement, terms: string[], name = 'search-hit'): () => void {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS; const HL = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !HL || !terms.length) return () => {};
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const [s, e] of findMatches(n.nodeValue ?? '', terms)) { const r = document.createRange(); r.setStart(n, s); r.setEnd(n, e); ranges.push(r); }
  }
  const key = `${name}`; const prev = (css.highlights.get(key) as Set<Range> | undefined) ?? null;
  const all = new HL(...(prev ? [...prev, ...ranges] : ranges)) as unknown as Set<Range>;
  css.highlights.set(key, all);
  return () => {
    const cur = css.highlights!.get(key) as Set<Range> | undefined; if (!cur) return;
    const rest = [...cur].filter((r) => !ranges.includes(r));
    if (rest.length) css.highlights!.set(key, new HL(...rest)); else css.highlights!.delete(key);
  };
}

/** Adds `token` to a query if absent, removes it if present (chips that toggle `from:me` style filters). */
export function toggleToken(query: string, token: string): string {
  const parts = query.split(/\s+/).filter(Boolean); const i = parts.findIndex((p) => p.toLowerCase() === token.toLowerCase());
  if (i >= 0) parts.splice(i, 1); else parts.push(token);
  return parts.join(' ');
}
export const hasToken = (query: string, token: string) => query.split(/\s+/).some((p) => p.toLowerCase() === token.toLowerCase());
