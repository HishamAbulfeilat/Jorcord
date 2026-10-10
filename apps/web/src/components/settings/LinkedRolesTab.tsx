import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import { CONNECTION_PROVIDERS, LINKED_ROLE_LIMITS, type LinkedRoleView, type LinkedOp } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1 } from './SettingsLayout';
import { Field, Spinner } from '@/components/ui/primitives';
import { CRITERION_TYPES, blankDraft, describeCriterion, draftsToCriteria, progressText, type CriterionDraft } from '@/lib/linkedRoles';
import { intToHex } from '@/lib/perms';
import { t } from '@/i18n';

/**
 * Server Settings > Linked Roles. Everyone sees the roles they can earn and how close they are; members who manage roles define the criteria.
 * The server grants and removes these roles itself, so nobody can hand one out by hand.
 */
export function LinkedRolesTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['linked-roles', guildId], queryFn: () => api.guilds.linkedRoles(guildId) });
  const apps = useQuery({ queryKey: ['linked-role-apps', guildId], queryFn: () => api.guilds.linkedRoleApps(guildId), enabled: canManage });
  const roles = useData((s) => s.guilds[guildId]?.roles);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const refetch = () => qc.invalidateQueries({ queryKey: ['linked-roles', guildId] });
  const act = async (p: Promise<unknown>, ok?: string) => { setBusy(true); try { await p; await refetch(); if (ok) toast(ok, 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const rows = q.data ?? [];
  return (<div data-testid="linked-roles-tab">
    <H1>{t('Linked Roles')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Earn roles automatically by meeting requirements. Roles are granted and removed by the server as things change; they cannot be handed out by hand.')}</p>
    <div className="mb-4 flex flex-wrap gap-2">
      <button className="btn btn-secondary" disabled={busy} onClick={() => void act(api.guilds.refreshLinkedRoles(guildId), t('Checked again'))}><RefreshCw size={14} className="me-1 inline" />{t('Check again')}</button>
      {canManage && <button className="btn btn-primary" onClick={() => setEditing('new')}>{t('Link a Role')}</button>}
      {canManage && rows.length > 0 && <button className="btn btn-secondary" disabled={busy} onClick={() => void act(api.guilds.syncLinkedRoles(guildId).then((r) => toast(`${r.checked} ${t('members checked')}, ${r.changed} ${t('updated')}`, 'success')))}>{t('Re-check all members')}</button>}
    </div>
    {q.isLoading && <Spinner />}
    {!q.isLoading && rows.length === 0 && editing !== 'new' && <p className="text-sm text-muted">{canManage ? t('No linked roles yet. Link a role to give it automatically to members who meet the requirements.') : t('This server has no linked roles.')}</p>}
    {editing === 'new' && <Editor guildId={guildId} existing={rows} apps={apps.data ?? []} roles={Object.values(roles ?? {})} onDone={() => { setEditing(null); void refetch(); }} />}
    <ul className="space-y-3">{rows.map((r) => (
      <li key={r.id} data-testid="linked-role" className="rounded-lg border border-divider bg-side p-4">
        {editing === r.id ? <Editor guildId={guildId} view={r} existing={rows} apps={apps.data ?? []} roles={Object.values(roles ?? {})} onDone={() => { setEditing(null); void refetch(); }} /> : <>
          <div className="mb-1 flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: r.role?.color ? intToHex(r.role.color) : 'rgb(var(--muted))' }} /><span className="font-bold text-header">{r.role?.name ?? t('Deleted role')}</span>
            {r.granted && <span className="rounded bg-success/20 px-1.5 text-xs font-semibold text-success">{t('You have this role')}</span>}<span className="ms-auto text-xs text-muted">{r.holders} {r.holders === 1 ? t('member') : t('members')}</span></div>
          {r.description && <p className="mb-2 text-sm text-muted">{r.description}</p>}
          <ul className="space-y-1 text-sm">{r.criteria.map((c, i) => { const p = r.progress[i]; const txt = p ? progressText(c, p) : null; return (
            <li key={i} className="flex items-start gap-2">{p?.met ? <Check size={14} aria-label={t('Met')} className="mt-1 shrink-0 text-success" /> : <X size={14} aria-label={t('Not met')} className="mt-1 shrink-0 text-muted" />}
              <span className="text-header">{t(describeCriterion(c, apps.data ?? []))}{txt && <span className="ms-2 text-xs text-muted">{t(txt)}</span>}</span></li>); })}</ul>
          {canManage && <div className="mt-3 flex gap-2"><button className="btn btn-secondary" onClick={() => setEditing(r.id)}>{t('Edit')}</button><button aria-label={`${t('Unlink')} ${r.role?.name ?? ''}`} className="btn btn-secondary text-danger" onClick={() => void act(api.guilds.deleteLinkedRole(guildId, r.id), t('Role unlinked'))}><Trash2 size={14} className="me-1 inline" />{t('Unlink')}</button></div>}
        </>}
      </li>))}
    </ul>
  </div>);
}

function Editor({ guildId, view, existing, apps, roles, onDone }: { guildId: string; view?: LinkedRoleView; existing: LinkedRoleView[]; apps: import('@jorcord/shared').RoleMetadataApp[]; roles: import('@jorcord/shared').Role[]; onDone: () => void }) {
  const taken = new Set(existing.map((e) => e.roleId));
  const choices = roles.filter((r) => r.id !== guildId && (view ? false : !taken.has(r.id))).sort((a, b) => b.position - a.position);
  const [roleId, setRoleId] = useState(view?.roleId ?? ''); const [desc, setDesc] = useState(view?.description ?? '');
  const [drafts, setDrafts] = useState<CriterionDraft[]>(view ? view.criteria.map((c): CriterionDraft => ({ ...blankDraft(c.type), value: 'value' in c ? String(c.value) : '', provider: c.type === 'connection' ? c.provider ?? '' : '', appId: c.type === 'app_metadata' ? c.appId : '', key: c.type === 'app_metadata' ? c.key : '', op: c.type === 'app_metadata' ? c.op : '>=' })) : [blankDraft()]);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, p: Partial<CriterionDraft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const save = async () => {
    const r = draftsToCriteria(drafts, apps); if ('error' in r) return setErr(r.error);
    if (!view && !roleId) return setErr('Pick a role'); setErr(null);
    try { if (view) await api.guilds.patchLinkedRole(guildId, view.id, { description: desc.trim() || null, criteria: r.criteria }); else await api.guilds.createLinkedRole(guildId, { roleId, description: desc.trim() || null, criteria: r.criteria }); onDone(); } catch (e) { toastError(e); }
  };
  return (<div className="mb-4 rounded-lg bg-side p-4" data-testid="linked-role-editor">
    {!view && <Field label={t('Role')}><select className="field" aria-label={t('Role')} value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">{t('Select a role')}</option>{choices.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
    <Field label={t('Description (optional)')}><input className="field" maxLength={200} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
    <fieldset className="mb-3"><legend className="label">{t('Requirements (all must be met)')}</legend>
      {drafts.map((d, i) => { const fields = apps.find((a) => a.appId === d.appId)?.fields ?? []; const f = fields.find((x) => x.key === d.key); return (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2" data-testid="criterion-row">
          <select className="field !w-auto" aria-label={t('Requirement type')} value={d.type} onChange={(e) => setDrafts((ds) => ds.map((x, j) => (j === i ? blankDraft(e.target.value as CriterionDraft['type']) : x)))}>{CRITERION_TYPES.filter((c) => c.id !== 'app_metadata' || apps.length > 0 || d.type === 'app_metadata').map((c) => <option key={c.id} value={c.id}>{t(c.label)}</option>)}</select>
          {(d.type === 'account_age_days' || d.type === 'join_age_days' || d.type === 'message_count') && <input className="field !w-24" inputMode="numeric" aria-label={t('Amount')} value={d.value} onChange={(e) => set(i, { value: e.target.value })} />}
          {d.type === 'connection' && <select className="field !w-auto" aria-label={t('Provider')} value={d.provider} onChange={(e) => set(i, { provider: e.target.value })}><option value="">{t('Any provider')}</option>{CONNECTION_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          {d.type === 'app_metadata' && <>
            <select className="field !w-auto" aria-label={t('App')} value={d.appId} onChange={(e) => set(i, { appId: e.target.value, key: '' })}><option value="">{t('App')}</option>{apps.map((a) => <option key={a.appId} value={a.appId}>{a.name}</option>)}</select>
            <select className="field !w-auto" aria-label={t('Field')} value={d.key} onChange={(e) => set(i, { key: e.target.value })}><option value="">{t('Field')}</option>{fields.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select>
            {f?.type === 'boolean' ? <select className="field !w-auto" aria-label={t('Value')} value={d.value === 'false' ? 'false' : 'true'} onChange={(e) => set(i, { value: e.target.value, op: '=' })}><option value="true">{t('Yes')}</option><option value="false">{t('No')}</option></select>
              : <><select className="field !w-auto" aria-label={t('Comparison')} value={d.op} onChange={(e) => set(i, { op: e.target.value as LinkedOp })}><option value=">=">≥</option><option value="<=">≤</option><option value="=">=</option><option value="!=">≠</option></select><input className="field !w-24" inputMode="numeric" aria-label={t('Amount')} value={d.value} onChange={(e) => set(i, { value: e.target.value })} /></>}</>}
          {drafts.length > 1 && <button aria-label={t('Remove requirement')} className="p-1 text-danger" onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}><X size={16} /></button>}
        </div>); })}
      {drafts.length < LINKED_ROLE_LIMITS.criteria && <button className="btn btn-secondary" onClick={() => setDrafts((ds) => [...ds, blankDraft('join_age_days')])}>{t('Add requirement')}</button>}
    </fieldset>
    {err && <p role="alert" className="mb-2 text-sm text-danger">{t(err)}</p>}
    <div className="flex gap-2"><button className="btn btn-primary" onClick={() => void save()}>{t('Save')}</button><button className="btn btn-secondary" onClick={onDone}>{t('Cancel')}</button></div>
  </div>);
}
