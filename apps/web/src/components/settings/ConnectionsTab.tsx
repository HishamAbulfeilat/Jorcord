import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, ExternalLink, Trash2 } from 'lucide-react';
import { CONNECTION_PROVIDERS, type Connection } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Empty, Spinner, Toggle } from '@/components/ui/primitives';
import { copyText } from '@/lib/format';
import { t } from '@/i18n';

/** User Settings > Connections: links shown on your profile. Verify one by putting its code on the linked page. */
export function ConnectionsTab() {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['connections'], queryFn: () => api.users.connections() });
  const [type, setType] = useState(CONNECTION_PROVIDERS[0]!.id); const [handle, setHandle] = useState(''); const [busy, setBusy] = useState(false);
  const prov = CONNECTION_PROVIDERS.find((p) => p.id === type)!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['connections'] });
  const add = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { await api.users.addConnection({ type, handle: handle.trim() }); setHandle(''); await refresh(); toast(t('Connection added'), 'success'); } catch (err) { toastError(err); } setBusy(false); };
  const act = (p: Promise<unknown>, ok?: string) => p.then(() => { void refresh(); void qc.invalidateQueries({ queryKey: ['user'] }); if (ok) toast(ok, 'success'); }).catch(toastError);
  return (<div data-testid="connections-tab">
    <H1>{t('Connections')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Show your other accounts on your profile. A new link is unverified until you prove it is yours: put the code below on the linked page (for example in your bio), then press Verify.')}</p>
    <form onSubmit={add} className="mb-6 flex flex-wrap items-end gap-2 rounded-lg bg-side p-3">
      <label className="text-xs font-bold uppercase text-header">{t('Service')}<select aria-label={t('Service')} className="field mt-1 !w-auto" value={type} onChange={(e) => setType(e.target.value)}>{CONNECTION_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="min-w-[180px] flex-1 text-xs font-bold uppercase text-header">{prov.id === 'website' ? t('Link') : t('Username')}<input aria-label={t('Connection handle')} className="field mt-1" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={prov.example} maxLength={200} /></label>
      <button className="btn btn-primary btn-lg" disabled={busy || !handle.trim()}>{t('Add connection')}</button>
    </form>
    {q.isLoading && <Spinner />}
    {q.data && !q.data.length && <Empty title={t('No connections yet')} />}
    <ul className="space-y-2">{q.data?.map((c: Connection) => (
      <li key={c.id} className="rounded-lg bg-side p-3" data-testid="connection-row">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-header">{c.name}</span><span className="truncate text-sm text-muted">{c.handle}</span>
          {c.verified ? <span className="flex items-center gap-1 text-xs text-success"><BadgeCheck size={14} />{t('Verified')}</span> : <span className="text-xs text-muted">{t('Not verified')}</span>}
          <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${t('Open')} ${c.name}`} className="p-1 text-interactive hover:text-header"><ExternalLink size={14} /></a>
          <span className="ms-auto flex items-center gap-2 text-xs text-muted">{t('Show on profile')}<Toggle label={`${t('Show on profile')}: ${c.name}`} checked={c.visible} onChange={(v) => void act(api.users.patchConnection(c.id, { visible: v }))} /></span>
          <button aria-label={`${t('Remove')} ${c.name}`} className="p-1 text-danger" onClick={() => void act(api.users.deleteConnection(c.id))}><Trash2 size={16} /></button>
        </div>
        {!c.verified && (<div className="mt-2 flex flex-wrap items-center gap-2"><code className="rounded bg-rail px-2 py-1 text-xs" data-testid="verify-code">{c.verifyCode}</code>
          <button className="btn btn-secondary" onClick={() => void copyText(c.verifyCode).then(() => toast(t('Code copied'), 'success'))}>{t('Copy code')}</button>
          <button className="btn btn-primary" onClick={() => void act(api.users.verifyConnection(c.id), t('Verified!'))}>{t('Verify')}</button></div>)}
      </li>
    ))}</ul>
    <H3>{t('Privacy')}</H3><p className="text-sm text-muted">{t('Only connections switched on appear on your profile. Verified ones are listed first.')}</p>
  </div>);
}
