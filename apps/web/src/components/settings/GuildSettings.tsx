import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bot, Hash, Link2, ListChecks, Rocket, Settings as Cog, Shield, Smile, Trash2, Users, ScrollText, Plus, Search, Crown } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import type { AutoModRule } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { SettingsLayout, H1, H3, SaveBar } from './SettingsLayout';
import { RolesEditor } from './RolesEditor';
import { Field, Spinner, Toggle, Empty } from '@/components/ui/primitives';
import { IconPicker, uploadImageFile } from '@/components/modals/ModalHost';
import { Avatar } from '@/components/ui/Avatar';
import { can, canManageMember, effectivePerms, intToHex } from '@/lib/perms';
import { cx, displayName, fmtStamp, msgTime, copyText, inviteUrl, fileUrl } from '@/lib/format';
import { ChannelIcon } from '@/components/layout/ChannelSidebar';
import { snowflakeTime, LIMITS } from '@jorcord/shared';

export function GuildSettings({ guildId, initialTab }: { guildId: string; initialTab?: string }) {
  const g = useData((s) => s.guilds[guildId]); const me = useData((s) => selfMember(s, guildId)); const close = () => useUI.getState().openSettings(null);
  const perms = useMemo(() => (g && me ? effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me }) : 0n), [g, me]);
  const isOwner = g?.guild.ownerId === me?.user.id;
  const items = useMemo(() => {
    const it = (id: string, label: string, icon: any, ok: boolean) => (ok ? [{ id, label, icon }] : []);
    return [
      { title: g?.guild.name ?? 'Server', items: [...it('overview', 'Overview', Cog, can(perms, Perm.MANAGE_GUILD)), ...it('roles', 'Roles', Shield, can(perms, Perm.MANAGE_ROLES)), ...it('channels', 'Channels', Hash, can(perms, Perm.MANAGE_CHANNELS)), ...it('emoji', 'Emoji', Smile, can(perms, Perm.MANAGE_EMOJIS)), ...it('boosts', 'Server Boost', Rocket, true)] },
      { title: 'Moderation', items: [...it('members', 'Members', Users, can(perms, Perm.KICK_MEMBERS) || can(perms, Perm.MANAGE_ROLES) || can(perms, Perm.MANAGE_GUILD)), ...it('invites', 'Invites', Link2, can(perms, Perm.MANAGE_GUILD) || can(perms, Perm.CREATE_INVITE)), ...it('automod', 'AutoMod', Bot, can(perms, Perm.MANAGE_GUILD)), ...it('audit', 'Audit Log', ScrollText, can(perms, Perm.VIEW_AUDIT_LOG)), ...it('bans', 'Bans', Ban, can(perms, Perm.BAN_MEMBERS))] },
      ...(isOwner ? [{ items: [{ id: 'delete', label: 'Delete Server', icon: Trash2, danger: true }] }] : []),
    ].filter((gr) => gr.items.length);
  }, [perms, g?.guild.name, isOwner]);
  const first = items[0]?.items[0]?.id ?? 'boosts';
  const [tab, setTab] = useState(initialTab && items.some((x) => x.items.some((i) => i.id === initialTab)) ? initialTab : first);
  if (!g) return null;
  return (
    <SettingsLayout title={g.guild.name} groups={items} tab={tab} onTab={setTab} onClose={close}>
      {tab === 'overview' && <Overview guildId={guildId} />}
      {tab === 'roles' && (<><H1>Roles</H1><RolesEditor guildId={guildId} /></>)}
      {tab === 'channels' && <ChannelsTab guildId={guildId} />}
      {tab === 'emoji' && <EmojiTab guildId={guildId} />}
      {tab === 'boosts' && <Boosts guildId={guildId} />}
      {tab === 'members' && <MembersTab guildId={guildId} />}
      {tab === 'invites' && <InvitesTab guildId={guildId} />}
      {tab === 'automod' && <AutoMod guildId={guildId} />}
      {tab === 'audit' && <Audit guildId={guildId} />}
      {tab === 'bans' && <Bans guildId={guildId} />}
      {tab === 'delete' && <DeleteServer guildId={guildId} />}
    </SettingsLayout>
  );
}

function Overview({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const gd = g.guild;
  const [f, setF] = useState({ name: gd.name, description: gd.description ?? '', icon: gd.icon, banner: gd.banner, systemChannelId: gd.systemChannelId ?? '' }); const [busy, setBusy] = useState(false);
  const dirty = f.name !== gd.name || (f.description || null) !== (gd.description || null) || f.icon !== gd.icon || f.banner !== gd.banner || (f.systemChannelId || null) !== (gd.systemChannelId || null);
  const save = async () => { setBusy(true); try { const u = await api.guilds.patch(guildId, { name: f.name, description: f.description || null, icon: f.icon, banner: f.banner, systemChannelId: f.systemChannelId || null }); useData.getState().apply('GUILD_UPDATE', { ...gd, ...u }); toast('Server updated', 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const texts = Object.values(g.channels).filter((c) => c.type === 'text');
  return (<>
    <H1>Server Overview</H1>
    <div className="mb-6 flex flex-col gap-6 sm:flex-row"><div><span className="label">Server Icon</span><IconPicker value={f.icon} onChange={(v) => setF({ ...f, icon: v })} /></div>
      <div className="flex-1"><Field label="Server Name"><input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field></div></div>
    <Field label="Description"><textarea className="field min-h-[80px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Tell people what this server is about" /></Field>
    <Field label="System Messages Channel" hint="We use this channel to post welcome messages and boost announcements."><select className="field" value={f.systemChannelId} onChange={(e) => setF({ ...f, systemChannelId: e.target.value })}><option value="">No system messages</option>{texts.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>
    <div className="mb-4"><span className="label">Server Banner</span><div className="relative h-28 overflow-hidden rounded-lg bg-rail">{f.banner && <img src={fileUrl(f.banner)!} alt="" className="h-full w-full object-cover" />}<label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 text-sm font-semibold text-white opacity-0 hover:opacity-100 focus-within:opacity-100">Upload banner<input type="file" accept="image/*" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { try { setF({ ...f, banner: await uploadImageFile(file) }); } catch (err) { toastError(err); } } }} /></label></div>{f.banner && <button className="mt-1 text-sm text-link" onClick={() => setF({ ...f, banner: null })}>Remove banner</button>}</div>
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF({ name: gd.name, description: gd.description ?? '', icon: gd.icon, banner: gd.banner, systemChannelId: gd.systemChannelId ?? '' })} />
  </>);
}

function ChannelsTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const open = useUI((s) => s.openModal);
  const cats = Object.values(g.channels).filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
  const kids = (pid: string | null) => Object.values(g.channels).filter((c) => c.type !== 'category' && c.type !== 'thread' && c.parentId === pid).sort((a, b) => a.position - b.position);
  const Row = ({ c }: { c: ReturnType<typeof kids>[number] }) => <li className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-hover"><ChannelIcon c={c} size={18} className="text-muted" /><span className="flex-1 truncate">{c.name}</span><button className="btn btn-secondary" onClick={() => open({ kind: 'channelSettings', channelId: c.id })}>Edit</button></li>;
  return (<>
    <div className="mb-5 flex items-center justify-between"><h1 className="text-xl font-bold text-header">Channels</h1><div className="flex gap-2"><button className="btn btn-secondary" onClick={() => open({ kind: 'createCategory', guildId })}>New Category</button><button className="btn btn-primary" onClick={() => open({ kind: 'createChannel', guildId })}><Plus size={14} />New Channel</button></div></div>
    <ul>{kids(null).map((c) => <Row key={c.id} c={c} />)}</ul>
    {cats.map((cat) => <section key={cat.id} className="mt-4"><div className="flex items-center justify-between px-2"><H3>{cat.name}</H3><button className="text-sm text-link hover:underline" onClick={() => open({ kind: 'channelSettings', channelId: cat.id })}>Edit category</button></div><ul>{kids(cat.id).map((c) => <Row key={c.id} c={c} />)}</ul></section>)}
  </>);
}

function EmojiTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const [name, setName] = useState(''); const [img, setImg] = useState<string | null>(null);
  const add = async () => { if (!img || !name) return; try { const e = await api.guilds.createEmoji(guildId, { name, url: img, animated: /\.gif($|\?)/i.test(img) }); useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: [...g.emojis, e] }); setName(''); setImg(null); toast('Emoji added', 'success'); } catch (e) { toastError(e); } };
  return (<>
    <H1>Emoji</H1>
    <p className="mb-4 text-sm text-muted">{g.emojis.length} / {LIMITS.maxEmojiPerServer} slots used. Everyone gets {LIMITS.maxEmojiPerServer} emoji slots — no paywall.</p>
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg bg-side p-3"><IconPicker value={img} onChange={setImg} label="Image" size={56} /><div className="min-w-[160px] flex-1"><span className="label">Name</span><input className="field" value={name} maxLength={32} onChange={(e) => setName(e.target.value.replace(/[^\w]/g, ''))} placeholder="emoji_name" /></div><button disabled={!img || name.length < 2} className="btn btn-primary btn-lg" onClick={add}>Upload</button></div>
    {!g.emojis.length && <Empty icon={<Smile size={40} />} title="No custom emoji yet" />}
    <ul>{g.emojis.map((e) => <li key={e.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><img src={e.url} alt="" className="h-8 w-8 object-contain" /><span className="flex-1 font-mono text-sm">:{e.name}:</span><button className="btn btn-secondary" onClick={() => useUI.getState().openModal({ kind: 'prompt', title: 'Rename Emoji', label: 'Name', initial: e.name, onSubmit: (v) => api.guilds.patchEmoji(guildId, e.id, { name: v }).then(() => useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: g.emojis.map((x) => (x.id === e.id ? { ...x, name: v } : x)) })).catch(toastError) })}>Rename</button><button aria-label={`Delete ${e.name}`} className="p-2 text-danger" onClick={() => api.guilds.deleteEmoji(guildId, e.id).then(() => useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: g.emojis.filter((x) => x.id !== e.id) })).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </>);
}

function Boosts({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!.guild; const [busy, setBusy] = useState(false);
  const tiers = [{ n: 2, label: 'Level 1', perks: ['Animated server icon', '128 kbps voice', '+50 emoji slots'] }, { n: 7, label: 'Level 2', perks: ['Server banner', '256 kbps voice', '1080p 60fps screen share'] }, { n: 14, label: 'Level 3', perks: ['Vanity invite URL', '384 kbps voice', '4K 60fps screen share'] }];
  const next = tiers.find((t) => g.boostCount < t.n);
  return (<>
    <H1>Server Boost</H1>
    <div className="mb-6 overflow-hidden rounded-xl bg-gradient-to-br from-brand to-[#eb459e] p-6 text-white">
      <div className="flex items-center gap-3"><Rocket size={36} /><div><div className="text-2xl font-extrabold">Level {g.boostLevel}</div><div className="text-sm opacity-90">{g.boostCount} boost{g.boostCount === 1 ? '' : 's'} • Boosting is always free on Jorcord</div></div></div>
      {next && <div className="mt-4"><div className="mb-1 flex justify-between text-xs font-semibold"><span>{g.boostCount} / {next.n} for {next.label}</span></div><div className="h-2 overflow-hidden rounded-full bg-black/30"><div className="h-full bg-white" style={{ width: `${Math.min(100, (g.boostCount / next.n) * 100)}%` }} /></div></div>}
      <button disabled={busy} onClick={async () => { setBusy(true); try { const u = await api.guilds.boost(guildId); useData.getState().apply('GUILD_UPDATE', { ...g, ...u }); toast('Thanks for boosting!', 'success'); } catch (e) { toastError(e); } setBusy(false); }} className="btn btn-lg mt-5 bg-white font-bold text-brand hover:bg-white/90">Boost This Server</button>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">{tiers.map((t, i) => <div key={t.label} className={cx('rounded-lg border p-4', g.boostLevel > i ? 'border-brand bg-brand/10' : 'border-divider bg-side')}><div className="mb-1 font-bold text-header">{t.label} <span className="text-xs font-normal text-muted">{t.n} boosts</span></div><ul className="space-y-1 text-sm text-muted">{t.perks.map((p) => <li key={p}>✓ {p}</li>)}</ul></div>)}</div>
  </>);
}

function MembersTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const me = useData((s) => selfMember(s, guildId))!; const [q, setQ] = useState(''); const open = useUI((s) => s.openModal);
  const perms = effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me });
  const roles = Object.values(g.roles);
  const list = Object.values(g.members).filter((m) => `${m.user.username} ${m.user.displayName ?? ''} ${m.nick ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const remote = useQuery({ queryKey: ['members-search', guildId, q], enabled: q.length > 1, queryFn: () => api.guilds.searchMembers(guildId, q) });
  const shown = remote.data?.length ? remote.data : list;
  return (<>
    <H1>Members</H1>
    <div className="mb-4 flex items-center rounded bg-rail px-2"><input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" placeholder="Search by username or nickname" className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
    <p className="mb-2 text-xs text-muted">{g.memberCount} members</p>
    <ul>{shown.map((m) => {
      const target = g.members[m.user.id] ?? m;
      const moderatable = (p: bigint) => canManageMember(g.guild, roles, me, target, perms, p);
      return (
        <li key={m.user.id} className="flex flex-wrap items-center gap-3 border-b border-divider/50 py-2.5"><Avatar user={m.user} size={36} memberAvatar={m.avatar} />
          <div className="min-w-0 flex-1"><div className="flex items-center gap-1 truncate font-semibold text-header">{displayName(m.user, m)}{g.guild.ownerId === m.user.id && <Crown size={14} className="text-warn" />}</div><div className="truncate text-xs text-muted">{m.user.username} • Joined {new Date(m.joinedAt).toLocaleDateString()}</div>
            <div className="mt-1 flex flex-wrap gap-1">{m.roles.map((r) => g.roles[r]).filter(Boolean).map((r) => <span key={r.id} className="flex items-center gap-1 rounded bg-active px-1.5 py-0.5 text-[11px] text-header"><span className="h-2 w-2 rounded-full" style={{ background: r.color ? intToHex(r.color) : 'rgb(var(--muted))' }} />{r.name}</span>)}</div></div>
          <div className="flex gap-1">
            {moderatable(Perm.MANAGE_ROLES) && <select aria-label={`Add role to ${m.user.username}`} value="" className="field !min-h-[32px] !w-auto !py-0 text-xs" onChange={(e) => { const rid = e.target.value; if (!rid) return; api.guilds.patchMember(guildId, m.user.id, { roles: [...m.roles, rid] }).then(() => useData.getState().apply('MEMBER_UPDATE', { ...target, roles: [...target.roles, rid] })).catch(toastError); }}><option value="">+ Role</option>{roles.filter((r) => r.id !== guildId && !m.roles.includes(r.id) && (me.user.id === g.guild.ownerId || r.position < Math.max(0, ...roles.filter((x) => me.roles.includes(x.id)).map((x) => x.position)))).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
            {moderatable(Perm.KICK_MEMBERS) && <button className="btn btn-secondary" onClick={() => open({ kind: 'confirm', title: 'Kick Member', body: `Kick ${m.user.username}?`, confirmLabel: 'Kick', danger: true, onConfirm: () => api.guilds.kick(guildId, m.user.id).catch(toastError) })}>Kick</button>}
            {moderatable(Perm.BAN_MEMBERS) && <button className="btn btn-danger" onClick={() => open({ kind: 'prompt', title: 'Ban Member', label: 'Reason (optional)', onSubmit: (reason) => api.guilds.ban(guildId, m.user.id, { reason, deleteMessageSeconds: 0 }).then(() => toast('Banned', 'success')).catch(toastError) })}>Ban</button>}
          </div></li>);
    })}</ul>
  </>);
}

function InvitesTab({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['invites', guildId], queryFn: () => api.guilds.invites(guildId) }); const qc = useQueryClient(); const users = useData((s) => s.users);
  return (<>
    <div className="mb-5 flex items-center justify-between"><h1 className="text-xl font-bold text-header">Invites</h1><button className="btn btn-primary" onClick={() => useUI.getState().openModal({ kind: 'invite', guildId })}>Create Invite</button></div>
    {q.isLoading && <Spinner />}{q.data?.length === 0 && <Empty icon={<Link2 size={40} />} title="No active invites" />}
    <ul>{q.data?.map((i) => <li key={i.code} className="flex items-center gap-3 border-b border-divider/50 py-3 text-sm"><div className="min-w-0 flex-1"><div className="font-mono text-header">{i.code}</div><div className="text-xs text-muted">by {users[i.inviterId] ? displayName(users[i.inviterId]) : i.inviterId} • {i.uses}{i.maxUses ? `/${i.maxUses}` : ''} uses • {i.expiresAt ? `expires ${fmtStamp(new Date(i.expiresAt).getTime())}` : 'never expires'}</div></div><button className="btn btn-secondary" onClick={() => copyText(inviteUrl(i.code)).then(() => toast('Copied', 'success'))}>Copy</button><button aria-label="Revoke invite" className="p-2 text-danger" onClick={() => api.invites.delete(i.code).then(() => qc.invalidateQueries({ queryKey: ['invites', guildId] })).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </>);
}

function AutoMod({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['automod', guildId], queryFn: () => api.guilds.automod(guildId) }); const qc = useQueryClient();
  const [f, setF] = useState<{ name: string; trigger: AutoModRule['trigger']; keywords: string; action: AutoModRule['action'] }>({ name: '', trigger: 'keyword', keywords: '', action: 'block' });
  const refetch = () => qc.invalidateQueries({ queryKey: ['automod', guildId] });
  return (<>
    <H1>AutoMod</H1>
    <p className="mb-4 text-sm text-muted">Automatically moderate your server by blocking messages, timing out offenders, or alerting moderators.</p>
    <div className="mb-6 rounded-lg bg-side p-4">
      <h3 className="mb-3 font-bold text-header">Create rule</h3>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Trigger"><select className="field" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value as any })}><option value="keyword">Block custom words</option><option value="spam">Spam</option><option value="mention_spam">Mention spam</option><option value="link">Links</option></select></Field></div>
      {f.trigger === 'keyword' && <Field label="Keywords (comma separated)"><input className="field" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} placeholder="word1, word2" /></Field>}
      <Field label="Action"><select className="field" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as any })}><option value="block">Block message</option><option value="timeout">Timeout member</option><option value="alert">Send alert</option></select></Field>
      <button disabled={!f.name.trim()} className="btn btn-primary" onClick={() => api.guilds.createAutomod(guildId, { name: f.name, trigger: f.trigger, keywords: f.keywords.split(',').map((x) => x.trim()).filter(Boolean), action: f.action, enabled: true, exemptRoles: [] }).then(() => { setF({ ...f, name: '', keywords: '' }); refetch(); }).catch(toastError)}>Create Rule</button>
    </div>
    {q.isLoading && <Spinner />}
    <ul>{q.data?.map((r) => <li key={r.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><div className="min-w-0 flex-1"><div className="font-semibold text-header">{r.name}</div><div className="truncate text-xs text-muted">{r.trigger} → {r.action}{r.keywords.length ? ` • ${r.keywords.join(', ')}` : ''}</div></div><Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={(v) => api.guilds.patchAutomod(guildId, r.id, { enabled: v }).then(refetch).catch(toastError)} /><button aria-label="Delete rule" className="p-2 text-danger" onClick={() => api.guilds.deleteAutomod(guildId, r.id).then(refetch).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </>);
}

const ACTION_LABEL = (a: string) => a.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
function Audit({ guildId }: { guildId: string }) {
  const [action, setAction] = useState(''); const users = useData((s) => s.users);
  const q = useQuery({ queryKey: ['audit', guildId, action], queryFn: () => api.guilds.auditLogs(guildId, { limit: 100, action: action || undefined }) });
  const actions = ['', 'CHANNEL_CREATE', 'CHANNEL_DELETE', 'ROLE_CREATE', 'ROLE_UPDATE', 'MEMBER_KICK', 'MEMBER_BAN_ADD', 'MESSAGE_DELETE', 'INVITE_CREATE', 'GUILD_UPDATE'];
  return (<>
    <H1>Audit Log</H1>
    <select className="field mb-4 !w-auto" aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)}>{actions.map((a) => <option key={a} value={a}>{a ? ACTION_LABEL(a) : 'All actions'}</option>)}</select>
    {q.isLoading && <Spinner />}{q.data?.length === 0 && <Empty icon={<ScrollText size={40} />} title="No entries" />}
    <ul>{q.data?.map((e) => { const actor = users[e.actorId]; return <li key={e.id} className="flex items-start gap-3 border-b border-divider/50 py-3 text-sm"><Avatar user={actor} size={32} /><div className="min-w-0 flex-1"><div><b className="text-header">{actor ? displayName(actor) : e.actorId}</b> <span className="text-muted">{ACTION_LABEL(e.action)}</span>{e.targetId && <span className="text-muted"> • target {users[e.targetId] ? displayName(users[e.targetId]) : e.targetId}</span>}</div>{e.reason && <div className="text-xs text-muted">Reason: {e.reason}</div>}<div className="text-xs text-muted">{fmtStamp(new Date(e.createdAt || snowflakeTime(e.id)).getTime())}</div></div></li>; })}</ul>
  </>);
}

function Bans({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['bans', guildId], queryFn: () => api.guilds.bans(guildId) }); const qc = useQueryClient(); const [s, setS] = useState('');
  const list = q.data?.filter((b) => b.user.username.toLowerCase().includes(s.toLowerCase())) ?? [];
  return (<>
    <H1>Bans</H1>
    <input className="field mb-4" placeholder="Search bans" aria-label="Search bans" value={s} onChange={(e) => setS(e.target.value)} />
    {q.isLoading && <Spinner />}{q.data && !list.length && <Empty icon={<Ban size={40} />} title="No bans" >Nobody has been banned from this server.</Empty>}
    <ul>{list.map((b) => <li key={b.user.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><Avatar user={b.user} size={32} /><div className="min-w-0 flex-1"><div className="font-semibold text-header">{displayName(b.user)}</div>{b.reason && <div className="truncate text-xs text-muted">{b.reason}</div>}</div><button className="btn btn-secondary" onClick={() => api.guilds.unban(guildId, b.user.id).then(() => qc.invalidateQueries({ queryKey: ['bans', guildId] })).catch(toastError)}>Revoke Ban</button></li>)}</ul>
  </>);
}

function DeleteServer({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!.guild; const open = useUI((s) => s.openModal);
  return (<><H1>Delete Server</H1><p className="mb-4 text-muted">Deleting <b className="text-header">{g.name}</b> is permanent. All channels, messages, and members will be removed.</p>
    <button className="btn btn-danger btn-lg" onClick={() => open({ kind: 'prompt', title: `Delete '${g.name}'`, label: `Type the server name (${g.name}) to confirm`, onSubmit: async (v) => { if (v !== g.name) { toast('Name did not match', 'error'); return; } try { await api.guilds.delete(guildId); useData.getState().apply('GUILD_DELETE', { id: guildId }); useUI.getState().openSettings(null); location.assign('/channels/@me'); } catch (e) { toastError(e); } } })}>Delete Server</button></>);
}
void ListChecks; void msgTime;
