import { useState } from 'react';
import { MOD_LIMITS, type BulkModerationResult, type PruneResult } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError, useUI } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Field } from '@/components/ui/primitives';
import { blankBulk as BLANK, bulkRequest, type BulkForm } from '@/lib/modtools';
import { t } from '@/i18n';

/** Server Settings > Mod Tools: bulk ban/kick, prune inactive members and export the moderation log. Every action previews first. */
export function ModToolsTab({ guildId, canKick, canBan, canAudit }: { guildId: string; canKick: boolean; canBan: boolean; canAudit: boolean }) {
  return (<div data-testid="mod-tools">
    <H1>{t('Mod Tools')}</H1>
    {(canKick || canBan) && <Bulk guildId={guildId} canKick={canKick} canBan={canBan} />}
    {canKick && <Prune guildId={guildId} />}
    {canAudit && <Export guildId={guildId} />}
  </div>);
}

function Bulk({ guildId, canKick, canBan }: { guildId: string; canKick: boolean; canBan: boolean }) {
  const [f, setF] = useState<BulkForm>(BLANK); const [action, setAction] = useState<'ban' | 'kick'>(canBan ? 'ban' : 'kick'); const [reason, setReason] = useState('');
  const [prev, setPrev] = useState<BulkModerationResult | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<BulkForm>) => { setF((x) => ({ ...x, ...p })); setPrev(null); };
  const run = async (dryRun: boolean) => {
    const req = bulkRequest(f); if ('error' in req) return setErr(req.error); setErr(null); setBusy(true);
    try { const r = await api.guilds.bulkModeration(guildId, { action, ...req, reason: reason.trim() || null, dryRun }); setPrev(r); if (!dryRun) toast(`${r.affected} ${action === 'ban' ? t('banned') : t('kicked')}`, 'success'); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const confirm = () => useUI.getState().openModal({ kind: 'confirm', title: action === 'ban' ? t('Ban these members?') : t('Kick these members?'), body: `${prev?.affected ?? 0} ${t('members will be removed.')}`, confirmLabel: action === 'ban' ? t('Ban') : t('Kick'), danger: true, onConfirm: () => run(false) });
  return (<section className="mb-8 rounded-lg bg-side p-4" aria-label={t('Bulk ban or kick')}>
    <H3>{t('Bulk ban / kick')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Paste user ids (one per line or comma separated), or pick a filter such as "joined within 30 minutes with no roles". You always see who would be affected first. Members above you are skipped.')}</p>
    <Field label={t('User ids')}><textarea className="field h-20 font-mono text-sm" aria-label={t('User ids')} value={f.ids} onChange={(e) => set({ ids: e.target.value })} placeholder={'123456789\n987654321'} /></Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('Joined within (minutes)')}><input className="field" inputMode="numeric" aria-label={t('Joined within (minutes)')} value={f.joinedMinutes} onChange={(e) => set({ joinedMinutes: e.target.value })} /></Field>
      <Field label={t('Account younger than (days)')}><input className="field" inputMode="numeric" aria-label={t('Account younger than (days)')} value={f.youngDays} onChange={(e) => set({ youngDays: e.target.value })} /></Field>
    </div>
    <div className="mb-3 flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={f.noRoles} onChange={(e) => set({ noRoles: e.target.checked })} />{t('Has no roles')}</label><label className="flex items-center gap-2"><input type="checkbox" checked={f.raidFlagged} onChange={(e) => set({ raidFlagged: e.target.checked })} />{t('Flagged as raid joiners')}</label></div>
    <div className="mb-3 flex flex-wrap gap-3"><Field label={t('Action')}><select className="field !w-auto" aria-label={t('Action')} value={action} onChange={(e) => { setAction(e.target.value as 'ban' | 'kick'); setPrev(null); }}>{canBan && <option value="ban">{t('Ban')}</option>}{canKick && <option value="kick">{t('Kick')}</option>}</select></Field>
      <div className="min-w-[200px] flex-1"><Field label={t('Reason (optional)')}><input className="field" maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div></div>
    {err && <p role="alert" className="mb-2 text-sm text-danger">{t(err)}</p>}
    <div className="flex gap-2"><button className="btn btn-secondary" disabled={busy} onClick={() => void run(true)}>{t('Preview')}</button>
      <button className="btn btn-danger" disabled={busy || !prev || !prev.dryRun || prev.affected === 0} onClick={confirm}>{action === 'ban' ? t('Ban') : t('Kick')} {prev?.dryRun ? prev.affected : ''}</button></div>
    {prev && <div className="mt-3 text-sm" role="status" data-testid="bulk-result"><p className="text-header">{prev.dryRun ? `${t('Would affect')} ${prev.affected} ${t('of')} ${prev.matched} ${t('matched')}` : `${t('Done')}: ${prev.affected} ${t('of')} ${prev.matched}`}</p>
      {prev.users.length > 0 && <p className="text-muted">{prev.users.slice(0, 20).map((u) => u.username).join(', ')}{prev.users.length > 20 ? '…' : ''}</p>}
      {prev.skipped.length > 0 && <details><summary className="cursor-pointer text-muted">{prev.skipped.length} {t('skipped')}</summary><ul>{prev.skipped.map((s) => <li key={s.userId} className="text-xs text-muted">{s.userId}: {t(s.reason)}</li>)}</ul></details>}</div>}
    <p className="mt-2 text-xs text-muted">{t('Up to')} {MOD_LIMITS.bulkMax} {t('members per run.')}</p>
  </section>);
}

function Prune({ guildId }: { guildId: string }) {
  const roles = useData((s) => s.guilds[guildId]?.roles); const [days, setDays] = useState(30); const [incl, setIncl] = useState<string[]>([]);
  const [prev, setPrev] = useState<PruneResult | null>(null); const [busy, setBusy] = useState(false);
  const list = Object.values(roles ?? {}).filter((r) => r.id !== guildId);
  const run = async (dryRun: boolean) => { setBusy(true); try { const r = await api.guilds.prune(guildId, { days, includeRoles: incl, dryRun }); setPrev(r); if (!dryRun) toast(`${r.removed} ${t('members removed')}`, 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const confirm = () => useUI.getState().openModal({ kind: 'confirm', title: t('Prune inactive members?'), body: `${prev?.count ?? 0} ${t('members will be kicked. They can rejoin with an invite.')}`, confirmLabel: t('Prune'), danger: true, onConfirm: () => run(false) });
  return (<section className="mb-8 rounded-lg bg-side p-4" aria-label={t('Prune members')}>
    <H3>{t('Prune inactive members')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Removes members who joined more than this many days ago, have not posted since, and have no role. Pick roles below to include their holders too. Bots and members above you are never pruned.')}</p>
    <Field label={t('Days of inactivity')}><input className="field !w-24" type="number" min={1} max={MOD_LIMITS.pruneMaxDays} aria-label={t('Days of inactivity')} value={days} onChange={(e) => { setDays(Math.min(MOD_LIMITS.pruneMaxDays, Math.max(1, Number(e.target.value) || 1))); setPrev(null); }} /></Field>
    {list.length > 0 && <Field label={t('Also include members with these roles')}><select multiple className="field h-24" aria-label={t('Include roles')} value={incl} onChange={(e) => { setIncl([...e.target.selectedOptions].map((o) => o.value)); setPrev(null); }}>{list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
    <div className="flex gap-2"><button className="btn btn-secondary" disabled={busy} onClick={() => void run(true)}>{t('Count members')}</button><button className="btn btn-danger" disabled={busy || !prev?.dryRun || prev.count === 0} onClick={confirm}>{t('Prune')} {prev?.dryRun ? prev.count : ''}</button></div>
    {prev && <p className="mt-3 text-sm text-header" role="status" data-testid="prune-result">{prev.dryRun ? `${prev.count} ${t('members would be pruned')}` : `${prev.removed} ${t('removed')}${prev.remaining ? `, ${prev.remaining} ${t('left: run again')}` : ''}`}</p>}
  </section>);
}

function Export({ guildId }: { guildId: string }) {
  const [all, setAll] = useState(false); const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try { const csv = await api.guilds.modLogCsv(guildId, all); const url = URL.createObjectURL(new Blob([typeof csv === 'string' ? csv : ''], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `mod-log-${guildId}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(t('Moderation log exported'), 'success'); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (<section className="rounded-lg bg-side p-4" aria-label={t('Export moderation log')}>
    <H3>{t('Export moderation log')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Download bans, kicks, timeouts, warnings, notes, AutoMod hits and more as a CSV spreadsheet (up to 10,000 entries).')}</p>
    <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />{t('Include every audit log entry, not just moderation')}</label>
    <button className="btn btn-primary" disabled={busy} onClick={() => void download()}>{t('Download CSV')}</button>
  </section>);
}
