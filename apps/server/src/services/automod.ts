import { Perm, assessMessageLinks, has, snowflake, type AutoModAction, type AutoModOptions, type Embed, type LinkLists } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { limitOrThrow } from '../lib/ratelimit';
import { RegexError, RegexTimeout, SafeRegex, compileSafeRegex } from '../lib/saferegex';
import { audit } from './guilds';
import { guildLinkLists } from './linkrisk';
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
export const MAX_REGEX_PATTERNS = 3;
export const MAX_REGEX_RULES_PER_GUILD = 5;
/** Total wall-clock budget for all regex matching on one message (ms). */
export const REGEX_BUDGET_MS = 25;
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
export function ruleMatches(r: RuleLike, content: string, mentionCount: number, deadline?: number, links?: LinkLists): boolean {
  if (r.trigger === 'suspicious_links') { // scam/phishing scoring (shared/trust.ts); the rule's own allow list and keywords extend the server's allow and deny lists
    const min = r.options?.linkMinScore ?? 50;
    return assessMessageLinks(content, { allow: [...(links?.allow ?? []), ...r.allowList], deny: [...(links?.deny ?? []), ...r.keywords] }).some((x) => x.score >= min);
  }
  if (r.trigger === 'link') return /https?:\/\//i.test(content);
  if (r.trigger === 'mention_spam') return mentionCount >= Math.max(1, r.mentionLimit);
  if (r.trigger === 'invite_link') return INVITE_RE.test(content);
  if (r.trigger === 'regex') return (r.regexPatterns ?? []).some((p) => { try { return safeRegex(p).test(content, deadline); } catch (e) { if (e instanceof RegexTimeout) throw e; return false; } });
  if (r.trigger === 'caps') {
    const { letters, upper } = capsRatio(content); const o = { ...SPAM_DEFAULTS, ...r.options };
    return letters >= o.capsMinLength && (upper / letters) * 100 >= o.capsPercent;
  }
  if (r.trigger === 'repeated_chars') return longestRun(content) >= ({ ...SPAM_DEFAULTS, ...r.options }).repeatLimit;
  if (r.trigger === 'member_profile') { // keywords / presets / regex against one profile text (username, display name, nickname or bio)
    const parts: RuleLike[] = [];
    if (r.keywords.length) parts.push({ ...r, trigger: 'keyword' });
    if (r.presets.length) parts.push({ ...r, trigger: 'keyword_preset' });
    if (r.regexPatterns?.length) parts.push({ ...r, trigger: 'regex' });
    return parts.some((x) => ruleMatches(x, content, 0, deadline));
  }
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

async function ruleHit(ctx: Ctx, r: any, guildId: string, userId: string, content: string, mentionCount: number, deadline: number, links?: LinkLists): Promise<boolean> {
  if (r.trigger !== 'spam') {
    try { return ruleMatches(ruleLike(r), content, mentionCount, deadline, links); } catch (e) {
      if (e instanceof RegexTimeout) { ctx.log.warn({ guildId, ruleId: r.id }, 'automod regex time budget exceeded; treating as no match'); return false; }
      throw e;
    }
  }
  const o = { ...SPAM_DEFAULTS, ...(r.options ?? {}) };
  const [c] = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND author_id = $2 AND type IN ('default','reply') AND id > $3`, [guildId, userId, snowflake(Date.now() - o.spamSeconds * 1000)]);
  return c.n >= o.spamCount;
}

/** Fixed id of the built-in "AutoMod" bot user that authors alert messages (created on first use; never a member of any server). */
export const AUTOMOD_USER_ID = '1000000000000000001';
const automodUserReady = new WeakSet<object>();
export async function automodUserId(ctx: Ctx): Promise<string> {
  if (!automodUserReady.has(ctx.db)) {
    await ctx.db.query(`INSERT INTO users (id, username, display_name, bot, verified, presence) VALUES ($1,'AutoMod','AutoMod',true,true,'online') ON CONFLICT (id) DO NOTHING`, [AUTOMOD_USER_ID]);
    automodUserReady.add(ctx.db);
  }
  return AUTOMOD_USER_ID;
}

/** Posts the alert embed (rule, user, content, action taken) in the rule's alert channel. Never throws; flood-limited per guild. */
async function sendAlert(ctx: Ctx, r: any, guildId: string, userId: string, channelId: string | undefined, content: string, actions: AutoModAction[], test: boolean) {
  if (!r.alert_channel_id) return;
  try {
    limitOrThrow(ctx.rl, `automod-alert:${guildId}`, 30, 60_000, ctx.config.rateLimit);
    const [ch] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [r.alert_channel_id, guildId]);
    const [u] = await ctx.db.query('SELECT username FROM users WHERE id = $1', [userId]);
    if (!ch || (ch.type !== 'text' && ch.type !== 'announcement')) return;
    const [src] = channelId ? await ctx.db.query('SELECT name FROM channels WHERE id = $1', [channelId]) : [];
    const where = src ? `#${src.name}` : 'unknown';
    const taken = test ? 'none (test mode)' : actions.map((a) => ({ block: 'blocked message', timeout: `timed out ${r.timeout_seconds ?? 60}s`, alert: 'alert', warn: 'warned' }[a])).join(', ');
    const embed: Embed = {
      type: 'rich', title: `${test ? '[Test] ' : ''}AutoMod: ${String(r.name).slice(0, 80)}`, color: test ? 0xfaa61a : 0xed4245, author: u?.username ?? userId,
      description: content.slice(0, 500) || '(no text)', footer: `Rule trigger: ${r.trigger}`,
      fields: [{ name: 'User', value: `${u?.username ?? 'unknown'} (${userId})`, inline: true }, { name: 'Channel', value: where, inline: true }, { name: 'Action', value: taken, inline: true }],
    };
    await createMessage(ctx, { channel: ch, authorId: await automodUserId(ctx), content: '', senderPerms: 0n, skipChecks: true, allowEmpty: true, embeds: [embed] });
  } catch (e) { ctx.log.warn({ err: e }, 'automod alert failed'); }
}

export async function checkAutomod(ctx: Ctx, guildId: string, userId: string, memberRoleIds: string[], perms: bigint, content: string, mentionCount: number, channelIds: string[] = []) {
  if (has(perms, Perm.MANAGE_GUILD)) return; // administrators/managers are exempt
  const rules = await ctx.db.query(`SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled AND trigger <> 'member_profile'`, [guildId]); // profile rules judge people, not messages (checkMemberProfile)
  const deadline = Date.now() + REGEX_BUDGET_MS;
  const links = rules.some((r) => r.trigger === 'suspicious_links') ? await guildLinkLists(ctx, guildId) : undefined;
  for (const r of rules) {
    if ((r.exempt_roles as string[]).some((x) => memberRoleIds.includes(x))) continue;
    if ((r.exempt_channels as string[]).some((x) => channelIds.includes(x))) continue;
    if (!(await ruleHit(ctx, r, guildId, userId, content, mentionCount, deadline, links))) continue;
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

/** Triggers that judge the words themselves; the others (links, caps, spam, mention counts) describe how a *person* types and do not fit bot output (a feed post always has a link). */
const BOT_OUTPUT_TRIGGERS = ['keyword', 'keyword_preset', 'regex', 'invite_link'];

/**
 * Public bot / system output (8-ball, channel reminders, welcome and stream-feed posts) echoes user-controlled text (questions, reminder texts, usernames, stream titles),
 * so it passes the server's content rules too. True when an enabled, non-test rule that blocks would hit `content` in these channels.
 * No side effects (no warning, timeout or alert: nobody typed it). Callers fall back to an ephemeral reply or skip the post.
 */
export async function botOutputBlocked(ctx: Ctx, guildId: string | null | undefined, content: string, channelIds: string[] = []): Promise<boolean> {
  if (!guildId || !content.trim()) return false;
  const rules = await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled AND NOT test_mode AND trigger = ANY($2::text[])', [guildId, BOT_OUTPUT_TRIGGERS]);
  const deadline = Date.now() + REGEX_BUDGET_MS;
  for (const r of rules) {
    if ((r.exempt_channels as string[]).some((x) => channelIds.includes(x))) continue;
    if (!rowActions(r).some((a) => a !== 'alert')) continue; // alert-only rules never stop a message
    let hit = false;
    try { hit = ruleMatches(ruleLike(r), content, 0, deadline); } catch { hit = false; }
    if (hit) return true;
  }
  return false;
}

/** Dry run for the admin UI: which enabled-or-not rules would match this text (spam needs history and is reported as not evaluated). No side effects. */
export function testRules(rules: any[], content: string, mentionCount: number, links?: LinkLists) {
  return rules.map((r) => ({ ruleId: r.id as string, name: r.name as string, trigger: r.trigger as string, enabled: !!r.enabled, testMode: !!r.test_mode, actions: rowActions(r),
    matched: r.trigger === 'spam' ? false : (() => { try { return ruleMatches(ruleLike(r), content, mentionCount, Date.now() + REGEX_BUDGET_MS, links); } catch { return false; } })(), evaluated: r.trigger !== 'spam' }));
}


/**
 * AutoMod "member profile" rules: the keyword / preset / regex lists are checked against the member's username, display name, nickname and bio
 * when they join and whenever one of those changes. A hit applies the rule's actions: `block` puts the member on hold and into the review queue
 * (Safety > Impersonation) until a moderator clears them, `timeout` and `warn` as for messages, `alert` posts to the rule's alert channel.
 * Managers, exempt roles, bots and the owner are skipped. Never throws.
 */
export async function checkMemberProfile(ctx: Ctx, guildId: string, userId: string): Promise<{ ruleId: string; field: string } | null> {
  try {
    const rules = await ctx.db.query(`SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled AND trigger = 'member_profile'`, [guildId]);
    if (!rules.length) return null;
    const [u] = await ctx.db.query('SELECT username, display_name, bio, bot FROM users WHERE id = $1', [userId]);
    const [m] = await ctx.db.query('SELECT nick FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
    if (!u || !m || !g || u.bot || g.owner_id === userId) return null;
    const roleIds = (await ctx.db.query('SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).map((x) => x.role_id as string);
    const fields: [string, string | null][] = [['username', u.username], ['display name', u.display_name], ['nickname', m.nick], ['bio', u.bio]];
    const deadline = Date.now() + REGEX_BUDGET_MS * 2;
    for (const r of rules) {
      if ((r.exempt_roles as string[]).some((x) => roleIds.includes(x))) continue;
      const hit = fields.find(([, v]) => { if (!v) return false; try { return ruleMatches(ruleLike(r), v, 0, deadline); } catch { return false; } });
      if (!hit) continue;
      const actions = rowActions(r);
      const shown = `${hit[0]}: ${String(hit[1]).slice(0, 100)}`;
      if (r.test_mode) { await audit(ctx, guildId, userId, 'AUTOMOD_TEST', r.id, { field: hit[0], actions }, r.name); await sendAlert(ctx, r, guildId, userId, undefined, shown, actions, true); continue; }
      if (actions.includes('alert')) await sendAlert(ctx, r, guildId, userId, undefined, shown, actions, false);
      if (actions.includes('warn')) await ctx.db.query(`INSERT INTO mod_warnings (id, guild_id, user_id, moderator_id, reason, source, rule_id) VALUES ($1,$2,$3,NULL,$4,'automod',$5)`, [snowflake(), guildId, userId, `AutoMod rule "${r.name}" (profile ${hit[0]})`.slice(0, 500), r.id]);
      if (actions.includes('timeout')) await ctx.db.query(`UPDATE members SET timeout_until = now() + ($3::int * interval '1 second') WHERE guild_id = $1 AND user_id = $2`, [guildId, userId, r.timeout_seconds ?? 60]);
      if (actions.includes('block')) {
        const flag = { kind: 'profile', target: String(r.name).slice(0, 80), name: String(hit[1]).slice(0, 100), distance: 0, at: new Date().toISOString() };
        await ctx.db.query('UPDATE members SET impersonation_flag = $3::jsonb, safety_hold = true WHERE guild_id = $1 AND user_id = $2', [guildId, userId, JSON.stringify(flag)]);
      }
      await ctx.pcache.invalidate({ k: 'member', guildId, userId });
      await audit(ctx, guildId, userId, actions.some((a) => a !== 'alert') ? 'AUTOMOD_BLOCK' : 'AUTOMOD_ALERT', r.id, { field: hit[0], actions }, r.name);
      return { ruleId: r.id as string, field: hit[0] };
    }
  } catch (e) { ctx.log.warn({ err: e, guildId, userId }, 'member profile check failed'); }
  return null;
}

/** After a profile change: re-check the member in every server that has a profile rule. */
export async function checkMemberProfileEverywhere(ctx: Ctx, userId: string) {
  const gs = await ctx.db.query(`SELECT DISTINCT m.guild_id FROM members m JOIN automod_rules r ON r.guild_id = m.guild_id AND r.enabled AND r.trigger = 'member_profile' WHERE m.user_id = $1 LIMIT 100`, [userId]);
  for (const g of gs) await checkMemberProfile(ctx, g.guild_id, userId);
}
