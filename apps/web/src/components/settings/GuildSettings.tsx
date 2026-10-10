import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, PanelTop, BarChart3, ShieldCheck, Tag, Volume2, Ban, Bot, Compass, GripVertical, Hash, Webhook as WebhookIcon, Sticker as StickerIcon, Copy as CopyIcon, Link2, ListChecks, Rocket, Settings as Cog, Shield, Smile, Trash2, Users, ScrollText, Plus, Search, Crown } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import type { AutoModPreset, AutoModRule, Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { SettingsLayout, H1, H3, SaveBar } from './SettingsLayout';
import { RolesEditor } from './RolesEditor';
import { Field, Spinner, Toggle, Empty, Row } from '@/components/ui/primitives';
import { IconPicker, uploadImageFile } from '@/components/modals/ModalHost';
import { Avatar } from '@/components/ui/Avatar';
import { can, canManageMember, effectivePerms, intToHex } from '@/lib/perms';
import { cx, displayName, fmtStamp, msgTime, copyText, inviteUrl, fileUrl } from '@/lib/format';
import { ChannelIcon } from '@/components/layout/ChannelSidebar';
import { snowflakeTime, LIMITS } from '@jorcord/shared';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CAT, applyChannelDrop, layoutOf, orderDiff } from '@/lib/channelOrder';
import { CommandPermissions } from './CommandPermissions';
import { WebhooksList } from './Webhooks';
import { publicOrigin } from '@/lib/server';
import { t, T } from '@/i18n';
import { SoundboardTab } from '@/components/Soundboard';
import { ServerTagEditor } from './CosmeticsPicker';
import { SafetyTab } from './SafetyTab';
import { AutoModTab } from './AutoModTab';
import { OnboardingTab } from './OnboardingTab';
import { TemplateTab, WidgetTab, InsightsTab, VanityUrl } from './ServerExtrasTabs';
import { AUDIT_FILTER_GROUPS, actionLabel, entryDetail, entryType } from '@/lib/audit';

export function GuildSettings({ guildId, initialTab }: { guildId: string; initialTab?: string }) {
  const g = useData((s) => s.guilds[guildId]); const me = useData((s) => selfMember(s, guildId)); const close = () => useUI.getState().openSettings(null);
  const perms = useMemo(() => (g && me ? effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me }) : 0n), [g, me]);
  const isOwner = g?.guild.ownerId === me?.user.id;
  const items = useMemo(() => {
    const it = (id: string, label: string, icon: any, ok: boolean) => (ok ? [{ id, label: t(label), icon }] : []);
    return [
      { title: g?.guild.name ?? 'Server', items: [...it('overview', T('Overview'), Cog, can(perms, Perm.MANAGE_GUILD)), ...it('roles', T('Roles'), Shield, can(perms, Perm.MANAGE_ROLES)), ...it('channels', T('Channels'), Hash, can(perms, Perm.MANAGE_CHANNELS)), ...it('emoji', T('Emoji'), Smile, can(perms, Perm.MANAGE_EMOJIS)), ...it('stickers', T('Stickers'), StickerIcon, can(perms, Perm.MANAGE_EMOJIS)), ...it('soundboard', T('Soundboard'), Volume2, can(perms, Perm.MANAGE_EMOJIS)), ...it('safety', T('Safety Setup'), ShieldCheck, can(perms, Perm.MANAGE_GUILD)), ...it('onboarding', T('Onboarding'), ListChecks, can(perms, Perm.MANAGE_GUILD)), ...it('template', T('Server Template'), FileText, can(perms, Perm.MANAGE_GUILD)), ...it('widget', T('Widget'), PanelTop, can(perms, Perm.MANAGE_GUILD)), ...it('insights', T('Insights'), BarChart3, can(perms, Perm.MANAGE_GUILD)), ...it('servertag', T('Server Tag'), Tag, can(perms, Perm.MANAGE_GUILD)), ...it('integrations', T('Integrations'), WebhookIcon, can(perms, Perm.MANAGE_WEBHOOKS)), ...it('commands', T('Command Permissions'), Bot, can(perms, Perm.MANAGE_GUILD) && can(perms, Perm.MANAGE_ROLES)), ...it('boosts', T('Server Boost'), Rocket, true)] },
      { title: t('Moderation'), items: [...it('members', T('Members'), Users, can(perms, Perm.KICK_MEMBERS) || can(perms, Perm.MANAGE_ROLES) || can(perms, Perm.MANAGE_GUILD)), ...it('invites', T('Invites'), Link2, can(perms, Perm.MANAGE_GUILD) || can(perms, Perm.CREATE_INVITE)), ...it('automod', T('AutoMod'), Bot, can(perms, Perm.MANAGE_GUILD)), ...it('audit', T('Audit Log'), ScrollText, can(perms, Perm.VIEW_AUDIT_LOG)), ...it('bans', T('Bans'), Ban, can(perms, Perm.BAN_MEMBERS))] },
      ...(isOwner ? [{ items: [{ id: 'delete', label: t('Delete Server'), icon: Trash2, danger: true }] }] : []),
    ].filter((gr) => gr.items.length);
  }, [perms, g?.guild.name, isOwner]);
  const first = items[0]?.items[0]?.id ?? 'boosts';
  const [tab, setTab] = useState(initialTab && items.some((x) => x.items.some((i) => i.id === initialTab)) ? initialTab : first);
  if (!g) return null;
  return (
    <SettingsLayout title={g.guild.name} groups={items} tab={tab} onTab={setTab} onClose={close}>
      {tab === 'overview' && <Overview guildId={guildId} />}
      {tab === 'roles' && (<><H1>{t('Roles')}</H1><RolesEditor guildId={guildId} /></>)}
      {tab === 'channels' && <ChannelsTab guildId={guildId} />}
      {tab === 'emoji' && <EmojiTab guildId={guildId} />}
      {tab === 'stickers' && <StickersTab guildId={guildId} />}
      {tab === 'soundboard' && <SoundboardTab guildId={guildId} />}
      {tab === 'safety' && <SafetyTab guildId={guildId} />}
      {tab === 'onboarding' && <OnboardingTab guildId={guildId} />}
      {tab === 'template' && <TemplateTab guildId={guildId} />}
      {tab === 'widget' && <WidgetTab guildId={guildId} />}
      {tab === 'insights' && <InsightsTab guildId={guildId} />}
      {tab === 'servertag' && <ServerTagTab guildId={guildId} />}
      {tab === 'integrations' && <IntegrationsTab guildId={guildId} />}
      {tab === 'commands' && <CommandPermissions guildId={guildId} />}
      {tab === 'boosts' && <Boosts guildId={guildId} />}
      {tab === 'members' && <MembersTab guildId={guildId} />}
      {tab === 'invites' && <InvitesTab guildId={guildId} />}
      {tab === 'automod' && <AutoModTab guildId={guildId} />}
      {tab === 'audit' && <Audit guildId={guildId} />}
      {tab === 'bans' && <Bans guildId={guildId} />}
      {tab === 'delete' && <DeleteServer guildId={guildId} />}
    </SettingsLayout>
  );
}

function Overview({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const gd = g.guild;
  const [f, setF] = useState({ name: gd.name, description: gd.description ?? '', icon: gd.icon, banner: gd.banner, systemChannelId: gd.systemChannelId ?? '', rulesChannelId: gd.rulesChannelId ?? '', discoverable: gd.features.includes('DISCOVERABLE'), screening: gd.features.includes('MEMBER_SCREENING') }); const [busy, setBusy] = useState(false);
  const dirty = f.name !== gd.name || (f.description || null) !== (gd.description || null) || f.icon !== gd.icon || f.banner !== gd.banner || (f.systemChannelId || null) !== (gd.systemChannelId || null) || (f.rulesChannelId || null) !== (gd.rulesChannelId || null) || f.discoverable !== gd.features.includes('DISCOVERABLE') || f.screening !== gd.features.includes('MEMBER_SCREENING');
  const save = async () => { setBusy(true); try { const u = await api.guilds.patch(guildId, { name: f.name, description: f.description || null, icon: f.icon, banner: f.banner, systemChannelId: f.systemChannelId || null, rulesChannelId: f.rulesChannelId || null, discoverable: f.discoverable, memberScreening: f.screening && !!f.rulesChannelId }); useData.getState().apply('GUILD_UPDATE', { ...gd, ...u }); toast(t('Server updated'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const texts = Object.values(g.channels).filter((c) => c.type === 'text');
  return (<>
    <H1>{t('Server Overview')}</H1>
    <div className="mb-6 flex flex-col gap-6 sm:flex-row"><div><span className="label">{t('Server Icon')}</span><IconPicker value={f.icon} onChange={(v) => setF({ ...f, icon: v })} /></div>
      <div className="flex-1"><Field label={t('Server Name')}><input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field></div></div>
    <Field label={t('Description')}><textarea className="field min-h-[80px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('Tell people what this server is about')} /></Field>
    <Field label={t('System Messages Channel')} hint={t('We use this channel to post welcome messages and boost announcements.')}><select className="field" value={f.systemChannelId} onChange={(e) => setF({ ...f, systemChannelId: e.target.value })}><option value="">{t('No system messages')}</option>{texts.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>
    <Field label={t('Rules Channel')} hint={t('New members review the messages in this channel on a welcome screen before they start chatting.')}><select className="field" value={f.rulesChannelId} onChange={(e) => setF({ ...f, rulesChannelId: e.target.value })}><option value="">{t('No rules screening')}</option>{texts.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>
    <Row title={t('Membership Screening')} desc={f.rulesChannelId ? t('New members must accept the rules before they can chat.') : t('Choose a rules channel first.')}><Toggle label={t('Membership Screening')} checked={f.screening && !!f.rulesChannelId} disabled={!f.rulesChannelId} onChange={(v) => setF({ ...f, screening: v })} /></Row>
    <Row title={t('Enable Discovery')} desc={t('Let people find this server on the Discover page.')}><Toggle label={t('Enable Discovery')} checked={f.discoverable} onChange={(v) => setF({ ...f, discoverable: v })} /></Row>
    <div className="mb-4 mt-4"><span className="label">{t('Server Banner')}</span><div className="relative h-28 overflow-hidden rounded-lg bg-rail">{f.banner && <img src={fileUrl(f.banner)!} alt="" className="h-full w-full object-cover" />}<label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 text-sm font-semibold text-white opacity-0 hover:opacity-100 focus-within:opacity-100">{t('Upload banner')}<input type="file" accept="image/*" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { try { setF({ ...f, banner: await uploadImageFile(file) }); } catch (err) { toastError(err); } } }} /></label></div>{f.banner && <button className="mt-1 text-sm text-link" onClick={() => setF({ ...f, banner: null })}>{t('Remove banner')}</button>}</div>
    <VanityUrl guildId={guildId} />
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF({ name: gd.name, description: gd.description ?? '', icon: gd.icon, banner: gd.banner, systemChannelId: gd.systemChannelId ?? '', rulesChannelId: gd.rulesChannelId ?? '', discoverable: gd.features.includes('DISCOVERABLE'), screening: gd.features.includes('MEMBER_SCREENING') })} />
  </>);
}

function ChannelsTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const open = useUI((s) => s.openModal);
  const cats = Object.values(g.channels).filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
  const kids = (pid: string | null) => Object.values(g.channels).filter((c) => c.type !== 'category' && c.type !== 'thread' && c.parentId === pid).sort((a, b) => a.position - b.position);
  const layout = layoutOf(kids(null), cats.map((cat) => ({ cat, children: kids(cat.id) })));
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }));
  const onEnd = async (e: DragEndEvent) => {
    if (!e.over) return;
    const next = applyChannelDrop(layout, String(e.active.id), String(e.over.id)); if (next === layout) return;
    const diff = orderDiff(next, g.channels); if (!diff.length) return;
    const before = diff.map((d) => g.channels[d.id]!).filter(Boolean);
    diff.forEach((d) => useData.getState().apply('CHANNEL_UPDATE', { ...g.channels[d.id]!, position: d.position, parentId: d.parentId }));
    try { await api.guilds.reorderChannels(guildId, diff); } catch (err) { before.forEach((c) => useData.getState().apply('CHANNEL_UPDATE', c)); toastError(err); }
  };
  return (<>
    <div className="mb-5 flex items-center justify-between"><h1 className="text-xl font-bold text-header">{t('Channels')}</h1><div className="flex gap-2"><button className="btn btn-secondary" onClick={() => open({ kind: 'createCategory', guildId })}>{t('New Category')}</button><button className="btn btn-primary" onClick={() => open({ kind: 'createChannel', guildId })}><Plus size={14} />{t('New Channel')}</button></div></div>
    <p className="mb-3 text-sm text-muted">{t('Drag the handles to reorder channels and categories, or move a channel into another category.')}</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
      <SortableContext items={layout.root} strategy={verticalListSortingStrategy}><ul>{kids(null).map((c) => <ChanRow key={c.id} c={c} />)}</ul></SortableContext>
      <SortableContext items={cats.map((c) => CAT + c.id)} strategy={verticalListSortingStrategy}>
        {cats.map((cat) => <CatBlock key={cat.id} cat={cat}><SortableContext items={kids(cat.id).map((c) => c.id)} strategy={verticalListSortingStrategy}><ul>{kids(cat.id).map((c) => <ChanRow key={c.id} c={c} />)}</ul></SortableContext></CatBlock>)}
      </SortableContext>
    </DndContext>
  </>);
}
function Handle({ attrs, label }: { attrs: Record<string, unknown>; label: string }) { return <button aria-label={label} className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted active:cursor-grabbing" {...attrs}><GripVertical size={14} /></button>; }
function ChanRow({ c }: { c: Channel }) {
  const open = useUI((s) => s.openModal);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  return <li ref={setNodeRef} data-channel={c.id} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx('flex items-center gap-1 rounded px-1 py-1 hover:bg-hover', isDragging && 'relative z-20 bg-hover opacity-80')}><Handle attrs={{ ...attributes, ...listeners }} label={t('Drag to reorder {name}', { name: c.name ?? '' })} /><ChannelIcon c={c} size={18} className="text-muted" /><span className="flex-1 truncate">{c.name}</span><button className="btn btn-secondary" onClick={() => open({ kind: 'channelSettings', channelId: c.id })}>{t('Edit')}</button></li>;
}
function CatBlock({ cat, children }: { cat: Channel; children: React.ReactNode }) {
  const open = useUI((s) => s.openModal);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: CAT + cat.id });
  return <section ref={setNodeRef} data-category={cat.id} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx('mt-4', isDragging && 'relative z-20 opacity-80')}><div className="flex items-center gap-1 px-1"><Handle attrs={{ ...attributes, ...listeners }} label={t('Drag to reorder {name}', { name: cat.name ?? '' })} /><H3>{cat.name}</H3><button className="ms-auto text-sm text-link hover:underline" onClick={() => open({ kind: 'channelSettings', channelId: cat.id })}>{t('Edit category')}</button></div>{children}</section>;
}

function EmojiTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const [name, setName] = useState(''); const [img, setImg] = useState<string | null>(null);
  const add = async () => { if (!img || !name) return; try { const e = await api.guilds.createEmoji(guildId, { name, url: img, animated: /\.gif($|\?)/i.test(img) }); useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: [...g.emojis, e] }); setName(''); setImg(null); toast(t('Emoji added'), 'success'); } catch (e) { toastError(e); } };
  return (<>
    <H1>{t('Emoji')}</H1>
    <p className="mb-4 text-sm text-muted">{g.emojis.length} / {LIMITS.maxEmojiPerServer} slots used. Everyone gets {LIMITS.maxEmojiPerServer} emoji slots — no paywall.</p>
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg bg-side p-3"><IconPicker value={img} onChange={setImg} label={t('Image')} size={56} /><div className="min-w-[160px] flex-1"><span className="label">{t('Name')}</span><input className="field" value={name} maxLength={32} onChange={(e) => setName(e.target.value.replace(/[^\w]/g, ''))} placeholder={t('emoji_name')} /></div><button disabled={!img || name.length < 2} className="btn btn-primary btn-lg" onClick={add}>{t('Upload')}</button></div>
    {!g.emojis.length && <Empty icon={<Smile size={40} />} title={t('No custom emoji yet')} />}
    <ul>{g.emojis.map((e) => <li key={e.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><img loading="lazy" decoding="async" src={fileUrl(e.url) ?? e.url} alt="" className="h-8 w-8 object-contain" /><span className="flex-1 font-mono text-sm">:{e.name}:</span><button className="btn btn-secondary" onClick={() => useUI.getState().openModal({ kind: 'prompt', title: 'Rename Emoji', label: 'Name', initial: e.name, onSubmit: (v) => api.guilds.patchEmoji(guildId, e.id, { name: v }).then(() => useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: g.emojis.map((x) => (x.id === e.id ? { ...x, name: v } : x)) })).catch(toastError) })}>{t('Rename')}</button><button aria-label={`Delete ${e.name}`} className="p-2 text-danger" onClick={() => api.guilds.deleteEmoji(guildId, e.id).then(() => useData.getState().apply('EMOJIS_UPDATE', { guildId, emojis: g.emojis.filter((x) => x.id !== e.id) })).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </>);
}

function Boosts({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!.guild; const [busy, setBusy] = useState(false);
  const tiers = [{ n: 2, label: 'Level 1', perks: ['Animated server icon', '128 kbps voice', '+50 emoji slots'] }, { n: 7, label: 'Level 2', perks: ['Server banner', '256 kbps voice', '1080p 60fps screen share'] }, { n: 14, label: 'Level 3', perks: ['Vanity invite URL', '384 kbps voice', '4K 60fps screen share'] }];
  const next = tiers.find((t) => g.boostCount < t.n);
  return (<>
    <H1>{t('Server Boost')}</H1>
    <div className="mb-6 overflow-hidden rounded-xl bg-gradient-to-br from-brand to-[#eb459e] p-6 text-white">
      <div className="flex items-center gap-3"><Rocket size={36} /><div><div className="text-2xl font-extrabold">Level {g.boostLevel}</div><div className="text-sm opacity-90">{g.boostCount} boost{g.boostCount === 1 ? '' : 's'} • Boosting is always free on Jorcord</div></div></div>
      {next && <div className="mt-4"><div className="mb-1 flex justify-between text-xs font-semibold"><span>{g.boostCount} / {next.n} for {next.label}</span></div><div className="h-2 overflow-hidden rounded-full bg-black/30"><div className="h-full bg-white" style={{ width: `${Math.min(100, (g.boostCount / next.n) * 100)}%` }} /></div></div>}
      <button disabled={busy} onClick={async () => { setBusy(true); try { const u = await api.guilds.boost(guildId); useData.getState().apply('GUILD_UPDATE', { ...g, ...u }); toast(t('Thanks for boosting!'), 'success'); } catch (e) { toastError(e); } setBusy(false); }} className="btn btn-lg mt-5 bg-white font-bold text-brand hover:bg-white/90">{t('Boost This Server')}</button>
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
    <H1>{t('Members')}</H1>
    <div className="mb-4 flex items-center rounded bg-rail px-2"><input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search members')} placeholder={t('Search by username or nickname')} className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
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
            {moderatable(Perm.KICK_MEMBERS) && <button className="btn btn-secondary" onClick={() => open({ kind: 'confirm', title: 'Kick Member', body: `Kick ${m.user.username}?`, confirmLabel: 'Kick', danger: true, onConfirm: () => api.guilds.kick(guildId, m.user.id).catch(toastError) })}>{t('Kick')}</button>}
            {moderatable(Perm.BAN_MEMBERS) && <button className="btn btn-danger" onClick={() => open({ kind: 'prompt', title: 'Ban Member', label: 'Reason (optional)', onSubmit: (reason) => api.guilds.ban(guildId, m.user.id, { reason, deleteMessageSeconds: 0 }).then(() => toast(t('Banned'), 'success')).catch(toastError) })}>{t('Ban')}</button>}
          </div></li>);
    })}</ul>
  </>);
}

function InvitesTab({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['invites', guildId], queryFn: () => api.guilds.invites(guildId) }); const qc = useQueryClient(); const users = useData((s) => s.users);
  return (<>
    <div className="mb-5 flex items-center justify-between"><h1 className="text-xl font-bold text-header">{t('Invites')}</h1><button className="btn btn-primary" onClick={() => useUI.getState().openModal({ kind: 'invite', guildId })}>{t('Create Invite')}</button></div>
    {q.isLoading && <Spinner />}{q.data?.length === 0 && <Empty icon={<Link2 size={40} />} title={t('No active invites')} />}
    <ul>{q.data?.map((i) => <li key={i.code} className="flex items-center gap-3 border-b border-divider/50 py-3 text-sm"><div className="min-w-0 flex-1"><div className="font-mono text-header">{i.code}</div><div className="text-xs text-muted">by {users[i.inviterId] ? displayName(users[i.inviterId]) : i.inviterId} • {i.uses}{i.maxUses ? `/${i.maxUses}` : ''} uses • {i.expiresAt ? `expires ${fmtStamp(new Date(i.expiresAt).getTime())}` : 'never expires'}</div></div><button className="btn btn-secondary" onClick={() => copyText(inviteUrl(i.code)).then(() => toast(t('Copied'), 'success'))}>{t('Copy')}</button><button aria-label={t('Revoke invite')} className="p-2 text-danger" onClick={() => api.invites.delete(i.code).then(() => qc.invalidateQueries({ queryKey: ['invites', guildId] })).catch(toastError)}><Trash2 size={16} /></button></li>)}</ul>
  </>);
}

function Audit({ guildId }: { guildId: string }) {
  const [type, setType] = useState(''); const users = useData((s) => s.users);
  const q = useQuery({ queryKey: ['audit', guildId, type], queryFn: () => api.guilds.auditLogs(guildId, { limit: 100, ...(type ? { actionType: Number(type) } : {}) }) });
  return (<>
    <H1>{t('Audit Log')}</H1>
    <select className="field mb-4 !w-auto" aria-label={t('Filter by action')} value={type} onChange={(e) => setType(e.target.value)}>
      <option value="">{t('All actions')}</option>
      {AUDIT_FILTER_GROUPS.map((g) => <optgroup key={g.title} label={g.title}>{g.items.map((a) => <option key={a.value} value={a.type}>{a.label}</option>)}</optgroup>)}
    </select>
    {q.isLoading && <Spinner />}{q.data?.length === 0 && <Empty icon={<ScrollText size={40} />} title={t('No entries')} />}
    <ul>{q.data?.map((e) => { const actor = users[e.actorId]; const detail = entryDetail(e); return <li key={e.id} data-action={e.action} data-action-type={entryType(e)} className="flex items-start gap-3 border-b border-divider/50 py-3 text-sm"><Avatar user={actor} size={32} /><div className="min-w-0 flex-1"><div><b className="text-header">{actor ? displayName(actor) : e.actorId}</b> <span className="text-muted">{actionLabel(e.action)}</span>{e.targetId && users[e.targetId] && <span className="text-muted"> • {displayName(users[e.targetId])}</span>}</div>{detail && <div className="truncate text-xs text-muted">{detail}</div>}{e.reason && <div className="text-xs text-muted">Reason: {e.reason}</div>}<div className="text-xs text-muted">{fmtStamp(new Date(e.createdAt || snowflakeTime(e.id)).getTime())}</div></div></li>; })}</ul>
  </>);
}

function Bans({ guildId }: { guildId: string }) {
  const q = useQuery({ queryKey: ['bans', guildId], queryFn: () => api.guilds.bans(guildId) }); const qc = useQueryClient(); const [s, setS] = useState('');
  const list = q.data?.filter((b) => b.user.username.toLowerCase().includes(s.toLowerCase())) ?? [];
  return (<>
    <H1>{t('Bans')}</H1>
    <input className="field mb-4" placeholder={t('Search bans')} aria-label={t('Search bans')} value={s} onChange={(e) => setS(e.target.value)} />
    {q.isLoading && <Spinner />}{q.data && !list.length && <Empty icon={<Ban size={40} />} title={t('No bans')} >{t('Nobody has been banned from this server.')}</Empty>}
    <ul>{list.map((b) => <li key={b.user.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><Avatar user={b.user} size={32} /><div className="min-w-0 flex-1"><div className="font-semibold text-header">{displayName(b.user)}</div>{b.reason && <div className="truncate text-xs text-muted">{b.reason}</div>}</div><button className="btn btn-secondary" onClick={() => api.guilds.unban(guildId, b.user.id).then(() => qc.invalidateQueries({ queryKey: ['bans', guildId] })).catch(toastError)}>{t('Revoke Ban')}</button></li>)}</ul>
  </>);
}

function DeleteServer({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!.guild; const open = useUI((s) => s.openModal);
  return (<><H1>{t('Delete Server')}</H1><p className="mb-4 text-muted">Deleting <b className="text-header">{g.name}</b> is permanent. All channels, messages, and members will be removed.</p>
    <button className="btn btn-danger btn-lg" onClick={() => open({ kind: 'prompt', title: `Delete '${g.name}'`, label: `Type the server name (${g.name}) to confirm`, onSubmit: async (v) => { if (v !== g.name) { toast(t('Name did not match'), 'error'); return; } try { await api.guilds.delete(guildId); useData.getState().apply('GUILD_DELETE', { id: guildId }); useUI.getState().openSettings(null); location.assign(import.meta.env.BASE_URL + 'channels/@me'); } catch (e) { toastError(e); } } })}>{t('Delete Server')}</button></>);
}
void ListChecks; void msgTime;

function stickerFormat(f: File): 'png' | 'apng' | 'gif' { return f.type === 'image/gif' ? 'gif' : f.type === 'image/apng' || /\.apng$/i.test(f.name) ? 'apng' : 'png'; }
function StickersTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!; const qc = useQueryClient(); const [name, setName] = useState(''); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const q = useQuery({ queryKey: ['stickers', guildId], queryFn: () => api.guilds.stickers(guildId), initialData: g.stickers });
  const put = (list: typeof g.stickers) => useData.setState((st) => ({ guilds: { ...st.guilds, [guildId]: { ...st.guilds[guildId]!, stickers: list } } }));
  const add = async () => {
    if (!file || name.trim().length < 2) return; setBusy(true);
    try { const url = await uploadImageFile(file); const sticker = await api.guilds.createSticker(guildId, { name: name.trim(), url, format: stickerFormat(file) }); put([...g.stickers, sticker]); qc.invalidateQueries({ queryKey: ['stickers', guildId] }); setName(''); setFile(null); toast(t('Sticker added'), 'success'); }
    catch (e) { toastError(e); } setBusy(false);
  };
  const list = q.data ?? g.stickers;
  return (<>
    <H1>{t('Stickers')}</H1>
    <p className="mb-4 text-sm text-muted">{list.length} / {LIMITS.maxStickersPerServer} {t('slots used. Members can send these stickers in this server.')}</p>
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg bg-side p-3">
      <div><span className="label">{t('Image')}</span><label className="flex h-20 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-muted text-xs font-bold uppercase text-muted hover:text-header">{preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : t('Upload')}<input type="file" accept="image/png,image/apng,image/gif,image/webp" aria-label={t('Sticker image')} className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} /></label></div>
      <div className="min-w-[160px] flex-1"><span className="label">{t('Name')}</span><input className="field" aria-label={t('Sticker name')} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder={t('sticker name')} /></div>
      <button disabled={!file || name.trim().length < 2 || busy} className="btn btn-primary btn-lg" onClick={add}>{t('Upload')}</button>
    </div>
    {!list.length && <Empty icon={<StickerIcon size={40} />} title={t('No stickers yet')} />}
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">{list.map((s) => (
      <li key={s.id} data-sticker={s.id} className="flex flex-col items-center gap-2 rounded-lg bg-side p-3">
        <img loading="lazy" decoding="async" src={fileUrl(s.url) ?? s.url} alt={s.name} className="h-24 w-24 object-contain" />
        <span className="max-w-full truncate text-sm font-medium text-header">{s.name}</span>
        <span className="flex gap-1"><button className="btn btn-secondary" onClick={() => useUI.getState().openModal({ kind: 'prompt', title: t('Rename Sticker'), label: t('Name'), initial: s.name, onSubmit: (v) => api.guilds.patchSticker(guildId, s.id, { name: v }).then((u) => { put(list.map((x) => (x.id === s.id ? { ...x, ...u } : x))); qc.invalidateQueries({ queryKey: ['stickers', guildId] }); }).catch(toastError) })}>{t('Rename')}</button>
          <button aria-label={t('Delete {name}', { name: s.name })} className="p-2 text-danger" onClick={() => api.guilds.deleteSticker(guildId, s.id).then(() => { put(list.filter((x) => x.id !== s.id)); qc.invalidateQueries({ queryKey: ['stickers', guildId] }); }).catch(toastError)}><Trash2 size={16} /></button></span>
      </li>))}</ul>
  </>);
}

function IntegrationsTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!;
  const chans = Object.values(g.channels).filter((c) => c.type === 'text' || c.type === 'announcement').sort((a, b) => a.position - b.position);
  const [sel, setSel] = useState(chans[0]?.id ?? '');
  return (<>
    <H1>{t('Integrations')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Webhooks let other services post messages into a channel. Keep webhook URLs secret: anyone with the URL can post.')}</p>
    <Field label={t('Channel')}><select className="field" aria-label={t('Channel')} value={sel} onChange={(e) => setSel(e.target.value)}>{chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>
    {sel && <WebhooksList channelId={sel} key={sel} />}
  </>);
}
void Compass; void CopyIcon; void publicOrigin;

function ServerTagTab({ guildId }: { guildId: string }) {
  const gd = useData((s) => s.guilds[guildId])!.guild; const init = { tag: gd.tag ?? '', badge: gd.tagBadge ?? null };
  const [f, setF] = useState(init); const [busy, setBusy] = useState(false);
  const valid = f.tag === '' || /^[A-Za-z0-9]{3,4}$/.test(f.tag);
  const save = async () => { setBusy(true); try { const u = await api.guilds.patch(guildId, { tag: f.tag ? f.tag.toUpperCase() : null, tagBadge: f.tag ? f.badge : null } as any); useData.getState().apply('GUILD_UPDATE', { ...gd, ...u }); toast(t('Server tag saved'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  return (<><H1>{t('Server Tag')}</H1><ServerTagEditor tag={f.tag} badge={f.badge} onChange={setF} />{!valid && <p className="text-sm text-danger">{t('A tag is 3 or 4 letters or digits.')}</p>}
    <SaveBar dirty={valid && (f.tag !== init.tag || f.badge !== init.badge)} busy={busy} onSave={save} onReset={() => setF(init)} /></>);
}
