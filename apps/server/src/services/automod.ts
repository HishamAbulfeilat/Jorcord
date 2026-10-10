import { Perm, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { audit } from './guilds';

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

export interface RuleLike { trigger: string; keywords: string[]; presets: string[]; allowList: string[]; mentionLimit: number }
/** Pure matcher: does `content` (with `mentionCount` mentions) violate this rule? Spam needs history and is handled by the caller. */
export function ruleMatches(r: RuleLike, content: string, mentionCount: number): boolean {
  if (r.trigger === 'link') return /https?:\/\//i.test(content);
  if (r.trigger === 'mention_spam') return mentionCount >= Math.max(1, r.mentionLimit);
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

export async function checkAutomod(ctx: Ctx, guildId: string, userId: string, memberRoleIds: string[], perms: bigint, content: string, mentionCount: number, channelIds: string[] = []) {
  if (has(perms, Perm.MANAGE_GUILD)) return; // administrators/managers are exempt
  const rules = await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled', [guildId]);
  for (const r of rules) {
    if ((r.exempt_roles as string[]).some((x) => memberRoleIds.includes(x))) continue;
    if ((r.exempt_channels as string[]).some((x) => channelIds.includes(x))) continue;
    let hit = r.trigger === 'spam' ? false : ruleMatches({ trigger: r.trigger, keywords: r.keywords, presets: r.presets, allowList: r.allow_list, mentionLimit: r.mention_limit }, content, mentionCount);
    if (r.trigger === 'spam') {
      const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND author_id = $2 AND id > $3', [guildId, userId, snowflake(Date.now() - 5000)]);
      hit = c.n >= 5;
    }
    if (!hit) continue;
    if (r.action === 'alert') { await audit(ctx, guildId, userId, 'AUTOMOD_ALERT', r.id, { content: content.slice(0, 200) }, r.name); continue; }
    if (r.action === 'timeout') {
      await ctx.db.query(`UPDATE members SET timeout_until = now() + ($3::int * interval '1 second') WHERE guild_id = $1 AND user_id = $2`, [guildId, userId, r.timeout_seconds ?? 60]);
      await ctx.pcache.invalidate({ k: 'member', guildId, userId });
    }
    await audit(ctx, guildId, userId, 'AUTOMOD_BLOCK', r.id, null, r.name);
    throw new ApiError(400, 'AUTOMOD_BLOCKED', r.custom_message || 'Your message was blocked by AutoMod', { rule: r.name });
  }
}
