import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api, type BanAppealItem } from '@/lib/api';
import { Avatar } from '@/components/ui/Avatar';
import { Empty, Spinner } from '@/components/ui/primitives';
import { toast, toastError } from '@/stores/ui';
import { H1 } from './SettingsLayout';
import { t } from '@/i18n';

/** Server Settings > Appeals (BAN_MEMBERS). Appeal text is only ever fetched here; approving lifts the ban. */
export function AppealsTab({ guildId }: { guildId: string }) {
  const [status, setStatus] = useState<'pending' | 'all'>('pending'); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['appeals', guildId, status], queryFn: () => api.guilds.appeals(guildId, status) });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'deny'; reason: string }) => api.guilds.decideAppeal(guildId, v.id, v.decision, v.reason),
    onSuccess: (_d, v) => { toast(v.decision === 'approve' ? t('Appeal approved, the ban was lifted') : t('Appeal denied'), 'success'); void qc.invalidateQueries({ queryKey: ['appeals', guildId] }); void qc.invalidateQueries({ queryKey: ['bans', guildId] }); },
    onError: toastError,
  });
  return (<>
    <H1>{t('Ban Appeals')}</H1>
    <div role="tablist" aria-label={t('Appeal filter')} className="mb-4 flex gap-2">
      {(['pending', 'all'] as const).map((s) => <button key={s} role="tab" aria-selected={status === s} className={`btn ${status === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStatus(s)}>{s === 'pending' ? t('Pending') : t('All')}</button>)}
    </div>
    {q.isLoading && <Spinner />}
    {q.data && !q.data.length && <Empty icon={<Inbox size={40} />} title={t('No appeals')}>{t('Banned members can appeal once per ban. Their messages appear here, visible only to moderators.')}</Empty>}
    <ul data-testid="appeal-list" className="space-y-3">{q.data?.map((a) => <AppealCard key={a.id} a={a} busy={decide.isPending} onDecide={(decision, reason) => decide.mutate({ id: a.id, decision, reason })} />)}</ul>
  </>);
}

function AppealCard({ a, busy, onDecide }: { a: BanAppealItem; busy: boolean; onDecide: (d: 'approve' | 'deny', reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <li className="rounded-lg bg-side p-4">
      <div className="mb-2 flex items-center gap-3">{a.user && <Avatar user={a.user} size={32} />}<div className="min-w-0 flex-1"><div className="font-semibold text-header">{a.user?.displayName || a.user?.username || t('Unknown user')}</div><div className="text-xs text-muted">{t('Banned for')}: {a.banReason || t('no reason given')} • {new Date(a.createdAt).toLocaleString()}</div></div>
        {a.status !== 'pending' && <span className={`rounded px-2 py-0.5 text-xs font-bold ${a.status === 'approved' ? 'bg-success text-white' : 'bg-danger text-white'}`}>{a.status === 'approved' ? t('Approved') : t('Denied')}</span>}</div>
      <p className="mb-3 whitespace-pre-wrap break-words rounded bg-rail p-3 text-sm" data-testid="appeal-message">{a.message}</p>
      {a.status === 'pending'
        ? <div className="flex flex-wrap gap-2"><input className="field !w-64" maxLength={512} placeholder={t('Reason (sent to the member)')} aria-label={t('Decision reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-primary" disabled={busy} onClick={() => onDecide('approve', reason)}>{t('Approve & Unban')}</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => onDecide('deny', reason)}>{t('Deny')}</button></div>
        : <div className="text-xs text-muted">{a.decidedBy ? `${a.decidedBy.displayName || a.decidedBy.username} • ` : ''}{a.decidedAt && new Date(a.decidedAt).toLocaleString()}{a.decisionReason ? ` • ${a.decisionReason}` : ''}</div>}
    </li>);
}
