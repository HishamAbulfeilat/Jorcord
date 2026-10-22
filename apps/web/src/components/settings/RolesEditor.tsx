import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Plus, Shield, Trash2 } from 'lucide-react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { roleReorder } from '@/lib/channelOrder';
import { IconPicker } from '@/components/modals/ModalHost';
import { RoleIcon } from '@/components/ui/RoleIcon';
import { t } from '@/i18n';
import { Perm } from '@jorcord/shared';
import type { Role } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { Field, Tabs, Toggle } from '@/components/ui/primitives';
import { SaveBar } from './SettingsLayout';
import { PermGrid } from './PermGrid';
import { canManageRole, effectivePerms, everyoneRole, hexToInt, intToHex, roleTextStyle } from '@/lib/perms';
import { cx, displayName } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';

const SWATCHES = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a'];

export function RolesEditor({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId]); const me = useData((s) => selfMember(s, guildId));
  const roles = useMemo(() => Object.values(g?.roles ?? {}).sort((a, b) => b.position - a.position), [g?.roles]);
  const [selId, setSelId] = useState<string | null>(roles[0]?.id ?? null); const [draft, setDraft] = useState<Role | null>(null); const [tab, setTab] = useState<'display' | 'permissions' | 'members'>('display'); const [busy, setBusy] = useState(false);
  const openModal = useUI((s) => s.openModal);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 6 } }));
  const sel = roles.find((r) => r.id === selId);
  useEffect(() => { setDraft(sel ? { ...sel } : null); }, [selId, sel?.name, sel?.color, sel?.colorSecondary, sel?.permissions, sel?.hoist, sel?.mentionable, sel?.position, sel?.icon]); // eslint-disable-line
  if (!g || !me) return null;
  const rl = Object.values(g.roles); const perms = effectivePerms({ guild: g.guild, roles: rl, member: me });
  const ev = everyoneRole(rl, guildId); const isEveryone = sel?.id === ev?.id;
  const editable = !!sel && (isEveryone ? (perms & Perm.MANAGE_ROLES) !== 0n || (perms & Perm.ADMINISTRATOR) !== 0n : canManageRole(g.guild, rl, me, sel, perms));
  const myTop = Math.max(0, ...rl.filter((r) => me.roles.includes(r.id)).map((r) => r.position));
  const isOwner = g.guild.ownerId === me.user.id;
  const movable = (r: Role) => r.id !== ev?.id && ((perms & Perm.MANAGE_ROLES) !== 0n || (perms & Perm.ADMINISTRATOR) !== 0n) && (isOwner || r.position < myTop);
  const sortable = roles.filter(movable);
  const onDrag = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ordered = roles.filter((r) => r.id !== ev?.id).map((r) => ({ id: r.id, position: r.position }));
    const from = ordered.findIndex((r) => r.id === e.active.id), to = ordered.findIndex((r) => r.id === e.over!.id);
    if (from < 0 || to < 0 || !movable(roles[to]!) && !isOwner) return;
    const changes = roleReorder(ordered, from, to); if (!changes.length) return;
    try { await api.guilds.reorderRoles(guildId, changes); for (const c of changes) { const r = g.roles[c.id]; if (r) useData.getState().apply('ROLE_UPDATE', { ...r, position: c.position }); } } catch (err) { toastError(err); }
  };
  const dirty = !!draft && !!sel && (draft.name !== sel.name || draft.color !== sel.color || (draft.colorSecondary ?? null) !== (sel.colorSecondary ?? null) || draft.hoist !== sel.hoist || draft.mentionable !== sel.mentionable || draft.permissions !== sel.permissions || (draft.icon ?? null) !== (sel.icon ?? null));
  const create = async () => { try { const r = await api.guilds.createRole(guildId, { name: 'new role', permissions: ev?.permissions ?? '0', color: 0 }); useData.getState().apply('ROLE_CREATE', r); setSelId(r.id); } catch (e) { toastError(e); } };
  const save = async () => { if (!draft || !sel) return; setBusy(true); try { const r = await api.guilds.patchRole(guildId, sel.id, { name: draft.name, color: draft.color, colorSecondary: draft.color ? draft.colorSecondary ?? null : null, hoist: draft.hoist, mentionable: draft.mentionable, permissions: draft.permissions, icon: draft.icon ?? null }); useData.getState().apply('ROLE_UPDATE', { ...sel, ...draft, ...r }); toast(t('Role saved'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const move = async (dir: -1 | 1) => {
    if (!sel) return; const idx = roles.findIndex((r) => r.id === sel.id); const other = roles[idx - dir]; if (!other || other.id === ev?.id) return;
    try { await api.guilds.reorderRoles(guildId, [{ id: sel.id, position: other.position }, { id: other.id, position: sel.position }]); useData.getState().apply('ROLE_UPDATE', { ...sel, position: other.position }); useData.getState().apply('ROLE_UPDATE', { ...other, position: sel.position }); } catch (e) { toastError(e); }
  };
  const members = sel ? Object.values(g.members).filter((m) => (isEveryone ? true : m.roles.includes(sel.id))) : [];
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <div className="md:w-56 md:shrink-0">
        <div className="mb-2 flex items-center justify-between"><span className="section-title">Roles — {roles.length}</span><button aria-label={t('Create role')} onClick={create} className="text-interactive hover:text-header"><Plus size={18} /></button></div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDrag}>
          <SortableContext items={sortable.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <ul className="max-h-60 space-y-0.5 overflow-y-auto md:max-h-none" aria-label={t('Roles')}>{roles.map((r) => <RoleRow key={r.id} r={r} selected={selId === r.id} onSelect={() => setSelId(r.id)} draggable={movable(r)} />)}</ul>
          </SortableContext>
        </DndContext>
      </div>
      <div className="min-w-0 flex-1">
        {draft && sel ? (<>
          <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-lg font-bold text-header">Edit Role — {sel.name}</h2>
            <div className="flex gap-1"><button aria-label={t('Move role up')} disabled={!editable || isEveryone} onClick={() => move(1)} className="rounded p-1.5 text-interactive hover:bg-hover disabled:opacity-30"><ArrowUp size={18} /></button><button aria-label={t('Move role down')} disabled={!editable || isEveryone} onClick={() => move(-1)} className="rounded p-1.5 text-interactive hover:bg-hover disabled:opacity-30"><ArrowDown size={18} /></button>
              {!isEveryone && <button aria-label={t('Delete role')} disabled={!editable} onClick={() => openModal({ kind: 'confirm', title: 'Delete Role', body: `Delete the role “${sel.name}”?`, confirmLabel: 'Delete', danger: true, onConfirm: async () => { try { await api.guilds.deleteRole(guildId, sel.id); useData.getState().apply('ROLE_DELETE', { id: sel.id, guildId }); setSelId(roles[0]?.id ?? null); } catch (e) { toastError(e); } } })} className="rounded p-1.5 text-danger hover:bg-hover disabled:opacity-30"><Trash2 size={18} /></button>}</div></div>
          {!editable && <p className="mb-3 rounded bg-warn/15 p-2 text-sm text-warn">{t('You can view this role but cannot edit it. Roles at or above your highest role are read-only.')}</p>}
          <Tabs label={t('Role sections')} value={tab} onChange={setTab} tabs={[{ id: 'display', label: 'Display' }, { id: 'permissions', label: 'Permissions' }, { id: 'members', label: `Members (${members.length})` }]} />
          <fieldset disabled={!editable} className="mt-5 min-w-0 border-0 p-0">
            {tab === 'display' && (<>
              <Field label={t('Role Name *')}><input className="field" value={draft.name} disabled={isEveryone} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
              <div className="mb-4"><span className="label">{t('Role Icon')}</span><IconPicker value={draft.icon ?? null} onChange={(v) => setDraft({ ...draft, icon: v })} size={56} label={t('Icon')} /><span className="mt-1 block text-xs text-muted">{t('Shown next to the names of members with this role as their highest icon.')}</span></div>
              <div className="mb-4"><span className="label">{t('Role Color')}</span><div className="flex flex-wrap items-center gap-2">
                <button className={cx('h-8 w-8 rounded border-2', !draft.color ? 'border-header' : 'border-transparent')} style={{ background: 'rgb(var(--muted))' }} aria-label={t('Default color')} onClick={() => setDraft({ ...draft, color: 0 })} />
                {SWATCHES.map((c) => <button key={c} aria-label={`Color ${c}`} onClick={() => setDraft({ ...draft, color: hexToInt(c) })} className={cx('h-8 w-8 rounded border-2', draft.color === hexToInt(c) ? 'border-header' : 'border-transparent')} style={{ background: c }} />)}
                <input type="color" aria-label={t('Custom color')} value={draft.color ? intToHex(draft.color) : '#99aab5'} onChange={(e) => setDraft({ ...draft, color: hexToInt(e.target.value) })} className="h-8 w-10 cursor-pointer rounded bg-transparent" /></div></div>
              <div className="mb-4"><span className="label">{t('Gradient')}</span><div className="flex flex-wrap items-center gap-3">
                <Toggle label={t('Use a gradient name colour')} checked={draft.colorSecondary != null && !!draft.color} disabled={!draft.color} onChange={(v) => setDraft({ ...draft, colorSecondary: v ? hexToInt('#5865f2') : null })} />
                {draft.colorSecondary != null && !!draft.color && <input type="color" aria-label={t('Second colour')} value={intToHex(draft.colorSecondary)} onChange={(e) => setDraft({ ...draft, colorSecondary: hexToInt(e.target.value) })} className="h-8 w-10 cursor-pointer rounded bg-transparent" />}
                {!!draft.color && <span data-testid="role-gradient-preview" className="font-semibold" style={roleTextStyle(draft)}>{draft.name}</span>}
              </div><span className="mt-1 block text-xs text-muted">{t('Names of members with this role fade from the first colour to the second. Needs a role colour.')}</span></div>
              <div className="flex items-center justify-between border-t border-divider py-3"><div><div className="font-medium text-header">{t('Display role members separately from online members')}</div></div><Toggle label={t('Hoist')} checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} /></div>
              <div className="flex items-center justify-between border-t border-divider py-3"><div><div className="font-medium text-header">Allow anyone to @mention this role</div></div><Toggle label={t('Mentionable')} checked={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} /></div>
            </>)}
            {tab === 'permissions' && <PermGrid bits={draft.permissions} onChange={(b) => setDraft({ ...draft, permissions: b })} />}
          </fieldset>
          {tab === 'members' && <ul className="mt-4">{members.slice(0, 200).map((m) => <li key={m.user.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><Avatar user={m.user} size={32} /><span className="flex-1 truncate font-medium text-header">{displayName(m.user, m)}</span>{!isEveryone && editable && <button className="text-sm text-danger hover:underline" onClick={() => api.guilds.patchMember(guildId, m.user.id, { roles: m.roles.filter((r) => r !== sel.id) }).then((u) => useData.getState().apply('MEMBER_UPDATE', { ...m, ...u, roles: m.roles.filter((r) => r !== sel.id) })).catch(toastError)}>{t('Remove')}</button>}</li>)}{!members.length && <li className="py-6 text-center text-muted">{t('No members have this role.')}</li>}</ul>}
          <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setDraft({ ...sel })} />
        </>) : <p className="text-muted">{t('Select a role to edit.')}</p>}
      </div>
    </div>
  );
}

function RoleRow({ r, selected, onSelect, draggable }: { r: Role; selected: boolean; onSelect: () => void; draggable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: r.id, disabled: !draggable });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx(isDragging && 'relative z-20 opacity-80')} data-role={r.id}>
      <div className={cx('flex w-full items-center gap-1 rounded', selected ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}>
        {draggable ? <button aria-label={t('Drag to reorder {name}', { name: r.name })} className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted active:cursor-grabbing" {...attributes} {...listeners}><GripVertical size={14} /></button> : <span className="w-6 shrink-0" />}
        <button onClick={onSelect} aria-current={selected} className="flex min-w-0 flex-1 items-center gap-2 py-2 pe-2 text-start text-sm font-medium">
          {r.icon ? <RoleIcon role={r} size={16} /> : <Shield size={16} style={{ color: r.color ? intToHex(r.color) : undefined }} />}<span className="truncate">{r.name}</span>
        </button>
      </div>
    </li>
  );
}
