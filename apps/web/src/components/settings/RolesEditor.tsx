import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Shield, Trash2 } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import type { Role } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { Field, Tabs, Toggle } from '@/components/ui/primitives';
import { SaveBar } from './SettingsLayout';
import { PermGrid } from './PermGrid';
import { canManageRole, effectivePerms, everyoneRole, hexToInt, intToHex } from '@/lib/perms';
import { cx, displayName } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';

const SWATCHES = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a'];

export function RolesEditor({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId]); const me = useData((s) => selfMember(s, guildId));
  const roles = useMemo(() => Object.values(g?.roles ?? {}).sort((a, b) => b.position - a.position), [g?.roles]);
  const [selId, setSelId] = useState<string | null>(roles[0]?.id ?? null); const [draft, setDraft] = useState<Role | null>(null); const [tab, setTab] = useState<'display' | 'permissions' | 'members'>('display'); const [busy, setBusy] = useState(false);
  const openModal = useUI((s) => s.openModal);
  const sel = roles.find((r) => r.id === selId);
  useEffect(() => { setDraft(sel ? { ...sel } : null); }, [selId, sel?.name, sel?.color, sel?.permissions, sel?.hoist, sel?.mentionable, sel?.position]); // eslint-disable-line
  if (!g || !me) return null;
  const rl = Object.values(g.roles); const perms = effectivePerms({ guild: g.guild, roles: rl, member: me });
  const ev = everyoneRole(rl, guildId); const isEveryone = sel?.id === ev?.id;
  const editable = !!sel && (isEveryone ? (perms & Perm.MANAGE_ROLES) !== 0n || (perms & Perm.ADMINISTRATOR) !== 0n : canManageRole(g.guild, rl, me, sel, perms));
  const dirty = !!draft && !!sel && (draft.name !== sel.name || draft.color !== sel.color || draft.hoist !== sel.hoist || draft.mentionable !== sel.mentionable || draft.permissions !== sel.permissions);
  const create = async () => { try { const r = await api.guilds.createRole(guildId, { name: 'new role', permissions: ev?.permissions ?? '0', color: 0 }); useData.getState().apply('ROLE_CREATE', r); setSelId(r.id); } catch (e) { toastError(e); } };
  const save = async () => { if (!draft || !sel) return; setBusy(true); try { const r = await api.guilds.patchRole(guildId, sel.id, { name: draft.name, color: draft.color, hoist: draft.hoist, mentionable: draft.mentionable, permissions: draft.permissions }); useData.getState().apply('ROLE_UPDATE', { ...sel, ...draft, ...r }); toast('Role saved', 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const move = async (dir: -1 | 1) => {
    if (!sel) return; const idx = roles.findIndex((r) => r.id === sel.id); const other = roles[idx - dir]; if (!other || other.id === ev?.id) return;
    try { await api.guilds.reorderRoles(guildId, [{ id: sel.id, position: other.position }, { id: other.id, position: sel.position }]); useData.getState().apply('ROLE_UPDATE', { ...sel, position: other.position }); useData.getState().apply('ROLE_UPDATE', { ...other, position: sel.position }); } catch (e) { toastError(e); }
  };
  const members = sel ? Object.values(g.members).filter((m) => (isEveryone ? true : m.roles.includes(sel.id))) : [];
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <div className="md:w-56 md:shrink-0">
        <div className="mb-2 flex items-center justify-between"><span className="section-title">Roles — {roles.length}</span><button aria-label="Create role" onClick={create} className="text-interactive hover:text-header"><Plus size={18} /></button></div>
        <ul className="max-h-60 space-y-0.5 overflow-y-auto md:max-h-none">{roles.map((r) => <li key={r.id}><button onClick={() => setSelId(r.id)} aria-current={selId === r.id} className={cx('flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm font-medium', selId === r.id ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}><Shield size={16} style={{ color: r.color ? intToHex(r.color) : undefined }} /><span className="truncate">{r.name}</span></button></li>)}</ul>
      </div>
      <div className="min-w-0 flex-1">
        {draft && sel ? (<>
          <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-lg font-bold text-header">Edit Role — {sel.name}</h2>
            <div className="flex gap-1"><button aria-label="Move role up" disabled={!editable || isEveryone} onClick={() => move(1)} className="rounded p-1.5 text-interactive hover:bg-hover disabled:opacity-30"><ArrowUp size={18} /></button><button aria-label="Move role down" disabled={!editable || isEveryone} onClick={() => move(-1)} className="rounded p-1.5 text-interactive hover:bg-hover disabled:opacity-30"><ArrowDown size={18} /></button>
              {!isEveryone && <button aria-label="Delete role" disabled={!editable} onClick={() => openModal({ kind: 'confirm', title: 'Delete Role', body: `Delete the role “${sel.name}”?`, confirmLabel: 'Delete', danger: true, onConfirm: async () => { try { await api.guilds.deleteRole(guildId, sel.id); useData.getState().apply('ROLE_DELETE', { id: sel.id, guildId }); setSelId(roles[0]?.id ?? null); } catch (e) { toastError(e); } } })} className="rounded p-1.5 text-danger hover:bg-hover disabled:opacity-30"><Trash2 size={18} /></button>}</div></div>
          {!editable && <p className="mb-3 rounded bg-warn/15 p-2 text-sm text-warn">You can view this role but cannot edit it. Roles at or above your highest role are read-only.</p>}
          <Tabs label="Role sections" value={tab} onChange={setTab} tabs={[{ id: 'display', label: 'Display' }, { id: 'permissions', label: 'Permissions' }, { id: 'members', label: `Members (${members.length})` }]} />
          <fieldset disabled={!editable} className="mt-5 min-w-0 border-0 p-0">
            {tab === 'display' && (<>
              <Field label="Role Name *"><input className="field" value={draft.name} disabled={isEveryone} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
              <div className="mb-4"><span className="label">Role Color</span><div className="flex flex-wrap items-center gap-2">
                <button className={cx('h-8 w-8 rounded border-2', !draft.color ? 'border-header' : 'border-transparent')} style={{ background: 'rgb(var(--muted))' }} aria-label="Default color" onClick={() => setDraft({ ...draft, color: 0 })} />
                {SWATCHES.map((c) => <button key={c} aria-label={`Color ${c}`} onClick={() => setDraft({ ...draft, color: hexToInt(c) })} className={cx('h-8 w-8 rounded border-2', draft.color === hexToInt(c) ? 'border-header' : 'border-transparent')} style={{ background: c }} />)}
                <input type="color" aria-label="Custom color" value={draft.color ? intToHex(draft.color) : '#99aab5'} onChange={(e) => setDraft({ ...draft, color: hexToInt(e.target.value) })} className="h-8 w-10 cursor-pointer rounded bg-transparent" /></div></div>
              <div className="flex items-center justify-between border-t border-divider py-3"><div><div className="font-medium text-header">Display role members separately from online members</div></div><Toggle label="Hoist" checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} /></div>
              <div className="flex items-center justify-between border-t border-divider py-3"><div><div className="font-medium text-header">Allow anyone to @mention this role</div></div><Toggle label="Mentionable" checked={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} /></div>
            </>)}
            {tab === 'permissions' && <PermGrid bits={draft.permissions} onChange={(b) => setDraft({ ...draft, permissions: b })} />}
          </fieldset>
          {tab === 'members' && <ul className="mt-4">{members.slice(0, 200).map((m) => <li key={m.user.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><Avatar user={m.user} size={32} /><span className="flex-1 truncate font-medium text-header">{displayName(m.user, m)}</span>{!isEveryone && editable && <button className="text-sm text-danger hover:underline" onClick={() => api.guilds.patchMember(guildId, m.user.id, { roles: m.roles.filter((r) => r !== sel.id) }).then((u) => useData.getState().apply('MEMBER_UPDATE', { ...m, ...u, roles: m.roles.filter((r) => r !== sel.id) })).catch(toastError)}>Remove</button>}</li>)}{!members.length && <li className="py-6 text-center text-muted">No members have this role.</li>}</ul>}
          <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setDraft({ ...sel })} />
        </>) : <p className="text-muted">Select a role to edit.</p>}
      </div>
    </div>
  );
}
