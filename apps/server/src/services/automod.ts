import { Perm, has, snowflake, type AutoModAction, type AutoModOptions, type Embed } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { limitOrThrow } from '../lib/ratelimit';
import { RegexError, SafeRegex, compileSafeRegex } from '../lib/saferegex';
import { audit } from './guilds';
import { createMessage } from './messages';

export type AutomodPreset = 'profanity' | 'sexual_content' | 'slurs';
export const AUTOMOD_PRESETS: AutomodPreset[] = ['profanity', 'sexual_content', 'slurs'];

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
/**
 * Built-in word lists for the keyword presets (lower case, matched as whole words, also against leet-speak such as "5h1t").
 * The slur list is stored ROT13-encoded only so that the source file itself does not spell the words out.
 */
export const PRESET_WORDS: Record<AutomodPreset, string[]> = {
  profanity: ['fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'motherfucker', 'shit', 'shits', 'shitty', 'bullshit', 'bitch', 'bitches', 'bastard', 'asshole', 'arsehole', 'dickhead', 'cunt', 'wanker', 'prick', 'piss'],
  sexual_content: ['porn', 'porno', 'pornography', 'blowjob', 'handjob', 'hentai', 'cumshot', 'dildo', 'orgasm', 'nudes', 'xxx', 'milf', 'jerkoff'],
  slurs: ['avttre', 'avttn', 'avttref', 'snttbg', 'snttbgf', 'ergneq', 'ergneqf', 'genaal', 'xvxr', 'fcvp', 'puvax', 'pbba'].map(rot13),
};

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
/** Lower-case, accent-stripped views of a message: as typed, and with common digit/symbol substitutions undone. */
export function matchViews(content: string): string[] {
  const base = content.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const leet = base.replace(/[013457@$]/g, (c) => LEET[c]!);
  return leet === base ? [base] : [base, leet];
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'u');

export const SPAM_DEFAULTS = { spamCount: 5, spamSeconds: 5, capsPercent: 70, capsMinLength: 12, repeatLimit: 10 };
export const MAX_REGEX_PATTERNS = 10;
export const AUTOMOD_ACTIONS: AutoModAction[] = ['block', 'timeout', 'alert', 'warn'];

/** Compile a rule's regex list once per pattern (the engine is linear-time, so even hostile patterns cannot stall the server). Throws RegexError. */
const regexCache = new Map<string, SafeRegex>();
export function safeRegex(p: string): SafeRegex {
  let r = regexCache.get(p);
  if (!r) { r = compileSafeRegex(p); if (regexCache.size >= 500) regexCache.delete(regexCache.keys().next().value!); regexCache.set(p, r); }
  return r;
}
export function validateRegexPatterns(list: string[]): void {
  if (list.length > MAX_REGEX_PATTERNS) throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_REGEX_PATTERNS} patterns per rule`);
  for (const p of list) { try { compileSafeRegex(p); } catch (e) { if (e instanceof RegexError) throw new ApiError(400, 'INVALID_REGEX', `Pattern "${p.slice(0, 30)}": ${e.message}`); throw e; } }
}

const INVITE_RE = /(?:discord(?:app)?\.(?:gg|com\/invite)|jorcord\.[a-z]+\/invite|\/invite\/[a-z0-9-]{4,})/i;
export function capsRatio(content: string): { letters: number; upper: number } {
  let letters = 0, upper = 0;
  for (const ch of content) { const l = ch.toLowerCase(), u = ch.toUpperCase(); if (l !== u) { letters++; if (ch === u) upper++; } }
  return { letters, upper };
}
export function longestRun(content: string): number {
  let best = 0, run = 0, prev = '';
  for (const ch of content) { if (/\s/.test(ch)) { run = 0; prev = ''; continue; } run = ch === prev ? run + 1 : 1; prev = ch; if (run > best) best = run; }
  return best;
}

export interface RuleLike { trigger: string; keywords: string[]; presets: string[]; allowList: string[]; mentionLimit: number; regexPatterns?: string[]; options?: AutoModOptions }
/** Pure matcher: does `content` (with `mentionCount` mentions) violate this rule? Spam needs history and is handled by the caller. */
export function ruleMatches(r: RuleLike, content: string, mentionCount: number): boolean {
  if (r.trigger === 'link') return /https?:\/\//i.test(content);
  if (r.trigger === 'mention_spam') return mentionCount >= Math.max(1, r.mentionLimit);
  if (r.trigger === 'invite_link') return INVITE_RE.test(content);
  if (r.trigger === 'regex') return (r.regexPatterns ?? []).some((p) => { try { return safeRegex(p).test(content); } catch { return false; } });
  if (r.trigger === 'caps') {
    const { letters, upper } = capsRatio(content); const o = { ...SPAM_DEFAULTS, ...r.options };
    return letters >= o.capsMinLength && (upper / letters) * 100 >= o.capsPercent;
  }
  if (r.trigger === 'repeated_chars') return longestRun(content) >= ({ ...SPAM_DEFAULTS, ...r.options }).repeatLimit;
  const allow = r.allowList.map((a) => a.toLowerCase()).filter(Boolean);
  let views = matchViews(content);
  if (allow.length) views = views.map((v) => allow.reduce((acc, a) => acc.split(a).join(' '), v)); // allowed phrases never count
  if (r.trigger === 'keyword') return r.keywords.some((k) => k && views.some((v) => v.includes(k.toLowerCase())));
  if (r.trigger === 'keyword_preset') {
    const words = (r.presets as AutomodPreset[]).flatMap((p) => PRESET_WORDS[p] ?? []);
    return words.some((w) => { const re = wholeWord(w); return views.some((v) => re.test(v)); });
  }
  return false;
}

/** The actions of a stored rule row (`actions` wins; older rows only have `action`). */
export function rowActions(r: any): AutoModAction[] {
  const a = (Array.isArray(r.actions) ? r.actions : []).filter((x: string) => AUTOMOD_ACTIONS.includes(x as AutoModAction));
  return a.length ? a : [r.action];
}
const ruleLike = (r: any): RuleLike => ({ trigger: r.trigger, keywords: r.keywords, presets: r.presets, allowList: r.allow_list, mentionLimit: r.mention_limit, regexPatterns: r.regex_patterns ?? [], options: r.options ?? {} });

async function ruleHit(ctx: Ctx, r: any, guildId: string, userId: string, content: string, mentionCount: number): Promise<boolean> {
  if (r.trigger !== 'spam') return ruleMatches(ruleLike(r), content, mentionCount);
  const o = { ...SPAM_DEFAULTS, ...(r.options ?? {}) };
  const [c] = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND author_id = $2 AND type IN ('default','reply') AND id > $3`, [guildId, userId, snowflake(Date.now() - o.spamSeconds * 1000)]);
  return c.n >= o.spamCount;
}

/** Posts the alert embed (rule, user, content, action taken) in the rule's alert channel. Never throws; flood-limited per guild. */
async function sendAlert(ctx: Ctx, r: any, guildId: string, userId: string, channelId: string | undefined, content: string, actions: AutoModAction[], test: boolean) {
  if (!r.alert_channel_id) return;
  try {
    limitOrThrow(ctx.rl, `automod-alert:${guildId}`, 30, 60_000, ctx.config.rateLimit);
    const [ch] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [r.alert_channel_id, guildId]);
    const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
    const [u] = await ctx.db.query('SELECT username FROM users WHERE id = $1', [userId]);
    if (!ch || !g || (ch.type !== 'text' && ch.type !== 'announcement')) return;
    const [src] = channelId ? await ctx.db.query('SELECT name FROM channels WHERE id = $1', [channelId]) : [];
    const where = src ? `#${src.name}` : 'unknown';
    const taken = test ? 'none (test mode)' : actions.map((a) => ({ block: 'blocked message', timeout: `timed out ${r.timeout_seconds ?? 60}s`, alert: 'alert', warn: 'warned' }[a])).join(', ');
    const embed: Embed = {
      type: 'rich', title: `${test ? '[Test] ' : ''}AutoMod: ${String(r.name).slice(0, 80)}`, color: test ? 0xfaa61a : 0xed4245, author: u?.username ?? userId,
      description: content.slice(0, 500) || '(no text)', footer: `Rule trigger: ${r.trigger}`,
      fields: [{ name: 'User', value: `${u?.username ?? 'unknown'} (${userId})`, inline: true }, { name: 'Channel', value: where, inline: true }, { name: 'Action', value: taken, inline: true }],
    };
    await createMessage(ctx, { channel: ch, authorId: g.owner_id, content: '', senderPerms: 0n, skipChecks: true, allowEmpty: true, webhookId: 'automod', webhookUsername: 'AutoMod', embeds: [embed] });
  } catch (e) { ctx.log.warn({ err: e }, 'automod alert failed'); }
}

export async function checkAutomod(ctx: Ctx, guildId: string, userId: string, memberRoleIds: string[], perms: bigint, content: string, mentionCount: number, channelIds: string[] = []) {
  if (has(perms, Perm.MANAGE_GUILD)) return; // administrators/managers are exempt
  const rules = await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled', [guildId]);
  for (const r of rules) {
    if ((r.exempt_roles as string[]).some((x) => memberRoleIds.includes(x))) continue;
    if ((r.exempt_channels as string[]).some((x) => channelIds.includes(x))) continue;
    if (!(await ruleHit(ctx, r, guildId, userId, content, mentionCount))) continue;
    const actions = rowActions(r);
    if (r.test_mode) { // dry run: log only, the message goes through
      await audit(ctx, guildId, userId, 'AUTOMOD_TEST', r.id, { content: content.slice(0, 200), actions }, r.name);
      await sendAlert(ctx, r, guildId, userId, channelIds[0], content, actions, true);
      continue;
    }
    if (actions.includes('alert')) await sendAlert(ctx, r, guildId, userId, channelIds[0], content, actions, false);
    if (actions.includes('warn')) await ctx.db.query(`INSERT INTO mod_warnings (id, guild_id, user_id, moderator_id, reason, source, rule_id) VALUES ($1,$2,$3,NULL,$4,'automod',$5)`, [snowflake(), guildId, userId, `AutoMod rule "${r.name}"`.slice(0, 500), r.id]);
    if (actions.includes('timeout')) {
      await ctx.db.query(`UPDATE members SET timeout_until = now() + ($3::int * interval '1 second') WHERE guild_id = $1 AND user_id = $2`, [guildId, userId, r.timeout_seconds ?? 60]);
      await ctx.pcache.invalidate({ k: 'member', guildId, userId });
    }
    if (!actions.some((a) => a !== 'alert')) { await audit(ctx, guildId, userId, 'AUTOMOD_ALERT', r.id, { content: content.slice(0, 200) }, r.name); continue; }
    await audit(ctx, guildId, userId, 'AUTOMOD_BLOCK', r.id, { actions }, r.name);
    throw new ApiError(400, 'AUTOMOD_BLOCKED', r.custom_message || 'Your message was blocked by AutoMod', { rule: r.name });
  }
}

/** Dry run for the admin UI: which enabled-or-not rules would match this text (spam needs history and is reported as not evaluated). No side effects. */
export function testRules(rules: any[], content: string, mentionCount: number) {
  return rules.map((r) => ({ ruleId: r.id as string, name: r.name as string, trigger: r.trigger as string, enabled: !!r.enabled, testMode: !!r.test_mode, actions: rowActions(r),
    matched: r.trigger === 'spam' ? false : ruleMatches(ruleLike(r), content, mentionCount), evaluated: r.trigger !== 'spam' }));
}
