import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, ShieldAlert, MessageSquare, UserPlus, UserMinus, Settings } from 'lucide-react';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { Perm } from '@jorcord/shared';
import { useUI, toast, toastError } from '@/stores/ui';
import { Avatar, PRESENCE_LABEL } from '@/components/ui/Avatar';
import { cx, displayName, fileUrl, idColor, fmtStamp } from '@/lib/format';
import { intToHex, effectivePerms } from '@/lib/perms';
import { openDmWith, userMenu } from '@/lib/menus';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { Markdown } from '@/components/chat/Markdown';
import { RoleIcon } from '@/components/ui/RoleIcon';
import { headerBackground, bodyBackground, isHexPair, isHex } from '@/lib/profileTheme';
import { useStreamer } from '@/lib/streamer';
import { t } from '@/i18n';
import { ProfileEffect, ServerTagBadge, plateClass } from '@/components/ui/Cosmetics';
import { ActivityCards } from '@/components/ui/ActivityLine';

/** Private note about a user: saved on blur, visible only to me. */
function NoteBox({ userId, note }: { userId: string; note: string | null | undefined }) {
  const [v, setV] = useState(note ?? ''); const [saved, setSaved] = useState(note ?? '');
  useEffect(() => { setV(note ?? ''); setSaved(note ?? ''); }, [note]);
  const save = () => { if (v === saved) return; setSaved(v); api.users.setNote(userId, v).catch((e) => { setSaved(note ?? ''); toastError(e); }); };
  return (
    <div className="mt-3">
      <label htmlFor={`note-${userId}`} className="mb-1 block text-xs font-bold uppercase text-header">{t('Note')} <span className="font-normal normal-case text-muted">({t('only visible to you')})</span></label>
      <textarea id={`note-${userId}`} data-testid="user-note" value={v} maxLength={256} rows={v.length > 40 ? 3 : 1} onChange={(e) => setV(e.target.value)} onBlur={save} placeholder={t('Click to add a note')}
        className="w-full resize-none rounded bg-transparent p-1 text-xs text-normal outline-none placeholder:text-muted hover:bg-black/10 focus:bg-black/20" />
    </div>
  );
}

/** Does the viewer hold any moderation permission in this server? (The server re-checks everything.) */
function modPerms(guildId: string): boolean {
  const s = useData.getState(); const g = s.guilds[guildId]; const me = selfMember(s, guildId); if (!g || !me) return false;
  const p = effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me });
  return (p & (Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD | Perm.ADMINISTRATOR)) !== 0n;
}
export function ProfileCard({ userId, guildId, compact }: { userId: string; guildId?: string; compact?: boolean }) {
  const cached = useData((s) => s.users[userId]); const presence = useData((s) => s.presences[userId]);
  const member = useData((s) => (guildId ? s.guilds[guildId]?.members[userId] : undefined));
  const roles = useData((s) => (guildId ? s.guilds[guildId]?.roles : undefined));
  const me = useData((s) => s.me); const rel = useData((s) => s.relationships[userId]?.type);
  const openSettings = useUI((s) => s.openSettings); const closeAll = () => { const s = useUI.getState(); s.closePopout(); s.closeModal(); };
  const q = useQuery({ queryKey: ['user', userId], queryFn: () => api.users.get(userId), staleTime: 60_000, retry: false });
  const u = { ...cached, ...q.data } as NonNullable<typeof cached>;
  const trig = useMenuTrigger(() => userMenu(userId, guildId));
  if (!u?.id) return <div className="p-6 text-center text-muted">{t('Loading…')}</div>;
  const isMe = me?.id === userId;
  const canModView = !!guildId && !isMe && !!member && modPerms(guildId);
  const banner = fileUrl(u.banner); const accent = u.accentColor ?? idColor(u.id);
  const myRoles = member && roles ? member.roles.map((r) => roles[r]).filter((r) => r && r.id !== guildId).sort((a, b) => b.position - a.position) : [];
  return (
    <div className="overflow-hidden rounded-lg bg-[rgb(var(--modal-alt))]" style={{ background: bodyBackground(u) }} data-theme-pair={isHexPair(u.themeColors) ? 'on' : 'off'} data-testid="profile-card" {...trig}>
      <div className={cx("relative", compact ? 'h-[60px]' : 'h-[100px]')} data-banner={banner ? 'image' : isHexPair(u.themeColors) ? 'theme' : 'gradient'} style={{ background: headerBackground(u, banner, accent) }}><ProfileEffect id={u.profileEffect} /></div>
      <div className="relative px-4 pb-4">
        <div className="-mt-10 mb-1 flex items-end justify-between"><div className="rounded-full border-[6px] border-[rgb(var(--modal-alt))]"><Avatar user={u} memberAvatar={member?.avatar} size={80} presence ring="rgb(var(--modal-alt))" online={presence} /></div>
          {isMe ? <button className="btn btn-secondary" onClick={() => { closeAll(); openSettings({ kind: 'user', tab: 'profile' }); }}><Settings size={14} />{t('Edit Profile')}</button> : (
            <div className="mb-1 flex gap-2">
              {rel === 'friend' ? <button aria-label="Remove friend" title="Remove friend" className="btn btn-secondary" onClick={() => api.users.removeRelationship(userId).then(() => useData.getState().apply('RELATIONSHIP_REMOVE', { userId })).catch(toastError)}><UserMinus size={16} /></button>
                : rel === 'outgoing' ? <button className="btn btn-secondary" disabled>{t('Request Sent')}</button>
                : rel === 'blocked' ? null : <button className="btn btn-primary" onClick={() => api.users.setRelationship(userId, 'friend').then(() => toast(rel === 'incoming' ? 'Friend added' : 'Friend request sent', 'success')).catch(toastError)}><UserPlus size={16} />{rel === 'incoming' ? t('Accept') : t('Add Friend')}</button>}
              <button className="btn btn-secondary" aria-label="Message" onClick={() => { closeAll(); openDmWith(userId); }}><MessageSquare size={16} /></button>
              {canModView && <button className="btn btn-secondary" aria-label={t('Mod View')} title={t('Mod View')} onClick={() => { closeAll(); useUI.getState().openModal({ kind: 'modView', guildId: guildId!, userId }); }}><ShieldAlert size={16} /></button>}
            </div>)}
        </div>
        <div className="rounded-lg bg-[rgb(var(--rail)/0.5)] p-3">
          <div className={cx("text-xl font-bold leading-6 text-header", plateClass(u.namePlate), u.namePlate && "px-2 py-1 -mx-1")}>{displayName(u, member)} <ServerTagBadge tag={u.serverTag} className="align-middle" /></div>
          <div className="text-sm text-normal">{u.username}{u.pronouns && <span className="text-muted"> • {u.pronouns}</span>}</div>
          {(u.customStatus?.text || u.customStatus?.emoji) && <div className="mt-2 text-sm text-normal" data-testid="profile-status">{u.customStatus.emoji} {u.customStatus.text}</div>}
          {!compact && presence && <div className="mt-1 text-xs text-muted">{t(PRESENCE_LABEL[presence] ?? 'Offline')}</div>}
          <hr className="my-3 border-divider" />
          <ActivityCards userId={userId} fallback={q.data?.activities} />
          {u.bio && <><h4 className="mb-1 text-xs font-bold uppercase text-header">{t('About Me')}</h4><div className="mb-3 text-sm"><Markdown content={u.bio} guildId={guildId} /></div></>}
          <h4 className="mb-1 text-xs font-bold uppercase text-header">{t('Member Since')}</h4>
          <div className="mb-3 flex gap-3 text-sm"><span>{fmtStamp(new Date(u.createdAt).getTime()).replace(/ at .*/, '')}</span>{member && <span className="text-muted">• Joined {new Date(member.joinedAt).toLocaleDateString()}</span>}</div>
          {!!q.data?.connections?.length && (<><h4 className="mb-1 text-xs font-bold uppercase text-header">{t('Connections')}</h4><ul className="mb-3 flex flex-wrap gap-1.5" data-testid="profile-connections">{q.data.connections.map((c) => <li key={c.url}><a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-1 rounded bg-active px-2 py-1 text-xs font-medium text-header hover:underline" title={c.verified ? t('Verified') : t('Not verified')}>{c.name}{c.verified && <BadgeCheck size={13} className="text-success" aria-label={t('Verified')} />}</a></li>)}</ul></>)}
          {guildId && myRoles.length > 0 && (<><h4 className="mb-1 text-xs font-bold uppercase text-header">{t('Roles')}</h4><ul className="flex flex-wrap gap-1">{myRoles.map((r) => <li key={r.id} className="flex items-center gap-1.5 rounded bg-active px-2 py-0.5 text-xs font-medium text-header">{r.icon ? <RoleIcon role={r} size={14} /> : <span className="h-3 w-3 rounded-full" style={{ background: r.color ? intToHex(r.color) : 'rgb(var(--muted))' }} />}{r.name}</li>)}</ul></>)}
          {!isMe && q.data && <NoteBox userId={userId} note={q.data.note} />}
          {!compact && q.data?.mutualFriends && q.data.mutualFriends.length > 0 && !isMe && (<><h4 className="mb-1 mt-3 text-xs font-bold uppercase text-header">{t('Mutual Friends')} — {q.data.mutualFriends.length}</h4><ul className="flex flex-wrap gap-1" data-testid="mutual-friends">{q.data.mutualFriends.map((f) => <li key={f.id} className="flex items-center gap-1 rounded bg-active py-0.5 pe-2 ps-0.5 text-xs"><Avatar user={f} size={18} />{displayName(f)}</li>)}</ul></>)}
          {!compact && q.data?.mutualGuilds && q.data.mutualGuilds.length > 0 && !isMe && (<><h4 className="mb-1 mt-3 text-xs font-bold uppercase text-header">Mutual Servers — {q.data.mutualGuilds.length}</h4><ul className="flex flex-wrap gap-1">{q.data.mutualGuilds.map((g) => <li key={g.id} className="rounded bg-active px-2 py-0.5 text-xs">{g.name}</li>)}</ul></>)}
        </div>
      </div>
    </div>
  );
}
void cx;
