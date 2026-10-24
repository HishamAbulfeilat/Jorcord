import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, ScrollText, Search } from 'lucide-react';
import { snowflakeTime, type AuditEntry, type AuditQuery } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { Avatar } from '@/components/ui/Avatar';
import { Empty, Spinner } from '@/components/ui/primitives';
import { H1 } from '@/components/settings/SettingsLayout';
import { displayName, fmtStamp } from '@/lib/format';
import { AUDIT_FILTER_GROUPS, actionLabel, entryDetail, entryType } from '@/lib/audit';
import { diffLines } from '@/lib/auditDiff';
import { t } from '@/i18n';

const PAGE = 50;
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

/** Server Settings > Audit Log: filter by actor / action / target / dates / text, expand an entry for its before/after, export the same filter as CSV. */
export function AuditLogView({ guildId }: { guildId: string }) {
  const users = useData((s) => s.users); const g = useData((s) => s.guilds[guildId]);
  const members = useMemo(() => Object.values(g?.members ?? {}), [g?.members]);
  const [form, setForm] = useState({ type: '', actorId: '', targetId: '', from: '', to: '', q: '' });
  const [applied, setApplied] = useState(form);
  const [open, setOpen] = useState<Record<string, boolean>>({}); const [busy, setBusy] = useState(false);
  const query = (f: typeof form): AuditQuery => ({
    ...(f.type ? { actionType: Number(f.type) } : {}), ...(f.actorId ? { actorId: f.actorId } : {}), ...(f.targetId ? { targetId: f.targetId } : {}),
    ...(f.from ? { from: dayStart(f.from) } : {}), ...(f.to ? { to: dayEnd(f.to) } : {}), ...(f.q.trim() ? { q: f.q.trim() } : {}),
  });
  const q = useInfiniteQuery({
    queryKey: ['audit', guildId, applied], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.guilds.auditLogs(guildId, { limit: PAGE, ...query(applied), ...(pageParam ? { before: pageParam } : {}) }),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  const roleName = (id: string) => g?.roles[id]?.name ?? id;
  const who = (id: string) => (users[id] ? displayName(users[id]) : id === 'anonymous' ? t('Anonymous reporter') : id);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const csv = await api.guilds.auditCsv(guildId, query(applied));
      const url = URL.createObjectURL(new Blob([typeof csv === 'string' ? csv : ''], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = `audit-log-${guildId}.csv`; a.click(); URL.revokeObjectURL(url);
      toast(t('Audit log exported'), 'success');
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const person = (key: 'actorId' | 'targetId', label: string) => (
    <select className="field !w-auto" aria-label={label} value={form[key]} onChange={(e) => set({ [key]: e.target.value })}>
      <option value="">{label}</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{displayName(m.user, m)}</option>)}
    </select>);
  return (<div data-testid="audit-log">
    <H1>{t('Audit Log')}</H1>
    <form className="mb-4 flex flex-wrap items-center gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setApplied(form); setOpen({}); }}>
      <select className="field !w-auto" aria-label={t('Filter by action')} value={form.type} onChange={(e) => set({ type: e.target.value })}>
        <option value="">{t('All actions')}</option>
        {AUDIT_FILTER_GROUPS.map((gr) => <optgroup key={gr.title} label={gr.title}>{gr.items.map((a) => <option key={a.value} value={a.type}>{a.label}</option>)}</optgroup>)}
      </select>
      {person('actorId', t('Any moderator'))}{person('targetId', t('Any target'))}
      <input className="field !w-auto" type="date" aria-label={t('From date')} value={form.from} onChange={(e) => set({ from: e.target.value })} />
      <input className="field !w-auto" type="date" aria-label={t('To date')} value={form.to} onChange={(e) => set({ to: e.target.value })} />
      <input className="field !w-48" type="search" aria-label={t('Search reasons and changes')} placeholder={t('Search reasons and changes')} maxLength={100} value={form.q} onChange={(e) => set({ q: e.target.value })} />
      <button className="btn btn-primary" type="submit"><Search size={14} className="me-1 inline" />{t('Search')}</button>
      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void exportCsv()}><Download size={14} className="me-1 inline" />{t('Export CSV')}</button>
    </form>
    {q.isLoading && <Spinner />}
    {q.data && rows.length === 0 && <Empty icon={<ScrollText size={40} />} title={t('No entries')} />}
    <ul>{rows.map((e) => <Entry key={e.id} e={e} who={who} roleName={roleName} actor={users[e.actorId]} target={users[e.targetId ?? '']} open={!!open[e.id]} toggle={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))} />)}</ul>
    {q.hasNextPage && <div className="mt-3 text-center"><button className="btn btn-secondary" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? t('Loading') : t('Load more')}</button></div>}
  </div>);
}

function Entry({ e, who, roleName, actor, target, open, toggle }: { e: AuditEntry; who: (id: string) => string; roleName: (id: string) => string; actor?: import('@jorcord/shared').User; target?: import('@jorcord/shared').User; open: boolean; toggle: () => void }) {
  const lines = diffLines(e, roleName); const detail = entryDetail(e);
  const expandable = lines.length > 0 || (e.changes != null && typeof e.changes === 'object');
  return (
    <li data-action={e.action} data-action-type={entryType(e)} className="border-b border-divider/50 py-3 text-sm">
      <div className="flex items-start gap-3">
        {actor ? <Avatar user={actor} size={32} /> : <span className="h-8 w-8 shrink-0 rounded-full bg-active" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div><b className="text-header">{who(e.actorId)}</b> <span className="text-muted">{actionLabel(e.action)}</span>{e.targetId && target && <span className="text-muted"> • {displayName(target)}</span>}</div>
          {detail && <div className="truncate text-xs text-muted">{detail}</div>}
          {e.reason && <div className="text-xs text-muted">{t('Reason')}: {e.reason}</div>}
          <div className="text-xs text-muted">{fmtStamp(new Date(e.createdAt || snowflakeTime(e.id)).getTime())}</div>
        </div>
        {expandable && <button className="btn btn-secondary !px-2" aria-expanded={open} aria-label={open ? t('Hide details') : t('Show details')} onClick={toggle}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
      </div>
      {open && (
        <div className="ms-11 mt-2 rounded bg-side p-3 text-xs" data-testid="audit-diff">
          {lines.length > 0 ? (
            <table className="w-full"><tbody>{lines.map((l) => (
              <tr key={l.field} className="align-top">
                <th scope="row" className="w-36 pe-3 text-left font-semibold text-header">{l.field}</th>
                <td>{l.added || l.removed ? (<>
                  {l.added?.map((n) => <span key={`+${n}`} className="me-1 inline-block rounded bg-success/20 px-1.5 py-0.5 text-success">+ {n}</span>)}
                  {l.removed?.map((n) => <span key={`-${n}`} className="me-1 inline-block rounded bg-danger/20 px-1.5 py-0.5 text-danger">- {n}</span>)}
                  {!l.added?.length && !l.removed?.length && <span className="text-muted">{t('No change')}</span>}
                </>) : (<>
                  <span className="text-danger line-through decoration-danger/40" data-testid="diff-before">{l.before ?? t('none')}</span><span className="px-1 text-muted">&rarr;</span><span className="text-success" data-testid="diff-after">{l.after ?? t('none')}</span>
                </>)}</td>
              </tr>))}</tbody></table>
          ) : <pre className="whitespace-pre-wrap break-words text-muted" data-testid="audit-changes">{JSON.stringify(e.changes, null, 2)}</pre>}
        </div>)}
    </li>);
}
