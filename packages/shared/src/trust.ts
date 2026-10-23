/**
 * Trust and safety heuristics shared by the server (enforcement) and the web app (display).
 * Everything here is pure and local: no network lookups, no external reputation services.
 * See docs/SAFETY.md.
 */

// ---------- text normalisation ----------

/** Cyrillic / Greek / fullwidth / misc look-alikes mapped to the Latin letter or digit they imitate. */
const CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', һ: 'h', ԛ: 'q', ԝ: 'w', к: 'k', м: 'm', н: 'h', т: 't', в: 'b', ѵ: 'v', ӏ: 'l', ꞵ: 'b',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', η: 'n', μ: 'u', ω: 'w',
  ı: 'i', ɩ: 'i', ǀ: 'l', ǃ: 'i', ℓ: 'l', ⅼ: 'l', ⅰ: 'i', ⅾ: 'd', ⅿ: 'm', ⅽ: 'c', ⅴ: 'v', ⅹ: 'x', ø: 'o', đ: 'd', ł: 'l', ß: 'b', ð: 'd', þ: 'p', æ: 'a', œ: 'o',
};
const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Lower-cased, accent-stripped, homoglyph-folded and leet-folded form of a name, with everything but letters removed. Used to compare names that try to look alike. */
export function skeleton(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKD').toLowerCase()) {
    if (/\p{M}/u.test(ch)) continue; // combining marks (accents, zalgo)
    const c = CONFUSABLES[ch] ?? ch;
    const l = LEET[c] ?? c;
    if (/[a-z]/.test(l)) out += l === 'l' ? 'i' : l; // i, l, 1 and | are interchangeable
  }
  return out;
}

export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

// ---------- link risk ----------

export type LinkRiskReason =
  | 'denied' | 'lookalike_brand' | 'brand_in_subdomain' | 'punycode' | 'mixed_script' | 'userinfo' | 'ip_host' | 'shortener' | 'free_nitro' | 'label_mismatch' | 'risky_tld';
export type LinkRiskLevel = 'ok' | 'suspicious' | 'dangerous';
export interface LinkRisk { url: string; host: string; score: number; level: LinkRiskLevel; reasons: LinkRiskReason[] }
/** What clients receive on a message (only links that scored as suspicious or worse). */
export interface LinkWarning { host: string; level: Exclude<LinkRiskLevel, 'ok'>; reasons: LinkRiskReason[]; score: number }
export interface LinkLists { allow?: string[]; deny?: string[] }

export const LINK_SUSPICIOUS_SCORE = 50;
export const LINK_DANGEROUS_SCORE = 80;
export const MAX_LINK_LIST_ENTRIES = 100;

export const LINK_REASON_TEXT: Record<LinkRiskReason, string> = {
  denied: 'This server blocks this domain',
  lookalike_brand: 'Imitates a well-known site',
  brand_in_subdomain: 'Uses a well-known name to look official',
  punycode: 'Disguised characters in the domain',
  mixed_script: 'Mixes alphabets to look like another site',
  userinfo: 'Hides the real destination behind a fake address',
  ip_host: 'Points at a raw IP address',
  shortener: 'Shortened link hides where it goes',
  free_nitro: 'Looks like a free gift or Nitro scam',
  label_mismatch: 'The link text shows a different site than it opens',
  risky_tld: 'Unusual domain ending',
};

/** Brands that scammers imitate, with the registrable domains that really belong to them. */
const BRANDS: { brand: string; official: string[] }[] = [
  { brand: 'discord', official: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordstatus.com', 'discord.new', 'discord.gift', 'discord.design', 'discordcdn.com', 'dis.gd'] },
  { brand: 'steam', official: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steam-chat.com', 'steamcontent.com', 'steamgames.com'] },
  { brand: 'steamcommunity', official: ['steamcommunity.com'] },
  { brand: 'steampowered', official: ['steampowered.com'] },
  { brand: 'roblox', official: ['roblox.com', 'rbxcdn.com'] },
  { brand: 'epicgames', official: ['epicgames.com', 'unrealengine.com'] },
  { brand: 'paypal', official: ['paypal.com', 'paypal.me'] },
  { brand: 'metamask', official: ['metamask.io'] },
  { brand: 'coinbase', official: ['coinbase.com'] },
  { brand: 'binance', official: ['binance.com'] },
  { brand: 'twitch', official: ['twitch.tv', 'twitchcdn.net', 'ttvnw.net'] },
  { brand: 'nitro', official: ['discord.com', 'discord.gift', 'discordapp.com'] },
];
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ow.ly', 'buff.ly', 'tiny.cc', 'rebrand.ly', 'bit.do', 's.id', 'v.gd', 't.ly', 'urlz.fr', 'clck.ru', 'shrtco.de', 'tr.ee', 'lnkd.in', 'qr.ae']);
const RISKY_TLDS = new Set(['zip', 'mov', 'top', 'xyz', 'click', 'gift', 'tk', 'ml', 'ga', 'cf', 'gq', 'icu', 'cyou', 'monster', 'rest', 'sbs', 'cfd', 'work', 'support', 'link']);
const COMMON_TLDS = new Set(['com', 'net', 'org', 'io', 'gg', 'co', 'me', 'tv', 'app', 'dev', 'info', 'biz', 'us', 'uk', 'de', 'fr', 'ru', 'cn', 'jp', 'nl', 'it', 'es', 'br', 'in', 'ca', 'au', 'gift', 'xyz', 'top', 'click', 'link', 'site', 'online', 'store', 'shop', 'live', 'club', 'pro', 'fun', 'cc', 'ws', 'to', 'ly', 'ink', 'win', 'bid', 'vip', 'icu', 'zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq']);
/** Second-level labels used by registries (co.uk, com.au ...), so "evil.co.uk" has registrable domain evil.co.uk. */
const SLD_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
const FREE_NITRO_RE = /free[\W_]*nitro|nitro[\W_]*(gift|free|drop|giveaway|promo|claim)|(claim|get|redeem)[\W_]*(your[\W_]*)?(free[\W_]*)?(nitro|gift|reward|prize|skin|robux|v[\W_]*bucks)|steam[\W_]*(gift|wallet|giveaway)|gift[\W_]*card[\W_]*(free|claim)|airdrop[\W_]*(claim|nft)|free[\W_]*(robux|skins?|crypto)/i;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_RE = /(?<![\w@./:-])((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,24})(?::\d+)?(?:\/[^\s<>"'`]*)?(?![\w@])/gu;
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi;

export function normalizeHost(s: string): string {
  return s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#:].*$/, '').replace(/\.$/, '');
}
/** Clean a user-entered domain list: lower-case hostnames only, deduplicated, bounded. */
export function normalizeLinkList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const h = normalizeHost(v);
    if (h.length >= 3 && h.length <= 253 && /^[\p{L}\p{N}.-]+$/u.test(h) && h.includes('.')) out.add(h);
    if (out.size >= MAX_LINK_LIST_ENTRIES) break;
  }
  return [...out];
}
const hostMatches = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith('.' + d));

/** Registrable domain (last two labels, three when the second-to-last is a registry label such as co). */
export function registrable(host: string): string {
  const p = host.split('.');
  if (p.length <= 2) return host;
  return p.length >= 3 && SLD_LABELS.has(p[p.length - 2]!) && p[p.length - 1]!.length === 2 ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

/** Score one URL (or bare host). Pure; `lists` are the server's allow and deny lists. Deny beats allow. */
export function assessLink(raw: string, lists: LinkLists = {}, surroundingText = ''): LinkRisk {
  const reasons: LinkRiskReason[] = [];
  let score = 0;
  const add = (r: LinkRiskReason, n: number) => { if (!reasons.includes(r)) reasons.push(r); score += n; };
  let host = '';
  let path = '';
  let userinfo = false;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    host = u.hostname.toLowerCase().replace(/\.$/, '');
    path = decodeURIComponent(u.pathname + u.search).toLowerCase();
    userinfo = !!(u.username || u.password) || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw);
  } catch { host = normalizeHost(raw); }
  const bare = host.replace(/^www\./, '');
  const allow = (lists.allow ?? []).map(normalizeHost);
  const deny = (lists.deny ?? []).map(normalizeHost);
  const res = (): LinkRisk => ({ url: raw.slice(0, 300), host: bare, score: Math.min(100, score), level: score >= LINK_DANGEROUS_SCORE ? 'dangerous' : score >= LINK_SUSPICIOUS_SCORE ? 'suspicious' : 'ok', reasons });
  if (hostMatches(bare, deny)) { add('denied', 100); return res(); }
  if (hostMatches(bare, allow)) return res();

  if (userinfo) add('userinfo', 70);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || /^\[?[0-9a-f:]+\]?$/.test(bare) && bare.includes(':')) add('ip_host', 40);
  if (SHORTENERS.has(bare)) add('shortener', 30);

  const labels = bare.split('.');
  const punycode = labels.some((l) => l.startsWith('xn--'));
  if (punycode) add('punycode', 40);
  const uni = punycode ? decodeHost(bare) : bare; // what a human sees in the address bar
  const uLabels = uni.split('.');
  if (uLabels.some(disguised)) add('mixed_script', 40);

  const reg = registrable(bare);
  const uReg = registrable(uni);
  const skReg = skeleton(uReg.split('.')[0]!);
  const sub = uni.length > uReg.length ? uni.slice(0, uni.length - uReg.length - 1) : '';
  const scamWord = /gift|free|promo|nitro|login|verify|claim|drop|trade|wallet|support|help|secur|airdrop|reward|giveaway|event|partner/.test(skReg);
  for (const b of BRANDS) {
    if (b.official.some((o) => reg === o)) continue; // genuinely theirs
    if (sub && skeleton(sub).includes(skeleton(b.brand))) { add('brand_in_subdomain', 60); break; }
    const near = skReg.length >= 5 && skReg !== b.brand && levenshtein(skReg, skeleton(b.brand), 1) <= 1;
    const long = b.brand.length >= 6;
    if (skReg === skeleton(b.brand) || near) { add('lookalike_brand', 65); break; }
    if (skReg.includes(skeleton(b.brand)) && (scamWord || long)) { add('lookalike_brand', scamWord ? 70 : 50); break; }
  }
  if (RISKY_TLDS.has(labels[labels.length - 1]!)) add('risky_tld', 15);
  const hay = `${uni} ${path}`;
  if (FREE_NITRO_RE.test(hay)) add('free_nitro', 50);
  else if (surroundingText && FREE_NITRO_RE.test(surroundingText) && !hostMatches(bare, ['discord.com', 'discord.gg', 'steampowered.com'])) add('free_nitro', 50);
  return res();
}

/** A label that mixes alphabets, or is written entirely in look-alike letters of another alphabet ("аррӏе"). */
function disguised(label: string): boolean {
  const s = new Set<string>();
  let allConf = true;
  for (const ch of label) {
    if (/[a-z0-9-]/i.test(ch)) { s.add('latin'); continue; }
    if (/\p{Script=Cyrillic}/u.test(ch)) s.add('cyrillic'); else if (/\p{Script=Greek}/u.test(ch)) s.add('greek'); else if (/\p{L}/u.test(ch)) s.add('other'); else continue;
    if (!(ch in CONFUSABLES)) allConf = false;
  }
  return s.size > 1 || (s.size === 1 && !s.has('latin') && allConf);
}

/** Punycode (RFC 3492) to Unicode for each xn-- label; anything undecodable is left as is. */
export function decodeHost(host: string): string {
  return host.split('.').map((l) => (l.startsWith('xn--') ? punyDecode(l.slice(4)) ?? l : l)).join('.');
}
function punyDecode(input: string): string | null {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const out: number[] = [];
  const d = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(0, d); j++) { const c = input.charCodeAt(j); if (c >= 0x80) return null; out.push(c); }
  const adapt = (delta: number, n: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / n);
    let k = 0; while (delta > ((base - tMin) * tMax) >> 1) { delta = Math.floor(delta / (base - tMin)); k += base; }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  let n = 128, i = 0, bias = 72;
  for (let idx = d > 0 ? d + 1 : 0; idx < input.length;) {
    const oldi = i; let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= input.length) return null;
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1)); i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

/** Distinct URLs in a message: explicit http(s) links, markdown links and bare domains with a common TLD. */
export function extractLinks(content: string, max = 10): { url: string; label?: string }[] {
  const seen = new Set<string>();
  const out: { url: string; label?: string }[] = [];
  const push = (url: string, label?: string) => {
    const clean = url.replace(/[.,;:!?)\]}>]+$/, '');
    if (!clean || seen.has(clean) || out.length >= max) return;
    seen.add(clean); out.push({ url: clean, label });
  };
  for (const m of content.matchAll(MD_LINK_RE)) push(m[2]!, m[1]);
  for (const m of content.matchAll(URL_RE)) push(m[0]);
  const rest = content.replace(MD_LINK_RE, ' ').replace(URL_RE, ' ');
  for (const m of rest.matchAll(BARE_RE)) {
    const h = m[1]!.toLowerCase();
    const tld = h.split('.').pop()!;
    if (COMMON_TLDS.has(tld) || tld.startsWith('xn--')) push(m[0]);
  }
  return out;
}

/** Risk of every link in a message, highest first. Markdown links whose text names another domain are flagged. */
export function assessMessageLinks(content: string, lists: LinkLists = {}): LinkRisk[] {
  if (!content || content.length < 4) return [];
  const links = extractLinks(content);
  if (!links.length) return [];
  const text = content.replace(URL_RE, ' ');
  const out = links.map((l) => {
    const r = assessLink(l.url, lists, text);
    if (l.label && r.reasons[0] !== 'denied') {
      const lbl = normalizeHost(l.label);
      if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(lbl) && registrable(lbl) !== registrable(r.host) && !hostMatches(r.host, (lists.allow ?? []).map(normalizeHost))) {
        r.reasons.push('label_mismatch'); r.score = Math.min(100, r.score + 60);
        r.level = r.score >= LINK_DANGEROUS_SCORE ? 'dangerous' : r.score >= LINK_SUSPICIOUS_SCORE ? 'suspicious' : 'ok';
      }
    }
    return r;
  });
  return out.sort((a, b) => b.score - a.score);
}
export function linkWarnings(content: string, lists: LinkLists = {}): LinkWarning[] {
  return assessMessageLinks(content, lists).filter((r) => r.level !== 'ok').slice(0, 5)
    .map((r) => ({ host: r.host, level: r.level as 'suspicious' | 'dangerous', reasons: r.reasons, score: r.score }));
}

// ---------- impersonation ----------

export interface ImpersonationTarget { kind: 'owner' | 'staff' | 'server'; name: string; userId?: string }
export interface ImpersonationMatch { kind: ImpersonationTarget['kind']; target: string; candidate: string; distance: number }
export const IMPERSONATION_ACTIONS = ['flag', 'hold'] as const;
export type ImpersonationAction = (typeof IMPERSONATION_ACTIONS)[number];
export interface ImpersonationGuard { enabled: boolean; action: ImpersonationAction }
/** One row of the moderators' impersonation review queue. */
export interface ImpersonationEntry {
  userId: string; username: string; displayName: string | null; avatar: string | null; accountCreatedAt: string; joinedAt: string; held: boolean;
  match: { kind: ImpersonationTarget['kind']; target: string; name: string; distance: number; at: string };
}
export const DEFAULT_IMPERSONATION_GUARD: ImpersonationGuard = { enabled: false, action: 'flag' };

/**
 * Does `candidate` (a username, display name or nickname) try to pass as one of `targets`?
 * Exact same raw text is NOT a match (the owner themselves, or a harmless identical name is handled by the caller).
 * Matches after homoglyph/leet folding, or within edit distance 1 (names of 5-9 letters) / 2 (10+ letters). Names shorter than 4 letters are never compared.
 */
export function matchImpersonation(candidate: string, targets: ImpersonationTarget[]): ImpersonationMatch | null {
  const c = skeleton(candidate);
  if (c.length < 4) return null;
  for (const t of targets) {
    const k = skeleton(t.name);
    if (k.length < 4) continue;
    const rawEq = candidate.trim().toLowerCase() === t.name.trim().toLowerCase();
    const max = k.length >= 10 ? 2 : k.length >= 5 ? 1 : 0;
    const d = levenshtein(c, k, max);
    if (d <= max) return { kind: t.kind, target: t.name, candidate, distance: rawEq ? 0 : d };
    if (c.length > k.length + 1 && k.length >= 6 && (c.startsWith(k) || c.endsWith(k)) && c.length <= k.length + 6) return { kind: t.kind, target: t.name, candidate, distance: c.length - k.length }; // "ownername_support"
  }
  return null;
}

// ---------- new-account hint ----------

export const NEW_ACCOUNT_DAYS = 7;
export interface AccountAge { days: number; isNew: boolean; label: string }
export function accountAge(createdAt: string | number | Date, now: number = Date.now()): AccountAge {
  const ms = Math.max(0, now - new Date(createdAt).getTime());
  const days = Math.floor(ms / 86_400_000);
  const isNew = days < NEW_ACCOUNT_DAYS;
  let label: string;
  if (ms < 3_600_000) label = 'Created just now';
  else if (days < 1) label = `Created ${Math.floor(ms / 3_600_000)}h ago`;
  else if (days < 60) label = `Created ${days}d ago`;
  else if (days < 730) label = `Created ${Math.floor(days / 30)} months ago`;
  else label = `Created ${Math.floor(days / 365)} years ago`;
  return { days, isNew, label };
}

// ---------- mass-DM detection ----------

/** Fingerprint of a message for similarity grouping: folded text with links, numbers and names collapsed. */
export function messageFingerprint(content: string): string {
  const s = content.toLowerCase().replace(/https?:\/\/\S+/g, ' url ').replace(/<@!?\d+>/g, ' ').replace(/\d+/g, '#').replace(/[^\p{L}#\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}
export interface MassDmConfig { windowMinutes: number; maxRecipients: number; limitMinutes: number }
export const MASS_DM_DEFAULTS: MassDmConfig = { windowMinutes: 30, maxRecipients: 5, limitMinutes: 24 * 60 };
