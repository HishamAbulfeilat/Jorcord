import { useEffect, useMemo, useState } from 'react';
import { Hash, Lock, Plus, Tag, Trash2, Settings as Cog, Shield, User as UserIcon, Webhook as WebhookIcon } from 'lucide-react';
import { WebhooksList } from './Webhooks';
import { FollowsList } from './FollowsList';
import { t } from '@/i18n';
import { AUTO_ARCHIVE_DURATIONS } from '@jorcord/shared';
import type { Channel, ForumTag, OverwriteDTO } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { H1, H3, SaveBar, SettingsLayout } from './SettingsLayout';
import { OverwriteGrid } from './PermGrid';
import { Field, Toggle } from '@/components/ui/primitives';
import { intToHex } from '@/lib/perms';
import { SLOWMODES, syncState } from '@/lib/channelSync';
import { cx, displayName } from '@/lib/format';


export function ChannelSettings({ channelId, close }: { channelId: string; close: () => void }) {
  const ch = useData((s) => Object.values(s.guilds).map((g) => g.channels[channelId]).find(Boolean)) as Channel | undefined;
  const g = useData((s) => (ch?.guildId ? s.guilds[ch.guildId] : undefined));
  const [tab, setTab] = useState('overview');
  const [f, setF] = useState({ name: ch?.name ?? '', topic: ch?.topic ?? '', nsfw: ch?.nsfw ?? false, slowmode: ch?.slowmode ?? 0, bitrate: ch?.bitrate ?? 64000, userLimit: ch?.userLimit ?? 0 });
  const [ows, setOws] = useState<OverwriteDTO[]>(ch?.overwrites ?? []); const [sel, setSel] = useState<string | null>(ch?.overwrites?.[0]?.id ?? g?.guild.id ?? null);
  const [busy, setBusy] = useState(false); const openModal = useUI((s) => s.openModal);
  useEffect(() => { if (ch) { setOws(ch.overwrites ?? []); } }, [ch?.overwrites]); // eslint-disable-line
  const dirtyOverview = !!ch && (f.name !== (ch.name ?? '') || f.topic !== (ch.topic ?? '') || f.nsfw !== ch.nsfw || f.slowmode !== ch.slowmode || (ch.type === 'voice' && (f.bitrate !== (ch.bitrate ?? 64000) || f.userLimit !== (ch.userLimit ?? 0))));
  const dirtyOws = JSON.stringify(ows) !== JSON.stringify(ch?.overwrites ?? []);
  const label = useMemo(() => (ow: OverwriteDTO) => ow.type === 'role' ? (g?.roles[ow.id]?.name ?? 'role') : displayName(g?.members[ow.id]?.user ?? { username: 'member', displayName: null }, g?.members[ow.id]), [g]);
  if (!ch || !g) return null;
  const saveOverview = async () => {
    setBusy(true);
    try { const u = await api.channels.patch(ch.id, { name: ch.type === 'category' ? f.name : f.name.toLowerCase().replace(/\s+/g, '-'), topic: f.topic || null, nsfw: f.nsfw, slowmode: f.slowmode, ...(ch.type === 'voice' ? { bitrate: f.bitrate, userLimit: f.userLimit || null } : {}) });
      useData.getState().apply('CHANNEL_UPDATE', { ...ch, ...u }); toast(t('Channel updated'), 'success'); } catch (e) { toastError(e); } setBusy(false);
  };
  const saveOws = async () => {
    setBusy(true);
    try {
      const old = ch.overwrites ?? [];
      for (const o of ows) { const prev = old.find((x) => x.id === o.id); if (!prev || prev.allow !== o.allow || prev.deny !== o.deny) await api.channels.putOverwrite(ch.id, o); }
      for (const o of old) if (!ows.find((x) => x.id === o.id)) await api.channels.deleteOverwrite(ch.id, o.id);
      useData.getState().apply('CHANNEL_UPDATE', { ...ch, overwrites: ows }); toast(t('Permissions saved'), 'success');
    } catch (e) { toastError(e); } setBusy(false);
  };
  const category = ch.parentId ? g.channels[ch.parentId] : undefined;
  const synced = syncState({ type: ch.type, parentId: ch.parentId, overwrites: ch.overwrites }, category);
  const syncNow = async () => {
    if (!category) return;
    setBusy(true);
    try { await api.channels.syncPermissions(ch.id); useData.getState().apply('CHANNEL_UPDATE', { ...ch, overwrites: category.overwrites }); toast(t('Permissions synced'), 'success'); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const cur = ows.find((o) => o.id === sel);
  const addables = [...Object.values(g.roles).map((r) => ({ id: r.id, type: 'role' as const, name: r.name, color: r.color })), ...Object.values(g.members).slice(0, 200).map((m) => ({ id: m.user.id, type: 'member' as const, name: displayName(m.user, m), color: 0 }))].filter((x) => !ows.find((o) => o.id === x.id));
  const [adding, setAdding] = useState(false); const [aq, setAq] = useState('');
  return (
    <SettingsLayout title={`#${ch.name}`} tab={tab} onTab={setTab} onClose={close}
      groups={[{ title: ch.name ?? 'Channel', items: [{ id: 'overview', label: 'Overview', icon: Cog }, { id: 'permissions', label: 'Permissions', icon: Lock }, ...((ch.type === 'forum' || ch.type === 'media') ? [{ id: 'tags', label: 'Tags', icon: Tag }] : []), ...(ch.type === 'text' || ch.type === 'announcement' ? [{ id: 'integrations', label: 'Integrations', icon: WebhookIcon }] : [])] }, { items: [{ id: 'delete', label: 'Delete Channel', icon: Trash2, danger: true }] }]}>
      {tab === 'overview' && (<>
        <H1>{t('Overview')}</H1>
        <Field label={t('Channel Name')}><div className="relative">{ch.type !== 'category' && <Hash size={16} className="absolute start-2.5 top-3 text-muted" />}<input className={cx('field', ch.type !== 'category' && 'ps-8')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div></Field>
        {ch.type !== 'category' && <Field label={t('Channel Topic')}><textarea className="field min-h-[100px]" value={f.topic} maxLength={1024} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder={t('Let everyone know how to use this channel!')} /></Field>}
        {(ch.type === 'text' || ch.type === 'forum' || ch.type === 'media' || ch.type === 'announcement') && <Field label={t('Slowmode')} hint={t('Members will be restricted to sending one message and creating one thread per this interval, unless they have Manage Channel or Manage Messages permissions.')}><select className="field" value={f.slowmode} onChange={(e) => setF({ ...f, slowmode: Number(e.target.value) })}>{SLOWMODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
        {ch.type === 'voice' && <><Field label={`Bitrate: ${Math.round(f.bitrate / 1000)}kbps`}><input type="range" min={8000} max={510000} step={1000} value={f.bitrate} onChange={(e) => setF({ ...f, bitrate: Number(e.target.value) })} className="w-full accent-brand" aria-label={t('Bitrate')} /></Field><Field label={`User limit: ${f.userLimit || 'No limit'}`}><input type="range" min={0} max={99} value={f.userLimit} onChange={(e) => setF({ ...f, userLimit: Number(e.target.value) })} className="w-full accent-brand" aria-label={t('User limit')} /></Field></>}
        {ch.type !== 'category' && <div className="flex items-center justify-between border-t border-divider py-4"><div><div className="font-medium text-header">{t('Age-Restricted Channel')}</div><div className="text-sm text-muted">{t('Users will need to confirm they are of legal age to view the content.')}</div></div><Toggle label={t('Age-restricted')} checked={f.nsfw} onChange={(v) => setF({ ...f, nsfw: v })} /></div>}
        <SaveBar dirty={dirtyOverview} busy={busy} onSave={saveOverview} onReset={() => setF({ name: ch.name ?? '', topic: ch.topic ?? '', nsfw: ch.nsfw, slowmode: ch.slowmode, bitrate: ch.bitrate ?? 64000, userLimit: ch.userLimit ?? 0 })} />
      </>)}
      {tab === 'permissions' && (<>
        <H1>{t('Channel Permissions')}</H1>
        <p className="mb-4 text-sm text-muted">{t('Use permissions to customize who can do what in this channel. Overwrites here take priority over server-wide role permissions.')}</p>
        {synced !== undefined && category && (
          <div data-testid="perm-sync" data-synced={synced} className="mb-4 flex flex-wrap items-center gap-3 rounded bg-side p-3">
            <div className="min-w-0 flex-1"><div className="font-medium text-header">{synced ? t('Synced with category') : t('Not synced with category')}</div><div className="text-sm text-muted">{synced ? `${t('Permissions match')} ${category.name}.` : `${t('Permissions differ from')} ${category.name}.`}</div></div>
            <button className="btn btn-secondary" disabled={busy || synced || dirtyOws} title={dirtyOws ? t('Save or reset your changes first') : undefined} onClick={syncNow}>{t('Sync now')}</button>
          </div>
        )}
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="md:w-52 md:shrink-0">
            <div className="mb-2 flex items-center justify-between"><span className="section-title">Roles / Members</span><button aria-label={t('Add role or member')} onClick={() => setAdding(!adding)} className="text-interactive hover:text-header"><Plus size={18} /></button></div>
            {adding && <div className="mb-2 rounded bg-float p-2"><input className="field mb-1 !min-h-[32px]" placeholder={t('Search')} value={aq} onChange={(e) => setAq(e.target.value)} autoFocus /><ul className="max-h-48 overflow-y-auto">{addables.filter((a) => a.name.toLowerCase().includes(aq.toLowerCase())).slice(0, 30).map((a) => <li key={a.id}><button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover" onClick={() => { setOws([...ows, { id: a.id, type: a.type, allow: '0', deny: '0' }]); setSel(a.id); setAdding(false); setAq(''); }}>{a.type === 'role' ? <Shield size={14} style={{ color: a.color ? intToHex(a.color) : undefined }} /> : <UserIcon size={14} />}{a.name}</button></li>)}</ul></div>}
            <ul className="space-y-0.5">{ows.map((o) => <li key={o.id}><button onClick={() => setSel(o.id)} aria-current={sel === o.id} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm font-medium', sel === o.id ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}>{o.type === 'role' ? <Shield size={14} style={{ color: g.roles[o.id]?.color ? intToHex(g.roles[o.id].color) : undefined }} /> : <UserIcon size={14} />}<span className="truncate">{label(o)}</span></button></li>)}</ul>
            {!ows.length && <p className="text-sm text-muted">{t('No overwrites. Add a role to begin.')}</p>}
          </div>
          <div className="min-w-0 flex-1">
            {cur ? (<><div className="mb-3 flex items-center justify-between"><H3>{label(cur)}</H3><button className="text-sm text-danger hover:underline" onClick={() => { setOws(ows.filter((o) => o.id !== cur.id)); setSel(null); }}>{t('Remove')}</button></div><OverwriteGrid ow={cur} onChange={(v) => setOws(ows.map((o) => (o.id === cur.id ? { ...o, ...v } : o)))} /></>) : <p className="text-muted">{t('Select a role or member.')}</p>}
          </div>
        </div>
        <SaveBar dirty={dirtyOws} busy={busy} onSave={saveOws} onReset={() => setOws(ch.overwrites ?? [])} />
      </>)}
      {tab === 'tags' && (ch.type === 'forum' || ch.type === 'media') && <ForumTagsTab ch={ch} />}
      {tab === 'integrations' && (<><H1>{t('Integrations')}</H1><p className="mb-4 text-sm text-muted">{t('Webhooks let other services post messages into this channel.')}</p><WebhooksList channelId={ch.id} /><FollowsList channelId={ch.id} announcement={ch.type === 'announcement'} /></>)}
      {tab === 'delete' && (<><H1>{t('Delete Channel')}</H1><p className="mb-4 text-muted">{t('Deleting a channel removes all of its messages permanently.')}</p><button className="btn btn-danger btn-lg" onClick={() => openModal({ kind: 'confirm', title: 'Delete Channel', body: `Are you sure you want to delete #${ch.name}? This cannot be undone.`, confirmLabel: 'Delete Channel', danger: true, onConfirm: async () => { try { await api.channels.delete(ch.id); } catch (e) { toastError(e); } } })}>{t('Delete Channel')}</button></>)}
    </SettingsLayout>
  );
}

const AUTO_LABEL: Record<number, string> = { 60: '1 Hour', 1440: '24 Hours', 4320: '3 Days', 10080: '1 Week' };
type TagDraft = Omit<ForumTag, 'id'> & { id?: string; key: string };
let tagKey = 0;
/** Forum tag catalogue + defaults (PATCH availableTags / requireTag / defaultAutoArchiveDuration / defaultSortOrder / defaultForumLayout / defaultReactionEmoji). Existing ids are sent back so tags keep their posts. */
function ForumTagsTab({ ch }: { ch: Channel }) {
  const init = (): TagDraft[] => (ch.availableTags ?? []).map((tg) => ({ ...tg, key: tg.id }));
  const [tags, setTags] = useState<TagDraft[]>(init); const [require, setRequire] = useState(!!ch.requireTag); const [auto, setAuto] = useState(ch.defaultAutoArchiveDuration ?? 1440); const [busy, setBusy] = useState(false);
  const [threadSlow, setThreadSlow] = useState(ch.defaultThreadSlowmode ?? 0); const [sortOrder, setSortOrder] = useState(ch.defaultSortOrder ?? 'latest_activity'); const [forumLayout, setForumLayout] = useState(ch.defaultForumLayout ?? 'list'); const [defaultEmoji, setDefaultEmoji] = useState(ch.defaultReactionEmoji ?? '');
  const dirty = JSON.stringify(tags.map(({ key, ...r }) => r)) !== JSON.stringify(init().map(({ key, ...r }) => r)) || threadSlow !== (ch.defaultThreadSlowmode ?? 0) || require !== !!ch.requireTag || auto !== (ch.defaultAutoArchiveDuration ?? 1440) || sortOrder !== (ch.defaultSortOrder ?? 'latest_activity') || forumLayout !== (ch.defaultForumLayout ?? 'list') || defaultEmoji !== (ch.defaultReactionEmoji ?? '');
  const set = (key: string, p: Partial<TagDraft>) => setTags((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const save = async () => {
    setBusy(true);
    try {
      const u = await api.channels.patch(ch.id, { availableTags: tags.filter((x) => x.name.trim()).map(({ key, id, name, emoji, moderated }) => ({ ...(id ? { id } : {}), name: name.trim(), emoji: emoji || null, moderated })) as ForumTag[], requireTag: require, defaultAutoArchiveDuration: auto, defaultThreadSlowmode: threadSlow, defaultSortOrder: sortOrder, defaultForumLayout: forumLayout, defaultReactionEmoji: defaultEmoji.trim() || null });
      useData.getState().apply('CHANNEL_UPDATE', { ...ch, ...u }); setTags((u.availableTags ?? []).map((tg) => ({ ...tg, key: tg.id }))); toast(t('Tags saved'), 'success');
    } catch (e) { toastError(e); } setBusy(false);
  };
  const reset = () => { setTags(init()); setRequire(!!ch.requireTag); setAuto(ch.defaultAutoArchiveDuration ?? 1440); setThreadSlow(ch.defaultThreadSlowmode ?? 0); setSortOrder(ch.defaultSortOrder ?? 'latest_activity'); setForumLayout(ch.defaultForumLayout ?? 'list'); setDefaultEmoji(ch.defaultReactionEmoji ?? ''); };
  return (<>
    <H1>{t('Tags')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Tags help people find the right posts. Moderated tags can only be applied by members who manage threads.')}</p>
    <ul className="mb-3 flex flex-col gap-2" aria-label={t('Tags')}>{tags.map((tg, i) => (
      <li key={tg.key} data-tag={tg.name} className="flex flex-wrap items-center gap-2 rounded bg-side p-2">
        <input className="field !w-14 text-center" aria-label={`Tag ${i + 1} emoji`} maxLength={8} value={tg.emoji ?? ''} onChange={(e) => set(tg.key, { emoji: e.target.value || null })} placeholder="🙂" />
        <input className="field min-w-[140px] flex-1" aria-label={`Tag ${i + 1} name`} maxLength={20} value={tg.name} onChange={(e) => set(tg.key, { name: e.target.value })} placeholder={t('Tag name')} />
        <label className="flex items-center gap-1.5 text-sm text-interactive"><input type="checkbox" className="h-4 w-4 accent-brand" checked={tg.moderated} onChange={(e) => set(tg.key, { moderated: e.target.checked })} />{t('Moderated')}</label>
        <button aria-label={`Remove tag ${tg.name || i + 1}`} className="p-2 text-danger" onClick={() => setTags((l) => l.filter((x) => x.key !== tg.key))}><Trash2 size={16} /></button>
      </li>))}</ul>
    <button className="btn btn-secondary mb-5" disabled={tags.length >= 20} onClick={() => setTags((l) => [...l, { key: 'n' + ++tagKey, name: '', emoji: null, moderated: false }])}><Plus size={14} />{t('Add Tag')}</button>
    <div className="flex items-center justify-between border-t border-divider py-4"><div><div className="font-medium text-header">{t('Require tag on new posts')}</div><div className="text-sm text-muted">{t('Members must pick at least one tag when they create a post.')}</div></div><Toggle label={t('Require tag')} checked={require} onChange={setRequire} /></div>
    <Field label={t('Hide After Inactivity')} hint={t('Default for new posts.')}><select className="field" value={auto} onChange={(e) => setAuto(Number(e.target.value))}>{AUTO_ARCHIVE_DURATIONS.map((d) => <option key={d} value={d}>{AUTO_LABEL[d]}</option>)}</select></Field>
    <Field label={t('Default Post Slowmode')} hint={t('New posts start with this slowmode, so people can reply only once per interval.')}><select className="field" aria-label={t('Default Post Slowmode')} value={threadSlow} onChange={(e) => setThreadSlow(Number(e.target.value))}>{SLOWMODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
    <Field label={t('Sort Order')} hint={t('How posts are ordered by default.')}><select className="field" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as 'latest_activity' | 'creation_date')}><option value="latest_activity">{t('Latest Activity')}</option><option value="creation_date">{t('Creation Date')}</option></select></Field>
    <Field label={t('Forum Layout')} hint={t('How the post list is presented by default.')}><select className="field" value={forumLayout} onChange={(e) => setForumLayout(e.target.value as 'list' | 'gallery')}><option value="list">{t('List')}</option><option value="gallery">{t('Gallery')}</option></select></Field>
    <Field label={t('Default Reaction Emoji')} hint={t('Automatically added to every new post.')}><input className="field" aria-label={t('Default Reaction Emoji')} maxLength={16} value={defaultEmoji} onChange={(e) => setDefaultEmoji(e.target.value)} placeholder="👋" /></Field>
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset} />
  </>);
}
