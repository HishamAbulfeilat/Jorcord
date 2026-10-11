import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { Modal, Spinner } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/Avatar';
import { displayName, fmtStamp } from '@/lib/format';
import { ageText, flagInfo, historyLabel } from '@/lib/modtools';
import { t } from '@/i18n';

/** Mod View: everything a moderator wants to know about a member before acting. Opened from the member menu and profile card. */
export function ModViewModal({ guildId, userId, close }: { guildId: string; userId: string; close: () => void }) {
  const qc = useQueryClient(); const users = useData((s) => s.users); const me = useData((s) => s.me);
  const q = useQuery({ queryKey: ['mod-view', guildId, userId], queryFn: () => api.guilds.modView(guildId, userId), retry: false });
  const [warn, setWarn] = useState(''); const [note, setNote] = useState(''); const [showMsgs, setShowMsgs] = useState(false);
  const msgs = useQuery({ queryKey: ['mod-view-msgs', guildId, userId], enabled: showMsgs, queryFn: () => api.guilds.search(guildId, { authorId: userId, limit: 10 } as never) });
  const v = q.data; const refetch = () => qc.invalidateQueries({ queryKey: ['mod-view', guildId, userId] });
  const nameOf = (id: string | null) => (id ? users[id]?.username ?? id : t('AutoMod'));
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => { void refetch(); if (ok) toast(ok, 'success'); }).catch(toastError);
  return (<Modal title={t('Mod View')} onClose={close} width={560}><div data-testid="mod-view">
    {q.isLoading && <Spinner />}{q.isError && <p className="text-sm text-danger">{t('You cannot view this member.')}</p>}
    {v && <>
      <div className="mb-3 flex items-center gap-3"><Avatar user={v.user} size={48} /><div className="min-w-0"><div className="truncate font-bold text-header">{displayName(v.user)}</div><div className="text-xs text-muted">@{v.user.username} • {v.user.id}</div></div>
        {v.banned && <span className="ms-auto rounded bg-danger px-2 py-0.5 text-xs font-bold text-white">{t('Banned')}</span>}{!v.isMember && !v.banned && <span className="ms-auto rounded bg-hover px-2 py-0.5 text-xs text-muted">{t('Not in server')}</span>}</div>
      {v.flags.length > 0 && <ul aria-label={t('Safety flags')} className="mb-3 flex flex-wrap gap-1.5" data-testid="safety-flags">{v.flags.map((f) => <li key={f} title={t(flagInfo(f).hint)} className="rounded-full bg-warn/20 px-2.5 py-0.5 text-xs font-semibold text-warn">{t(flagInfo(f).label)}</li>)}</ul>}
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t('Account created')}</dt><dd className="text-header">{fmtStamp(new Date(v.accountCreatedAt).getTime())} ({ageText(v.accountCreatedAt)})</dd>
        <dt className="text-muted">{t('Joined server')}</dt><dd className="text-header">{v.joinedAt ? `${fmtStamp(new Date(v.joinedAt).getTime())} (${ageText(v.joinedAt)})` : '—'}</dd>
        <dt className="text-muted">{t('Messages (7 days)')}</dt><dd className="text-header">{v.messages7d}</dd>
        <dt className="text-muted">{t('Mutual servers')}</dt><dd className="text-header">{v.mutualGuilds.map((g) => g.name).join(', ') || '—'}</dd>
        {v.timeoutUntil && <><dt className="text-muted">{t('Timed out until')}</dt><dd className="text-header">{fmtStamp(new Date(v.timeoutUntil).getTime())}</dd></>}
      </dl>
      <div className="mb-4 grid grid-cols-4 gap-2 text-center" data-testid="mod-counts">{([['Warnings', v.counts.warnings], ['Timeouts', v.counts.timeouts], ['Kicks', v.counts.kicks], ['Bans', v.counts.bans]] as const).map(([l, n]) => <div key={l} className="rounded bg-side p-2"><div className="text-lg font-bold text-header">{n}</div><div className="text-xs text-muted">{t(l)}</div></div>)}</div>

      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{t('Warnings')}</h3>
      <ul className="mb-2" data-testid="mod-warnings">{v.warnings.map((w) => <li key={w.id} className="flex items-start gap-2 border-b border-divider/50 py-1.5 text-sm"><span className="min-w-0 flex-1 text-header">{w.reason}<span className="block text-xs text-muted">{nameOf(w.moderatorId)} • {fmtStamp(new Date(w.createdAt).getTime())}</span></span>
        <button aria-label={t('Remove warning')} className="p-1 text-danger" onClick={() => run(api.guilds.deleteWarning(guildId, w.id))}><Trash2 size={14} /></button></li>)}{!v.warnings.length && <li className="text-sm text-muted">{t('No warnings')}</li>}</ul>
      {v.isMember && v.user.id !== me?.id && <div className="mb-4 flex gap-2"><input className="field" aria-label={t('Warning reason')} maxLength={500} placeholder={t('Reason for the warning')} value={warn} onChange={(e) => setWarn(e.target.value)} />
        <button className="btn btn-primary shrink-0" disabled={!warn.trim()} onClick={() => run(api.guilds.warn(guildId, userId, warn.trim()).then(() => setWarn('')), t('Warning added'))}>{t('Warn')}</button></div>}

      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{t('Mod notes')} <span className="font-normal normal-case">({t('visible to moderators only')})</span></h3>
      <ul className="mb-2" data-testid="mod-notes">{v.notes.map((n) => <li key={n.id} className="flex items-start gap-2 border-b border-divider/50 py-1.5 text-sm"><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-header">{n.note}<span className="block text-xs text-muted">{nameOf(n.authorId)} • {fmtStamp(new Date(n.createdAt).getTime())}</span></span>
        <button aria-label={t('Delete note')} className="p-1 text-danger" onClick={() => run(api.guilds.deleteModNote(guildId, n.id))}><Trash2 size={14} /></button></li>)}{!v.notes.length && <li className="text-sm text-muted">{t('No notes')}</li>}</ul>
      <div className="mb-4 flex gap-2"><input className="field" aria-label={t('New note')} maxLength={1000} placeholder={t('Add a note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-secondary shrink-0" disabled={!note.trim()} onClick={() => run(api.guilds.addModNote(guildId, userId, note.trim()).then(() => setNote('')))}>{t('Add Note')}</button></div>

      {v.history.length > 0 && <><h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{t('History')}</h3>
        <ul className="mb-4 text-sm" data-testid="mod-history">{v.history.slice(0, 10).map((h, i) => <li key={i} className="flex gap-2 py-0.5"><span className="font-semibold text-header">{t(historyLabel(h.action))}</span><span className="text-muted">{nameOf(h.moderatorId)} • {fmtStamp(new Date(h.createdAt).getTime())}{h.reason ? ` • ${h.reason}` : ''}</span></li>)}</ul></>}

      <button className="btn btn-secondary mb-2" aria-expanded={showMsgs} onClick={() => setShowMsgs((x) => !x)}>{showMsgs ? t('Hide recent messages') : t('Recent messages')}</button>
      {showMsgs && <ul className="mb-3 text-sm" data-testid="mod-messages">{msgs.isLoading && <Spinner />}{msgs.data?.map((m) => <li key={m.id} className="border-b border-divider/50 py-1"><span className="text-xs text-muted">{fmtStamp(new Date(m.createdAt).getTime())}</span> <span className="break-words text-header">{m.content.slice(0, 200) || t('(attachment)')}</span></li>)}{msgs.data?.length === 0 && <li className="text-muted">{t('No messages you can see')}</li>}</ul>}
    </>}
    <div className="mt-3 flex justify-end"><button className="btn btn-secondary" onClick={close}>{t('Close')}</button></div>
  </div></Modal>);
}
