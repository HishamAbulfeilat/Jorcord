import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { AutoModPreset, AutoModTrigger } from '@jorcord/shared';
import { api, type AutoModTestResult } from '@/lib/api';
import { useData } from '@/stores/data';
import { toastError } from '@/stores/ui';
import { H1 } from './SettingsLayout';
import { Field, Spinner, Toggle } from '@/components/ui/primitives';
import { ACTIONS, BLANK_FORM, TRIGGERS, buildRuleBody, formProblem, ruleSummary, toggleAction, type RuleForm } from '@/lib/automod';
import { t } from '@/i18n';

const PRESETS: [AutoModPreset, string][] = [['profanity', 'Profanity'], ['sexual_content', 'Sexual content'], ['slurs', 'Slurs']];

/** Server Settings > AutoMod: rules with several actions, an alert channel, regex patterns (linear-time engine on the server) and test mode. */
export function AutoModTab({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['automod', guildId], queryFn: () => api.guilds.automod(guildId) }); const qc = useQueryClient();
  const chans = useData((s) => s.guilds[guildId]?.channels);
  const textChans = Object.values(chans ?? {}).filter((c) => c.type === 'text' || c.type === 'announcement');
  const exemptable = Object.values(chans ?? {}).filter((c) => c.type === 'text' || c.type === 'announcement' || c.type === 'forum' || c.type === 'media');
  const [f, setF] = useState<RuleForm>(BLANK_FORM); const set = (p: Partial<RuleForm>) => setF((x) => ({ ...x, ...p }));
  const [sample, setSample] = useState(''); const [result, setResult] = useState<AutoModTestResult[] | null>(null);
  const refetch = () => qc.invalidateQueries({ queryKey: ['automod', guildId] });
  const problem = formProblem(f);
  const create = () => api.guilds.createAutomod(guildId, buildRuleBody(f)).then(() => { setF({ ...BLANK_FORM, trigger: f.trigger }); void refetch(); }).catch(toastError);
  const runTest = () => api.guilds.testAutomod(guildId, { content: sample }).then(setResult).catch(toastError);
  const togglePreset = (p: AutoModPreset) => set({ presets: f.presets.includes(p) ? f.presets.filter((x) => x !== p) : [...f.presets, p] });
  const num = (label: string, key: 'spamCount' | 'spamSeconds' | 'capsPercent' | 'repeatLimit' | 'mentionLimit', min: number, max: number) =>
    <Field label={t(label)}><input className="field !w-28" type="number" min={min} max={max} value={f[key]} onChange={(e) => set({ [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) })} /></Field>;
  return (<div data-testid="automod-tab">
    <H1>{t('AutoMod')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Automatically moderate your server by blocking messages, warning or timing out offenders, and alerting moderators. Members who can manage the server are never affected.')}</p>
    <div className="mb-6 rounded-lg bg-side p-4">
      <h3 className="mb-3 font-bold text-header">{t('Create rule')}</h3>
      <div className="grid gap-3 sm:grid-cols-2"><Field label={t('Name')}><input className="field" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('Trigger')}><select className="field" aria-label={t('Trigger')} value={f.trigger} onChange={(e) => set({ trigger: e.target.value as AutoModTrigger })}>{TRIGGERS.map((x) => <option key={x.id} value={x.id}>{t(x.label)}</option>)}</select></Field></div>
      {f.trigger === 'keyword' && <Field label={t('Keywords (comma separated)')}><input className="field" value={f.keywords} onChange={(e) => set({ keywords: e.target.value })} placeholder={t('word1, word2')} /></Field>}
      {f.trigger === 'keyword_preset' && <fieldset className="mb-3"><legend className="label">{t('Word lists')}</legend><div className="flex flex-wrap gap-3">{PRESETS.map(([id, label]) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.presets.includes(id)} onChange={() => togglePreset(id)} />{t(label)}</label>)}</div></fieldset>}
      {f.trigger === 'suspicious_links' && <p className="mb-3 text-sm text-muted">{t('Catches look-alike Discord and Steam domains, disguised characters, free Nitro bait and links whose text hides the real address. Domains on the Safety Setup allow and deny lists are respected.')}</p>}
      {f.trigger === 'suspicious_links' && <Field label={t('Extra allowed domains (comma separated)')}><input className="field" value={f.allow} onChange={(e) => set({ allow: e.target.value })} placeholder="example.com" /></Field>}
      {(f.trigger === 'keyword' || f.trigger === 'keyword_preset') && <Field label={t('Allowed words and phrases (comma separated)')}><input className="field" value={f.allow} onChange={(e) => set({ allow: e.target.value })} /></Field>}
      {f.trigger === 'regex' && <Field label={t('Patterns (one per line, up to 3, case-insensitive)')}>
        <textarea className="field h-24 font-mono text-sm" aria-label={t('Patterns')} value={f.regex} onChange={(e) => set({ regex: e.target.value })} placeholder={'\\d{3}-\\d{4}\nfree\\s+nitro'} />
        <span className="mt-1 block text-xs text-muted">{t('Supports . [a-z] \\d \\w \\s \\b ^ $ ( ) | * + ? {n,m}. Back-references and look-around are not allowed so a pattern can never slow the server down.')}</span></Field>}
      {f.trigger === 'mention_spam' && num('Mentions per message before the rule triggers', 'mentionLimit', 1, 50)}
      {f.trigger === 'spam' && <div className="flex flex-wrap gap-4">{num('Messages', 'spamCount', 2, 30)}{num('Within (seconds)', 'spamSeconds', 2, 60)}</div>}
      {f.trigger === 'caps' && num('Percent of letters in capitals (at least 12 letters)', 'capsPercent', 50, 100)}
      {f.trigger === 'repeated_chars' && num('Same character in a row', 'repeatLimit', 5, 100)}
      <fieldset className="mb-3"><legend className="label">{t('Actions')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">{ACTIONS.map((a) => <label key={a.id} title={t(a.hint)} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.actions.includes(a.id)} onChange={() => set({ actions: toggleAction(f.actions, a.id) })} />{t(a.label)}</label>)}</div></fieldset>
      {f.actions.includes('timeout') && <Field label={t('Timeout length (minutes)')}><input className="field !w-28" type="number" min={1} max={10080} value={f.timeoutMin} onChange={(e) => set({ timeoutMin: Math.min(10080, Math.max(1, Number(e.target.value) || 1)) })} /></Field>}
      {f.actions.includes('block') && <Field label={t('Message shown to the sender (optional)')}><input className="field" maxLength={150} value={f.message} onChange={(e) => set({ message: e.target.value })} /></Field>}
      <Field label={t('Alert channel')}><select className="field" aria-label={t('Alert channel')} value={f.alertChannelId} onChange={(e) => set({ alertChannelId: e.target.value })}><option value="">{t('None')}</option>{textChans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select>
        <span className="mt-1 block text-xs text-muted">{t('Each hit posts the rule, member, message and action taken in this channel.')}</span></Field>
      {exemptable.length > 0 && <Field label={t('Exempt channels')}><select multiple aria-label={t('Exempt channels')} className="field h-24" value={f.exemptChannels} onChange={(e) => set({ exemptChannels: [...e.target.selectedOptions].map((o) => o.value) })}>{exemptable.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>}
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.testMode} onChange={(e) => set({ testMode: e.target.checked })} />{t('Test mode: only log hits to the alert channel and audit log, take no action')}</label>
      {problem && f.name.trim() && <p className="mb-2 text-xs text-muted" role="note">{t(problem)}</p>}
      <button disabled={!!problem} className="btn btn-primary" onClick={() => void create()}>{t('Create Rule')}</button>
    </div>
    <div className="mb-6 rounded-lg bg-side p-4" data-testid="automod-sandbox">
      <h3 className="mb-2 font-bold text-header">{t('Try your rules')}</h3>
      <p className="mb-2 text-xs text-muted">{t('Type a sample message to see which rules would match. Nothing is sent or logged.')}</p>
      <div className="flex gap-2"><input className="field" aria-label={t('Sample message')} maxLength={4000} value={sample} onChange={(e) => { setSample(e.target.value); setResult(null); }} /><button className="btn btn-secondary" disabled={!sample.trim()} onClick={() => void runTest()}>{t('Test')}</button></div>
      {result && <ul className="mt-2 text-sm" aria-live="polite">{result.length === 0 ? <li className="text-muted">{t('No rules yet')}</li> : result.map((x) => <li key={x.ruleId} className={x.matched ? 'text-danger' : 'text-muted'}>{x.matched ? t('Would trigger') : x.evaluated ? t('No match') : t('Needs message history')}: {x.name}{x.matched && x.testMode ? ` (${t('test mode')})` : ''}</li>)}</ul>}
    </div>
    {q.isLoading && <Spinner />}
    <ul>{q.data?.map((r) => <li key={r.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><div className="min-w-0 flex-1"><div className="font-semibold text-header">{r.name}</div><div className="truncate text-xs text-muted">{ruleSummary(r)}</div></div><Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={(v) => api.guilds.patchAutomod(guildId, r.id, { enabled: v }).then(refetch).catch(toastError)} /><button aria-label={t('Delete rule')} className="p-2 text-danger" onClick={() => api.guilds.deleteAutomod(guildId, r.id).then(refetch).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </div>);
}
