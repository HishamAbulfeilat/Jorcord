import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { EVASION_MIN_SCORE, type ModSettings } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { Avatar } from '@/components/ui/Avatar';
import { Empty, Row, Spinner, Toggle } from '@/components/ui/primitives';
import { H1, H3 } from '@/components/settings/SettingsLayout';
import { displayName } from '@/lib/format';
import { t } from '@/i18n';

type Patch = { [K in keyof ModSettings]?: Partial<ModSettings[K]> };
const minutesToTime = (m: number | null) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const timeToMinutes = (v: string) => { const [h, m] = v.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null; };
const AUDIT_CHOICES: [string, number | null][] = [['Keep forever', null], ['30 days', 30], ['90 days', 90], ['180 days', 180], ['1 year', 365], ['2 years', 730]];
const EDIT_CHOICES: [string, number | null][] = [['Keep forever', null], ['7 days', 7], ['30 days', 30], ['90 days', 90], ['1 year', 365]];

/** Server Settings > Moderation: role memory, removal notices, retention, ban-evasion hints and each moderator's own wellbeing settings (docs/MODERATION.md). */
export function ModerationTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mod-settings', guildId], queryFn: () => api.guilds.modSettings(guildId), retry: false });
  const save = useMutation({
    mutationFn: (p: Patch) => api.guilds.patchModSettings(guildId, p),
    onSuccess: (s) => { qc.setQueryData(['mod-settings', guildId], s); toast(t('Saved'), 'success'); },
    onError: toastError,
  });
  const s = q.data;
  if (q.isLoading) return <Spinner />;
  if (!s) return <p className="text-sm text-muted">{t('You cannot see these settings.')}</p>;
  const ro = !canManage || save.isPending;
  const num = (v: string): number | null => (v === '' ? null : Number(v));
  return (<div data-testid="moderation-tab">
    <H1>{t('Moderation')}</H1>
    {!canManage && <p className="mb-3 text-sm text-muted">{t('Only people with Manage Server can change the server settings. Your own wellbeing settings are at the bottom.')}</p>}

    <section aria-label={t('Remember roles')} className="mb-6">
      <H3>{t('Remember roles')}</H3>
      <p className="mb-2 text-sm text-muted">{t('A kicked member who comes back within the window gets their roles again, so a warning does not cost you re-adding everything. Only roles the kicking moderator could still grant are restored, never roles that gained permissions in the meantime.')}</p>
      <Row title={t('Remember roles')}><Toggle label={t('Remember roles')} checked={s.rememberRoles.enabled} disabled={ro} onChange={(v) => save.mutate({ rememberRoles: { enabled: v } })} /></Row>
      <Row title={t('When a moderator kicks someone')} desc={t('The kick dialog has a switch for each kick.')}><Toggle label={t('Remember on kick')} checked={s.rememberRoles.onKick} disabled={ro || !s.rememberRoles.enabled} onChange={(v) => save.mutate({ rememberRoles: { onKick: v } })} /></Row>
      <Row title={t('When someone leaves on their own')} desc={t('Privileged roles are never restored this way.')}><Toggle label={t('Remember on leave')} checked={s.rememberRoles.onLeave} disabled={ro || !s.rememberRoles.enabled} onChange={(v) => save.mutate({ rememberRoles: { onLeave: v } })} /></Row>
      <Row title={t('Remember for')}><select className="field !w-auto" aria-label={t('Remember for')} value={s.rememberRoles.days} disabled={ro || !s.rememberRoles.enabled} onChange={(e) => save.mutate({ rememberRoles: { days: Number(e.target.value) } })}>
        {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} {d === 1 ? t('day') : t('days')}</option>)}</select></Row>
    </section>

    <section aria-label={t('Tell members why')} className="mb-6">
      <H3>{t('Tell members why')}</H3>
      <p className="mb-2 text-sm text-muted">{t('Someone who is kicked, banned or timed out is told the reason you gave. A banned member also gets the way to appeal. Limited to 3 notices per member per day.')}</p>
      <Row title={t('Send a notice')}><Toggle label={t('Send a notice')} checked={s.notices.enabled} disabled={ro} onChange={(v) => save.mutate({ notices: { enabled: v } })} /></Row>
      <Row title={t('Name the moderator')} desc={t('Off by default: members see the reason, not who decided.')}><Toggle label={t('Name the moderator')} checked={s.notices.showModerator} disabled={ro || !s.notices.enabled} onChange={(v) => save.mutate({ notices: { showModerator: v } })} /></Row>
      <Row title={t('Include the appeal link for bans')}><Toggle label={t('Include the appeal link')} checked={s.notices.appealLink} disabled={ro || !s.notices.enabled} onChange={(v) => save.mutate({ notices: { appealLink: v } })} /></Row>
    </section>

    <section aria-label={t('Keep history for')} className="mb-6">
      <H3>{t('Keep history for')}</H3>
      <p className="mb-2 text-sm text-muted">{t('Older entries are deleted automatically. Choosing a shorter period deletes entries beyond it.')}</p>
      <Row title={t('Audit log')}><select className="field !w-auto" aria-label={t('Audit log retention')} value={s.retention.auditDays ?? ''} disabled={ro} onChange={(e) => save.mutate({ retention: { auditDays: num(e.target.value) } })}>
        {AUDIT_CHOICES.map(([l, v]) => <option key={l} value={v ?? ''}>{t(l)}</option>)}</select></Row>
      <Row title={t('Message edit history')}><select className="field !w-auto" aria-label={t('Edit history retention')} value={s.retention.editDays ?? ''} disabled={ro} onChange={(e) => save.mutate({ retention: { editDays: num(e.target.value) } })}>
        {EDIT_CHOICES.map(([l, v]) => <option key={l} value={v ?? ''}>{t(l)}</option>)}</select></Row>
    </section>

    <section aria-label={t('Ban-evasion hints')} className="mb-6">
      <H3>{t('Ban-evasion hints')}</H3>
      <p className="mb-2 text-sm text-muted">{t('When someone joins who resembles a recently banned account (similar name, same avatar, account created right after the ban, same invite) moderators get a hint to look at. Only what the accounts show is compared: no IP addresses and no device fingerprints. A hint never acts on its own.')}</p>
      <Row title={t('Flag possible ban evasion')}><Toggle label={t('Flag possible ban evasion')} checked={s.evasion.enabled} disabled={ro} onChange={(v) => save.mutate({ evasion: { enabled: v } })} /></Row>
      {s.evasion.enabled && <EvasionQueue guildId={guildId} />}
    </section>

    <Wellbeing guildId={guildId} settings={s} canManage={canManage} onSave={(p) => save.mutate(p)} busy={save.isPending} />
  </div>);
}

function EvasionQueue({ guildId }: { guildId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['evasion', guildId], queryFn: () => api.guilds.evasionHints(guildId, 'open'), retry: false });
  const act = useMutation({
    mutationFn: (v: { id: string; status: 'dismissed' | 'confirmed' }) => api.guilds.handleEvasionHint(guildId, v.id, v.status),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['evasion', guildId] }), onError: toastError,
  });
  return (<div className="mt-2" data-testid="evasion-queue">
    {q.isLoading && <Spinner />}
    {q.data && !q.data.length && <Empty icon={<ShieldQuestion size={32} />} title={t('No open hints')} />}
    <ul className="space-y-2">{q.data?.map((h) => (
      <li key={h.id} className="rounded-lg bg-side p-3 text-sm" data-hint={h.id}>
        <div className="flex items-center gap-3">
          {h.user && <Avatar user={h.user} size={32} />}
          <div className="min-w-0 flex-1">
            <div className="text-header"><b>{h.user ? displayName(h.user) : h.userId}</b> <span className="text-muted">{t('may be')}</span> <b>{h.bannedUser ? displayName(h.bannedUser) : h.bannedUserId}</b> <span className="text-muted">({t('banned')})</span></div>
            <div className="text-xs text-muted">{t('Match')} {h.score}/100 ({t('hint from')} {EVASION_MIN_SCORE})</div>
          </div>
          <button className="btn btn-secondary" disabled={act.isPending} onClick={() => act.mutate({ id: h.id, status: 'dismissed' })}>{t('Not them')}</button>
          <button className="btn btn-danger" disabled={act.isPending} onClick={() => act.mutate({ id: h.id, status: 'confirmed' })}>{t('Same person')}</button>
        </div>
        <ul className="ms-11 mt-1 list-disc text-xs text-muted">{h.signals.map((sg) => <li key={sg.kind}>{sg.detail}</li>)}</ul>
      </li>))}</ul>
  </div>);
}

function Wellbeing({ guildId, settings, canManage, onSave, busy }: { guildId: string; settings: ModSettings; canManage: boolean; onSave: (p: Patch) => void; busy: boolean }) {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ['mod-prefs', guildId], queryFn: () => api.guilds.modPrefs(guildId), retry: false });
  const put = useMutation({
    mutationFn: (b: Parameters<typeof api.guilds.putModPrefs>[1]) => api.guilds.putModPrefs(guildId, { tzOffset: -new Date().getTimezoneOffset(), ...b }),
    onSuccess: (p) => { qc.setQueryData(['mod-prefs', guildId], p); void qc.invalidateQueries({ queryKey: ['reports', guildId] }); toast(t('Saved'), 'success'); },
    onError: toastError,
  });
  const p = prefs.data; const quiet = p?.quietStart != null && p?.quietEnd != null;
  const [start, setStart] = useState<string | null>(null); const [end, setEnd] = useState<string | null>(null);
  return (<section aria-label={t('Moderator wellbeing')} className="mb-6" data-testid="wellbeing">
    <H3>{t('Moderator wellbeing')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Reports can be upsetting. Media in the report queue can be blurred until you click it, and report alerts can be silenced at night.')}</p>
    <Row title={t('Blur media in reports by default')} desc={t('The default for every moderator of this server.')}><Toggle label={t('Blur media by default')} checked={settings.wellbeing.blurMedia} disabled={!canManage || busy} onChange={(v) => onSave({ wellbeing: { blurMedia: v } })} /></Row>
    {p && (<>
      <Row title={t('For me')} desc={t('Overrides the server default for you only.')}>
        <select className="field !w-auto" aria-label={t('Blur media for me')} value={p.blurMedia === null ? 'default' : p.blurMedia ? 'on' : 'off'} disabled={put.isPending} onChange={(e) => put.mutate({ blurMedia: e.target.value === 'default' ? null : e.target.value === 'on' })}>
          <option value="default">{t('Server default')} ({p.serverBlurDefault ? t('blurred') : t('shown')})</option><option value="on">{t('Always blur')}</option><option value="off">{t('Never blur')}</option></select></Row>
      <Row title={t('Quiet hours')} desc={t('No report alerts for you during this window. Reports still wait in the queue.')}>
        <Toggle label={t('Quiet hours')} checked={quiet} disabled={put.isPending} onChange={(v) => put.mutate(v ? { quietStart: 22 * 60, quietEnd: 8 * 60 } : { quietStart: null, quietEnd: null })} /></Row>
      {quiet && (<div className="flex flex-wrap items-center gap-2 py-2 text-sm">
        <label>{t('From')} <input className="field !w-auto" type="time" aria-label={t('Quiet from')} value={start ?? minutesToTime(p.quietStart)} onChange={(e) => setStart(e.target.value)} /></label>
        <label>{t('Until')} <input className="field !w-auto" type="time" aria-label={t('Quiet until')} value={end ?? minutesToTime(p.quietEnd)} onChange={(e) => setEnd(e.target.value)} /></label>
        <button className="btn btn-secondary" disabled={put.isPending || (start === null && end === null)} onClick={() => { const a = timeToMinutes(start ?? minutesToTime(p.quietStart)), b = timeToMinutes(end ?? minutesToTime(p.quietEnd)); if (a !== null && b !== null) { put.mutate({ quietStart: a, quietEnd: b }); setStart(null); setEnd(null); } }}>{t('Save')}</button>
      </div>)}
    </>)}
  </section>);
}
