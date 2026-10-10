import { useEffect, useMemo, useRef } from 'react';
import { useRovingTabindex } from '@/lib/hooks';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { api } from '@/lib/api';
import { groupMembers, roleColor, roleIcon } from '@/lib/perms';
import { RoleIcon } from '@/components/ui/RoleIcon';
import { PRESENCE_LABEL } from '@/components/ui/Avatar';
import { t } from '@/i18n';
import { ServerTagBadge, plateClass } from '@/components/ui/Cosmetics';
import { ActivityLine } from '@/components/ui/ActivityLine';
import { Avatar } from '@/components/ui/Avatar';
import { displayName } from '@/lib/format';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { userMenu } from '@/lib/menus';
import { Crown, X } from 'lucide-react';
import { toastError } from '@/stores/ui';
import type { Member, Role } from '@jorcord/shared';

function MemberRow({ m, roles, guildId, ownerId }: { m: Member; roles: Role[]; guildId: string; ownerId: string }) {
  const open = useUI((s) => s.openPopout); const trig = useMenuTrigger(() => userMenu(m.user.id, guildId));
  const u = useData((s) => s.users[m.user.id]) ?? m.user; const p = useData((s) => s.presences[m.user.id]);
  const offline = !p || p === 'offline' || p === 'invisible';
  return (
    <li {...trig}>
      <button onClick={(e) => open({ kind: 'user', userId: m.user.id, guildId, rect: e.currentTarget.getBoundingClientRect() })} className={`touch mx-2 flex w-[calc(100%-16px)] items-center gap-3 rounded px-2 text-start hover:bg-hover md:min-h-[42px] ${plateClass(u.namePlate)}`} style={{ opacity: offline ? 0.45 : 1 }}>
        <Avatar user={u} memberAvatar={m.avatar} size={32} presence ring="rgb(var(--side))" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1"><span className="truncate font-medium" style={{ color: roleColor(m, roles) ?? 'rgb(var(--interactive))' }}>{displayName(u, m)}</span><ServerTagBadge tag={u.serverTag} />{(() => { const ri = roleIcon(m, roles); return ri ? <RoleIcon role={ri} size={14} /> : null; })()}{ownerId === m.user.id && <Crown size={13} className="shrink-0 text-warn" aria-label="Server owner" />}{u.bot && <span className="rounded bg-brand px-1 text-[10px] font-bold uppercase text-white">Bot</span>}{m.pending && <span data-testid="pending-badge" className="rounded bg-active px-1 text-[10px] font-bold uppercase text-muted" title={t('Has not accepted the server rules yet')}>{t('Pending')}</span>}</span>
          <ActivityLine userId={u.id} />
          {(u.customStatus?.text || u.customStatus?.emoji) && <span className="block truncate text-xs text-muted">{u.customStatus.emoji} {u.customStatus.text}</span>}
        </span>
      </button>
    </li>
  );
}

export function MemberList({ guildId }: { guildId: string }) {
  const asideRef = useRef<HTMLElement>(null); useRovingTabindex(asideRef, 'li > button');
  const g = useData((s) => s.guilds[guildId]); const presences = useData((s) => s.presences);
  useEffect(() => {
    if (!g || g.membersLoaded || Object.keys(g.members).length >= g.memberCount) return;
    api.guilds.members(guildId, { limit: 100 }).then((ms) => useData.getState().putMembers(guildId, ms)).catch(() => {});
  }, [guildId]); // eslint-disable-line
  const groups = useMemo(() => (g ? groupMembers(Object.values(g.members), Object.values(g.roles), (id) => presences[id], guildId) : []), [g?.members, g?.roles, presences, guildId]);
  if (!g) return null;
  const roles = Object.values(g.roles);
  return (
    <aside ref={asideRef} aria-label={t('Members')} className="scroller h-full w-60 shrink-0 bg-side pb-4">
      {groups.map((gr) => (
        <section key={gr.id} aria-label={gr.name}>
          <h3 className="px-4 pb-1 pt-6 text-xs font-bold uppercase tracking-wide text-muted">{gr.id === 'online' || gr.id === 'offline' ? t(PRESENCE_LABEL[gr.id] ?? gr.name) : gr.name} — {gr.members.length}</h3>
          <ul>{gr.members.map((m) => <MemberRow key={m.user.id} m={m} roles={roles} guildId={guildId} ownerId={g.guild.ownerId} />)}</ul>
        </section>
      ))}
    </aside>
  );
}

export function DmMemberPanel({ channelId }: { channelId: string }) {
  const c = useData((s) => s.dms[channelId]); const me = useData((s) => s.me); const open = useUI((s) => s.openPopout);
  if (!c) return null;
  const list = [...(c.recipients ?? []), ...(me && !(c.recipients ?? []).some((r) => r.id === me.id) ? [me] : [])];
  return (
    <aside aria-label={t('Members')} className="scroller h-full w-60 shrink-0 bg-side pb-4">
      <h3 className="px-4 pb-1 pt-6 text-xs font-bold uppercase tracking-wide text-muted">{t('Members')} — {list.length}</h3>
      <ul>{list.map((u) => (
        <li key={u.id} className="group relative"><button onClick={(e) => open({ kind: 'user', userId: u.id, rect: e.currentTarget.getBoundingClientRect() })} className="touch mx-2 flex w-[calc(100%-16px)] items-center gap-3 rounded px-2 text-start hover:bg-hover md:min-h-[42px]"><Avatar user={u} size={32} presence /><span className="truncate font-medium text-interactive">{displayName(u)}</span></button>{c.type === 'group_dm' && u.id !== me?.id && c.ownerId === me?.id && <button aria-label={`Remove ${displayName(u)}`} onClick={() => api.channels.removeRecipient(channelId, u.id).catch(toastError)} className="absolute end-3 top-1/2 hidden -translate-y-1/2 text-interactive hover:text-danger group-hover:block"><X size={16} /></button>}</li>
      ))}</ul>
      {c.type === 'group_dm' && <button className="btn btn-secondary mx-4 mt-3 w-[calc(100%-32px)]" onClick={() => useUI.getState().openModal({ kind: 'newDm', addTo: channelId })}>{t('Add Friends')}</button>}
    </aside>
  );
}
