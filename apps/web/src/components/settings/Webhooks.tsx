import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { toast, toastError, useUI } from '@/stores/ui';
import { Empty, Spinner } from '@/components/ui/primitives';
import { IconPicker } from '@/components/modals/ModalHost';
import { Avatar } from '@/components/ui/Avatar';
import { apiBase } from '@/lib/server';
import { copyText } from '@/lib/format';
import { useStreamer } from '@/lib/streamer';
import { t } from '@/i18n';

export const webhookUrl = (w: { id: string; token?: string }) => `${apiBase().replace(/^\//, location.origin + '/')}/webhooks/${w.id}/${w.token ?? ''}`;

/** Create / copy / delete the webhooks of one channel (needs MANAGE_WEBHOOKS; the API already enforces it). */
export function WebhooksList({ channelId }: { channelId: string }) {
  const qc = useQueryClient(); const key = ['webhooks', channelId]; const streamer = useStreamer();
  const q = useQuery({ queryKey: key, queryFn: () => api.channels.webhooks(channelId), retry: false });
  const [name, setName] = useState(''); const [avatar, setAvatar] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return; setBusy(true);
    try { await api.channels.createWebhook(channelId, name.trim(), avatar); setName(''); setAvatar(null); await qc.invalidateQueries({ queryKey: key }); toast(t('Webhook created'), 'success'); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg bg-side p-3">
        <div><span className="label">{t('Avatar')}</span><IconPicker value={avatar} onChange={setAvatar} size={48} label={t('Avatar')} /></div>
        <div className="min-w-[160px] flex-1"><span className="label">{t('Webhook name')}</span><input className="field" aria-label={t('Webhook name')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('Captain Hook')} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} /></div>
        <button className="btn btn-primary btn-lg" disabled={!name.trim() || busy} onClick={create}>{t('New Webhook')}</button>
      </div>
      {q.isLoading && <Spinner />}
      {q.isError && <p className="text-sm text-muted">{t('You need the Manage Webhooks permission to view webhooks here.')}</p>}
      {q.data && !q.data.length && <Empty icon={<WebhookIcon size={40} />} title={t('No webhooks yet')} />}
      <ul>{q.data?.map((w: any) => (
        <li key={w.id} data-webhook={w.id} className="flex items-center gap-3 border-b border-divider/50 py-3">
          <Avatar user={{ id: w.id, username: w.name, displayName: w.name, avatar: w.avatar }} size={36} />
          <div className="min-w-0 flex-1"><div className="truncate font-semibold text-header">{w.name}</div><div className={`truncate font-mono text-xs text-muted ${streamer.hideInvites ? 'blur-sm select-none' : ''}`}>{webhookUrl(w)}</div></div>
          <button className="btn btn-secondary" onClick={() => copyText(webhookUrl(w)).then(() => toast(t('Webhook URL copied'), 'success'))}><Copy size={14} />{t('Copy URL')}</button>
          <button aria-label={t('Delete {name}', { name: w.name })} className="p-2 text-danger" onClick={() => useUI.getState().openModal({ kind: 'confirm', title: t('Delete Webhook'), body: t('Delete the webhook "{name}"? Services using it will stop working.', { name: w.name }), confirmLabel: t('Delete'), danger: true, onConfirm: () => api.channels.deleteWebhook(channelId, w.id).then(() => qc.invalidateQueries({ queryKey: key })).catch(toastError) })}><Trash2 size={16} /></button>
        </li>))}</ul>
    </div>
  );
}
