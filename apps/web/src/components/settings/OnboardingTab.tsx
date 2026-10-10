import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ONBOARDING_LIMITS, type Id, type OnboardingPrompt } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1, H3, SaveBar } from './SettingsLayout';
import { Row, Spinner, Toggle } from '@/components/ui/primitives';
import { t } from '@/i18n';

type Draft = { enabled: boolean; defaultChannelIds: Id[]; prompts: OnboardingPrompt[] };
const newId = () => `new${Math.random().toString(36).slice(2)}`;

function MultiPick({ label, options, value, onChange }: { label: string; options: { id: Id; name: string }[]; value: Id[]; onChange: (v: Id[]) => void }) {
  return (
    <fieldset className="mt-1"><legend className="text-xs font-bold uppercase text-muted">{label}</legend>
      <div className="mt-1 flex flex-wrap gap-1">{options.map((o) => { const on = value.includes(o.id); return <button key={o.id} type="button" aria-pressed={on} aria-label={`${label}: ${o.name}`} onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])} className={`rounded px-2 py-0.5 text-xs ${on ? 'bg-brand text-white' : 'bg-side text-interactive hover:bg-hover'}`}>{o.name}</button>; })}</div>
    </fieldset>
  );
}

/** Server Settings > Onboarding (MANAGE_GUILD): questions whose answers grant roles and opt members into channels. */
export function OnboardingTab({ guildId }: { guildId: Id }) {
  const qc = useQueryClient(); const g = useData((s) => s.guilds[guildId])!;
  const q = useQuery({ queryKey: ['onboarding', guildId], queryFn: () => api.guilds.onboarding(guildId), staleTime: 0 });
  const [d, setD] = useState<Draft | null>(null); const [orig, setOrig] = useState('');
  useEffect(() => { if (q.data && !d) { const v = { enabled: q.data.enabled, defaultChannelIds: q.data.defaultChannelIds, prompts: q.data.prompts }; setD(v); setOrig(JSON.stringify(v)); } }, [q.data, d]);
  const [busy, setBusy] = useState(false);
  if (!d) return <><H1>{t('Onboarding')}</H1><Spinner /></>;
  const chans = Object.values(g.channels).filter((c) => c.type !== 'category' && c.type !== 'thread').sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: `#${c.name}` }));
  const roles = Object.values(g.roles).filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name }));
  const setPrompt = (i: number, p: Partial<OnboardingPrompt>) => setD({ ...d, prompts: d.prompts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const save = async () => {
    setBusy(true);
    try {
      const strip = (id: Id) => (id.startsWith('new') ? undefined : id);
      const out = await api.guilds.putOnboarding(guildId, { enabled: d.enabled, defaultChannelIds: d.defaultChannelIds, prompts: d.prompts.map((p) => ({ id: strip(p.id), title: p.title, singleSelect: p.singleSelect, required: p.required, options: p.options.map((o) => ({ id: strip(o.id), title: o.title, description: o.description || null, emoji: o.emoji || null, channelIds: o.channelIds, roleIds: o.roleIds })) })) });
      const v = { enabled: out.enabled, defaultChannelIds: out.defaultChannelIds, prompts: out.prompts }; setD(v); setOrig(JSON.stringify(v));
      void qc.invalidateQueries({ queryKey: ['onboarding', guildId] }); toast(t('Onboarding saved'), 'success');
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const dirty = JSON.stringify(d) !== orig;
  return (<div data-testid="onboarding-tab">
    <H1>{t('Onboarding')}</H1>
    <Row title={t('Enable onboarding')} desc={t('New members answer your questions; their answers grant roles and choose which channels they see.')}><Toggle label={t('Enable onboarding')} checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} /></Row>
    <H3>{t('Default channels')}</H3>
    <MultiPick label={t('Default channels')} options={chans} value={d.defaultChannelIds} onChange={(v) => setD({ ...d, defaultChannelIds: v })} />
    <H3>{t('Questions')}</H3>
    {d.prompts.map((p, i) => (
      <div key={p.id} className="mb-4 rounded-lg bg-side p-3" data-testid="onb-prompt">
        <div className="flex items-center gap-2"><input className="field flex-1" aria-label={t('Question')} maxLength={100} value={p.title} placeholder={t('What are you into?')} onChange={(e) => setPrompt(i, { title: e.target.value })} />
          <button aria-label={t('Delete question')} className="p-2 text-danger" onClick={() => setD({ ...d, prompts: d.prompts.filter((_, j) => j !== i) })}><Trash2 size={16} /></button></div>
        <div className="mt-2 flex flex-wrap gap-4 text-sm text-header"><label className="flex items-center gap-2"><input type="checkbox" className="accent-brand" checked={p.singleSelect} onChange={(e) => setPrompt(i, { singleSelect: e.target.checked })} />{t('Single answer')}</label><label className="flex items-center gap-2"><input type="checkbox" className="accent-brand" checked={p.required} onChange={(e) => setPrompt(i, { required: e.target.checked })} />{t('Required')}</label></div>
        {p.options.map((o, k) => (
          <div key={o.id} className="mt-3 rounded bg-[rgb(var(--modal-alt))] p-2">
            <div className="flex gap-2"><input className="field !w-16" aria-label={t('Emoji')} maxLength={8} value={o.emoji ?? ''} placeholder="🎮" onChange={(e) => setPrompt(i, { options: p.options.map((x, j) => (j === k ? { ...x, emoji: e.target.value } : x)) })} />
              <input className="field flex-1" aria-label={t('Answer')} maxLength={50} value={o.title} placeholder={t('Answer')} onChange={(e) => setPrompt(i, { options: p.options.map((x, j) => (j === k ? { ...x, title: e.target.value } : x)) })} />
              <button aria-label={t('Delete answer')} className="p-2 text-danger" disabled={p.options.length < 2} onClick={() => setPrompt(i, { options: p.options.filter((_, j) => j !== k) })}><Trash2 size={14} /></button></div>
            <MultiPick label={t('Channels')} options={chans} value={o.channelIds} onChange={(v) => setPrompt(i, { options: p.options.map((x, j) => (j === k ? { ...x, channelIds: v } : x)) })} />
            <MultiPick label={t('Roles')} options={roles} value={o.roleIds} onChange={(v) => setPrompt(i, { options: p.options.map((x, j) => (j === k ? { ...x, roleIds: v } : x)) })} />
          </div>
        ))}
        {p.options.length < ONBOARDING_LIMITS.optionsPerPrompt && <button className="btn btn-secondary mt-3" onClick={() => setPrompt(i, { options: [...p.options, { id: newId(), title: '', description: null, emoji: null, channelIds: [], roleIds: [] }] })}><Plus size={14} />{t('Add answer')}</button>}
      </div>
    ))}
    {d.prompts.length < ONBOARDING_LIMITS.prompts && <button className="btn btn-secondary" onClick={() => setD({ ...d, prompts: [...d.prompts, { id: newId(), title: '', singleSelect: false, required: false, options: [{ id: newId(), title: '', description: null, emoji: null, channelIds: [], roleIds: [] }] }] })}><Plus size={14} />{t('Add question')}</button>}
    <SaveBar dirty={dirty && d.prompts.every((p) => p.title.trim() && p.options.every((o) => o.title.trim()))} busy={busy} onSave={save} onReset={() => setD(JSON.parse(orig))} />
  </div>);
}
