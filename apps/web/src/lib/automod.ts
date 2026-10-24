/** AutoMod presentation + request building (pure, unit tested). The server is the authority; these only shape the form. */
import type { AutoModAction, AutoModOptions, AutoModPreset, AutoModRule, AutoModTrigger } from '@jorcord/shared';

export const TRIGGERS: { id: AutoModTrigger; label: string }[] = [
  { id: 'keyword', label: 'Block custom words' }, { id: 'keyword_preset', label: 'Commonly flagged words' }, { id: 'regex', label: 'Pattern (regex)' },
  { id: 'spam', label: 'Spam' }, { id: 'mention_spam', label: 'Mention spam' }, { id: 'link', label: 'Links' }, { id: 'invite_link', label: 'Invite links' },
  { id: 'caps', label: 'Excessive caps' }, { id: 'repeated_chars', label: 'Repeated characters' }, { id: 'suspicious_links', label: 'Suspicious links (scams, phishing)' },
  { id: 'member_profile', label: 'Member profile (username, name, bio)' },
];
export const ACTIONS: { id: AutoModAction; label: string; hint: string }[] = [
  { id: 'block', label: 'Block message', hint: 'The message is never posted' }, { id: 'warn', label: 'Warn member', hint: 'Adds a warning to their record' },
  { id: 'timeout', label: 'Timeout member', hint: 'Also blocks the message' }, { id: 'alert', label: 'Send alert', hint: 'Posts the details to the alert channel' },
];
export const triggerLabel = (id: string) => TRIGGERS.find((x) => x.id === id)?.label ?? id;
export const actionLabel = (id: string) => ACTIONS.find((x) => x.id === id)?.label ?? id;

export interface RuleForm {
  name: string; trigger: AutoModTrigger; keywords: string; allow: string; presets: AutoModPreset[]; regex: string; mentionLimit: number; actions: AutoModAction[];
  timeoutMin: number; message: string; exemptChannels: string[]; alertChannelId: string; testMode: boolean; spamCount: number; spamSeconds: number; capsPercent: number; repeatLimit: number;
}
export const BLANK_FORM: RuleForm = { name: '', trigger: 'keyword', keywords: '', allow: '', presets: ['profanity'], regex: '', mentionLimit: 5, actions: ['block'], timeoutMin: 1, message: '', exemptChannels: [], alertChannelId: '', testMode: false, spamCount: 5, spamSeconds: 5, capsPercent: 70, repeatLimit: 10 };

export const splitWords = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
/** One pattern per line. */
export const splitLines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

/** Why the form cannot be submitted yet, or null. */
export function formProblem(f: RuleForm): string | null {
  if (!f.name.trim()) return 'Name your rule';
  if (!f.actions.length) return 'Pick at least one action';
  if (f.actions.includes('alert') && !f.alertChannelId && !f.testMode) return 'Choose an alert channel';
  if (f.trigger === 'keyword_preset' && !f.presets.length) return 'Pick at least one word list';
  if (f.trigger === 'keyword' && !splitWords(f.keywords).length) return 'Add at least one word';
  if (f.trigger === 'member_profile' && !splitWords(f.keywords).length && !splitLines(f.regex).length) return 'Add at least one word or pattern';
  if (f.trigger === 'regex') { const p = splitLines(f.regex); if (!p.length) return 'Add at least one pattern'; if (p.length > 10) return 'At most 10 patterns'; if (p.some((x) => x.length > 100)) return 'Patterns are limited to 100 characters'; }
  return null;
}

/** Request body for POST /guilds/:id/automod/rules. Only fields that matter for the chosen trigger/actions are sent. */
export function buildRuleBody(f: RuleForm): Partial<AutoModRule> {
  const options: AutoModOptions = {};
  if (f.trigger === 'spam') { options.spamCount = clamp(f.spamCount, 2, 30); options.spamSeconds = clamp(f.spamSeconds, 2, 60); }
  if (f.trigger === 'caps') options.capsPercent = clamp(f.capsPercent, 50, 100);
  if (f.trigger === 'repeated_chars') options.repeatLimit = clamp(f.repeatLimit, 5, 100);
  const profile = f.trigger === 'member_profile'; // judges usernames, display names, nicknames and bios when someone joins or edits their profile
  const kw = f.trigger === 'keyword' || f.trigger === 'keyword_preset' || profile;
  return {
    name: f.name.trim(), trigger: f.trigger, enabled: true, actions: f.actions, exemptRoles: [], exemptChannels: f.exemptChannels, testMode: f.testMode,
    keywords: f.trigger === 'keyword' || profile ? splitWords(f.keywords) : [],
    ...(kw || f.trigger === 'suspicious_links' ? { allowList: splitWords(f.allow) } : {}), ...(f.trigger === 'keyword_preset' ? { presets: f.presets } : {}),
    ...(f.trigger === 'regex' || (profile && splitLines(f.regex).length) ? { regexPatterns: splitLines(f.regex) } : {}),
    ...(f.trigger === 'mention_spam' ? { mentionLimit: clamp(f.mentionLimit, 1, 50) } : {}),
    ...(f.actions.includes('timeout') ? { timeoutSeconds: clamp(f.timeoutMin * 60, 10, 7 * 86400) } : {}),
    ...(f.actions.includes('block') && f.message.trim() ? { customMessage: f.message.trim() } : {}),
    ...(f.alertChannelId ? { alertChannelId: f.alertChannelId } : {}), ...(Object.keys(options).length ? { options } : {}),
  };
}

/** Second line of a rule in the list. */
export function ruleSummary(r: AutoModRule): string {
  const bits = [triggerLabel(r.trigger), '→ ' + (r.actions ?? [r.action]).map(actionLabel).join(' + ')];
  if ((r.trigger === 'keyword' || r.trigger === 'member_profile') && r.keywords.length) bits.push(r.keywords.slice(0, 5).join(', ') + (r.keywords.length > 5 ? '…' : ''));
  if (r.trigger === 'regex' && r.regexPatterns?.length) bits.push(`${r.regexPatterns.length} pattern${r.regexPatterns.length === 1 ? '' : 's'}`);
  if (r.testMode) bits.push('test mode');
  return bits.join(' • ');
}

/** Toggle `a` in the ordered action list, keeping the canonical order of ACTIONS. */
export function toggleAction(list: AutoModAction[], a: AutoModAction): AutoModAction[] {
  const next = list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
  return ACTIONS.map((x) => x.id).filter((x) => next.includes(x));
}
