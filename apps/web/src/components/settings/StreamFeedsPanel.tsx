import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { DEFAULT_STREAM_FEED_TEMPLATES, MAX_STREAM_FEED_TEMPLATE, type StreamFeed, type StreamFeedProvider } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError, useUI } from '@/stores/ui';
import { Empty, Field, Spinner, Toggle } from '@/components/ui/primitives';
import { H3 } from './SettingsLayout';
import { t } from '@/i18n';

const PROVIDER_NAME: Record<StreamFeedProvider, string> = { twitch: 'Twitch', youtube: 'YouTube' };

/**
 * Server Settings > Integrations > Stream & video feeds: announce a Twitch channel going live or a new YouTube video in a channel.
 * The server does the polling and enforces Manage Server, the role-mention rules and the per-server cap; this only edits the list.
 */
export function StreamFeedsPanel({ guildId }: { guildId: string }) {
  const qc = useQueryClient(); const key = ['stream-feeds', guildId];
  const g = useData((s) => s.guilds[guildId]);
  const q = useQuery({ queryKey: key, queryFn: () => api.guilds.streamFeeds(guildId), retry: false });
  const chans = Object.values(g?.channels ?? {}).filter((c) => c.type === 'text' || c.type === 'announcement').sort((a, b) => a.position - b.position);
  const roles = Object.values(g?.roles ?? {}).filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const feeds = q.data?.feeds ?? []; const providers = q.data?.providers ?? { twitch: false, youtube: true }; const max = q.data?.max ?? 25;
  const chanName = (id: string) => chans.find((c) => c.id === id)?.name ?? id;
  const remove = (f: StreamFeed) => useUI.getState().openModal({
    kind: 'confirm', title: t('Remove {name}?', { name: f.name }), body: t('Announcements for this channel stop. Messages already posted stay.'), confirmLabel: t('Remove'), danger: true,
    onConfirm: () => api.guilds.deleteStreamFeed(guildId, f.id).then(() => { toast(t('Feed removed'), 'success'); void refresh(); }).catch(toastError),
  });
  const toggle = (f: StreamFeed, enabled: boolean) => api.guilds.patchStreamFeed(guildId, f.id, { enabled }).then(() => refresh()).catch(toastError);

  return (<section data-testid="stream-feeds" className="mt-8">
    <H3>{t('Stream & video feeds')}</H3>
    <p className="mb-4 text-sm text-muted">{t('Post a message when a Twitch channel goes live or a YouTube channel publishes a new video. Checked every few minutes.')}</p>
    <FeedForm key="new" guildId={guildId} chans={chans} roles={roles} providers={providers} disabled={feeds.length >= max} onSaved={() => { void refresh(); }} />
    <p className="mb-2 text-xs text-muted">{t('{n} of {max} feeds used', { n: feeds.length, max })}</p>
    {q.isLoading && <Spinner />}
    {q.isError && <p role="alert" className="text-sm text-danger">{t('Could not load the feeds.')}</p>}
    {q.data && !feeds.length && <Empty title={t('No feeds yet')} />}
    <ul className="space-y-2">{feeds.map((f) => (
      <li key={f.id} data-testid="stream-feed" data-feed={f.id} className="rounded-lg border border-divider bg-side p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-brand px-1 text-[10px] font-bold uppercase text-white">{PROVIDER_NAME[f.provider]}</span>
          <span className="font-semibold text-header">{f.name}</span>
          <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${t('Open')} ${f.name}`} className="p-1 text-interactive hover:text-header"><ExternalLink size={14} /></a>
          <span className="truncate text-sm text-muted">{t('posts in #{name}', { name: chanName(f.channelId) })}</span>
          <span className="ms-auto flex items-center gap-2 text-xs text-muted">{t('Enabled')}<Toggle label={`${t('Enabled')}: ${f.name}`} checked={f.enabled} onChange={(v) => void toggle(f, v)} /></span>
          <button aria-label={`${t('Edit')} ${f.name}`} className="p-1 text-interactive hover:text-header" onClick={() => setEditing(editing === f.id ? null : f.id)}><Pencil size={16} /></button>
          <button aria-label={`${t('Remove')} ${f.name}`} className="p-1 text-danger" onClick={() => remove(f)}><Trash2 size={16} /></button>
        </div>
        {f.lastError && <p role="status" data-testid="feed-error" className="mt-1 text-xs text-danger">{t('Last check failed: {error}', { error: f.lastError })}</p>}
        {editing === f.id && <div className="mt-3"><FeedForm guildId={guildId} feed={f} chans={chans} roles={roles} providers={providers} onSaved={() => { setEditing(null); void refresh(); }} /></div>}
      </li>))}</ul>
  </section>);
}

type Chan = { id: string; name: string | null }; type RoleOpt = { id: string; name: string };

function FeedForm({ guildId, feed, chans, roles, providers, disabled, onSaved }: { guildId: string; feed?: StreamFeed; chans: Chan[]; roles: RoleOpt[]; providers: Record<StreamFeedProvider, boolean>; disabled?: boolean; onSaved: () => void }) {
  const [provider, setProvider] = useState<StreamFeedProvider>(feed?.provider ?? 'youtube'); const [target, setTarget] = useState('');
  const [channelId, setChannelId] = useState(feed?.channelId ?? chans[0]?.id ?? ''); const [roleId, setRoleId] = useState(feed?.roleId ?? '');
  const [template, setTemplate] = useState(feed?.template ?? ''); const [busy, setBusy] = useState(false);
  const label = feed ? t('Save') : t('Add feed');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      if (feed) { await api.guilds.patchStreamFeed(guildId, feed.id, { channelId, roleId: roleId || null, template: template.trim() || DEFAULT_STREAM_FEED_TEMPLATES[feed.provider] }); toast(t('Feed updated'), 'success'); }
      else { await api.guilds.createStreamFeed(guildId, { provider, channel: target.trim(), channelId, ...(roleId ? { roleId } : {}), ...(template.trim() ? { template: template.trim() } : {}) }); setTarget(''); setTemplate(''); toast(t('Feed added'), 'success'); }
      onSaved();
    } catch (err) { toastError(err); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="mb-4 rounded-lg bg-side p-3" aria-label={feed ? t('Edit feed') : t('New feed')}>
      <div className="flex flex-wrap items-end gap-2">
        {!feed && <label className="text-xs font-bold uppercase text-header">{t('Service')}
          <select aria-label={t('Service')} className="field mt-1 !w-auto" value={provider} onChange={(e) => setProvider(e.target.value as StreamFeedProvider)}>
            <option value="youtube">YouTube</option><option value="twitch" disabled={!providers.twitch}>{providers.twitch ? 'Twitch' : t('Twitch (not enabled on this server)')}</option>
          </select></label>}
        {!feed && <label className="min-w-[200px] flex-1 text-xs font-bold uppercase text-header">{provider === 'twitch' ? t('Twitch channel') : t('YouTube channel')}
          <input aria-label={provider === 'twitch' ? t('Twitch channel') : t('YouTube channel')} className="field mt-1" value={target} maxLength={200} onChange={(e) => setTarget(e.target.value)} placeholder={provider === 'twitch' ? 'streamer_name' : '@handle, channel URL or UC...'} /></label>}
        <label className="text-xs font-bold uppercase text-header">{t('Post in')}
          <select aria-label={t('Post in')} className="field mt-1 !w-auto" value={channelId} onChange={(e) => setChannelId(e.target.value)}>{chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></label>
        <label className="text-xs font-bold uppercase text-header">{t('Mention role')}
          <select aria-label={t('Mention role')} className="field mt-1 !w-auto" value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">{t('No mention')}</option>{roles.map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}</select></label>
      </div>
      <Field label={t('Message')} hint={t('Use {channel}, {title} and {url}. Leave empty for the default.')}>
        <textarea aria-label={t('Message')} className="field mt-1 min-h-[60px]" value={template} maxLength={MAX_STREAM_FEED_TEMPLATE} onChange={(e) => setTemplate(e.target.value)} placeholder={DEFAULT_STREAM_FEED_TEMPLATES[feed?.provider ?? provider]} />
      </Field>
      <button className="btn btn-primary" disabled={busy || !channelId || (!feed && (!target.trim() || disabled))}>{label}</button>
    </form>
  );
}
