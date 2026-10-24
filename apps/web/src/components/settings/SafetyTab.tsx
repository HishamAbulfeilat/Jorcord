import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuildSafety, Id, SafetyPreset } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Row, Spinner, Toggle } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import { ImpersonationSection, LinkListsSection, MemberDmsSection } from './SafetyTrustPanels';
import { t } from '@/i18n';
import { api3c } from '@/lib/api3c';
import { useData } from '@/stores/data';

const LEVELS = [
  { v: 0, name: 'None', desc: 'Unrestricted.' },
  { v: 1, name: 'Low', desc: 'Must have a verified email address.' },
  { v: 2, name: 'Medium', desc: 'Also registered on Jorcord for more than 5 minutes.' },
  { v: 3, name: 'High', desc: 'Also a member of this server for more than 10 minutes.' },
  { v: 4, name: 'Highest', desc: 'Verified email and an account older than 7 days.' },
];
const FILTERS = [{ v: 0, name: "Don't blur", desc: 'No media is blurred.' }, { v: 1, name: 'Members without roles', desc: 'Images and videos from members without a role arrive blurred.' }, { v: 2, name: 'Everyone', desc: 'All images and videos arrive blurred until clicked.' }];
const PRESETS: { id: SafetyPreset; name: string; desc: string }[] = [
  { id: 'basic', name: 'Basic', desc: 'Verified email required.' }, { id: 'recommended', name: 'Recommended', desc: 'Verification, media blur for new members and raid protection.' }, { id: 'strict', name: 'Strict', desc: 'Everything on, for communities under attack.' },
];
const CHECK_LABEL: Record<string, string> = { verification: 'Verification level is Medium or higher', explicit_filter: 'Explicit media filter is on', raid_protection: 'Raid protection is on', default_notifications: 'Default notifications are @mentions only', screening: 'Membership screening is on' };

function Radio<T extends number | string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { v: T; name: string; desc: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="mb-2 space-y-1.5">
      {options.map((o) => (
        <label key={String(o.v)} className={cx('flex cursor-pointer items-start gap-3 rounded-lg bg-side p-3 hover:bg-hover', value === o.v && 'ring-2 ring-brand')}>
          <input type="radio" name={label} className="mt-1 accent-brand" disabled={disabled} checked={value === o.v} aria-label={o.name} onChange={() => onChange(o.v)} />
          <span><span className="block font-semibold text-header">{t(o.name)}</span><span className="block text-sm text-muted">{t(o.desc)}</span></span>
        </label>
      ))}
    </div>
  );
}

/** Server Settings > Safety Setup (MANAGE_GUILD). Everything here is enforced by the server. */
export function SafetyTab({ guildId }: { guildId: Id }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['safety', guildId], queryFn: () => api.guilds.safety(guildId) });
  const s = q.data;
  const run = (p: Promise<GuildSafety>, ok?: string) => p.then((n) => { qc.setQueryData(['safety', guildId], n); if (ok) toast(ok, 'success'); }).catch(toastError);
  const patch = (b: Parameters<typeof api.guilds.patchSafety>[1]) => run(api.guilds.patchSafety(guildId, b));
  if (!s) return <><H1>{t('Safety Setup')}</H1><Spinner /></>;
  const rp = s.raidProtection; const paused = s.invitesPausedUntil;
  return (<div data-testid="safety-tab">
    <H1>{t('Safety Setup')}</H1>
    <div className="mb-4 rounded-lg bg-side p-3">
      <div className="mb-2 flex items-center justify-between"><span className="font-semibold text-header">{t('Safety score')}</span><span data-testid="safety-score" className="text-header">{s.score}%</span></div>
      <div className="h-2 overflow-hidden rounded bg-[rgb(var(--active))]"><div className="h-full bg-success transition-all" style={{ width: `${s.score}%` }} /></div>
      <ul className="mt-3 space-y-1 text-sm">{s.checklist.map((c) => <li key={c.id} className={c.done ? 'text-success' : 'text-muted'}>{c.done ? '✓' : '○'} {t(CHECK_LABEL[c.id] ?? c.id)}</li>)}</ul>
    </div>
    <H3>{t('Quick setup')}</H3>
    <div className="mb-2 grid gap-2 sm:grid-cols-3">{PRESETS.map((p) => <button key={p.id} className="rounded-lg bg-side p-3 text-start hover:bg-hover" onClick={() => void run(api.guilds.safetyPreset(guildId, p.id), t('Safety preset applied'))}><span className="block font-semibold text-header">{t(p.name)}</span><span className="block text-xs text-muted">{t(p.desc)}</span></button>)}</div>
    <H3>{t('Verification level')}</H3>
    <Radio label={t('Verification level')} value={s.verificationLevel} options={LEVELS} onChange={(v) => void patch({ verificationLevel: v })} />
    <p className="mb-2 text-xs text-muted">{t('Members with a role, bots and moderators are exempt. Applies to messages, reactions and new threads.')}</p>
    <H3>{t('Explicit media filter')}</H3>
    <Radio label={t('Explicit media filter')} value={s.explicitFilter} options={FILTERS} onChange={(v) => void patch({ explicitFilter: v })} />
    <H3>{t('Default notification settings')}</H3>
    <Radio label={t('Default notification settings')} value={s.defaultNotifications} options={[{ v: 'all' as const, name: 'All messages', desc: 'Members are notified for every message unless they choose otherwise.' }, { v: 'mentions' as const, name: 'Only @mentions', desc: 'Recommended for larger servers.' }]} onChange={(v) => void patch({ defaultNotifications: v })} />
    <H3>{t('Raid protection')}</H3>
    <Row title={t('Detect join raids')} desc={t('Pause invites automatically when many accounts join in a short time.')}><Toggle label={t('Detect join raids')} checked={rp.enabled} onChange={(v) => void patch({ raidProtection: { enabled: v } })} /></Row>
    {rp.enabled && <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-side p-3 text-sm text-header">
      <label className="flex items-center gap-2">{t('Joins')}<input aria-label={t('Raid joins')} type="number" min={3} max={100} className="field !w-20" defaultValue={rp.maxJoins} onBlur={(e) => void patch({ raidProtection: { maxJoins: Number(e.target.value) } })} /></label>
      <label className="flex items-center gap-2">{t('within seconds')}<input aria-label={t('Raid window seconds')} type="number" min={10} max={600} className="field !w-24" defaultValue={rp.windowSeconds} onBlur={(e) => void patch({ raidProtection: { windowSeconds: Number(e.target.value) } })} /></label>
      <label className="flex items-center gap-2">{t('pause for minutes')}<input aria-label={t('Raid lock minutes')} type="number" min={5} max={1440} className="field !w-24" defaultValue={rp.lockMinutes} onBlur={(e) => void patch({ raidProtection: { lockMinutes: Number(e.target.value) } })} /></label>
    </div>}
    <Row title={t('Pause invites')} desc={paused ? `${t('Invites are paused until')} ${new Date(paused).toLocaleString()}` : t('Stop anyone from joining through invites or Discovery for 24 hours.')}><Toggle label={t('Pause invites')} checked={!!paused} onChange={(v) => void patch({ pauseInvites: v })} /></Row>
    <SafetyAlerts guildId={guildId} s={s} run={run} />
    <MemberDmsSection s={s} patch={(b) => void patch(b)} />
    <LinkListsSection s={s} patch={(b) => void patch(b)} />
    <ImpersonationSection guildId={guildId} s={s} patch={(b) => void patch(b)} />
  </div>);
}

/** Raid and mass-DM detections post to a moderator channel, with Lock invites / Kick new members / Dismiss buttons. */
function SafetyAlerts({ guildId, s, run }: { guildId: Id; s: GuildSafety; run: (p: Promise<GuildSafety>, ok?: string) => void }) {
  const chans = useData((st) => st.guilds[guildId]?.channels ?? {});
  const text = Object.values(chans).filter((c) => c.type === 'text' || c.type === 'announcement').sort((a, b) => a.position - b.position);
  const a = s.safetyAlerts ?? { channelId: null, raid: true, massDm: true };
  return (<div data-testid="safety-alerts">
    <H3>{t('Safety alerts')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Post a message with one-click actions when a raid or mass-DM spam is detected.')}</p>
    <label className="mb-2 block"><span className="label">{t('Alert channel')}</span>
      <select className="field" aria-label={t('Alert channel')} value={a.channelId ?? ''} onChange={(e) => run(api3c.patchSafetyAlerts(guildId, { channelId: e.target.value || null }))}><option value="">{t('Off')}</option>{text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></label>
    <Row title={t('Raid alerts')}><Toggle label={t('Raid alerts')} checked={a.raid} disabled={!a.channelId} onChange={(v) => run(api3c.patchSafetyAlerts(guildId, { raid: v }))} /></Row>
    <Row title={t('Mass-DM spam alerts')}><Toggle label={t('Mass-DM spam alerts')} checked={a.massDm} disabled={!a.channelId} onChange={(v) => run(api3c.patchSafetyAlerts(guildId, { massDm: v }))} /></Row>
  </div>);
}
