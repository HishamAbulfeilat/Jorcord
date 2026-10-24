import { useState } from 'react';
import type { Report, ReportAction, User } from '@jorcord/shared';
import { Avatar } from '@/components/ui/Avatar';
import { t } from '@/i18n';

const REASON_LABEL = { spam: 'Spam', harassment: 'Harassment', inappropriate_content: 'Inappropriate', impersonation: 'Impersonation', security: 'Security', other: 'Other' } as const;
const ACTION_LABEL: Record<ReportAction, string> = { none: 'Resolve', delete_message: 'Delete message', mark_sensitive: 'Mark sensitive', warn: 'Warn member', timeout: 'Timeout 1 hour' };

const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('Just now');
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** One case in the report queue. Media is blurred until clicked (wellbeing), duplicate reports show as a count, an anonymous reporter shows as such. */
export function ReportRow({ r, target, reporterName, channelName, handlerName, canAct, onResolve, onDismiss }: {
  r: Report; target: User | { id: string; username: string; discriminator: string; avatar: null }; reporterName: string | null; channelName: string; handlerName?: string | null;
  canAct: boolean; onResolve: (action: ReportAction) => void; onDismiss: () => void;
}) {
  const [revealed, setRevealed] = useState(false); const [action, setAction] = useState<ReportAction>('none');
  const snap = r.message; const hasMedia = !!snap && snap.attachments.length > 0; const blur = !!r.blurMedia && hasMedia && !revealed;
  const cls = (r.reason === 'spam' || r.reason === 'inappropriate_content') ? 'bg-warn/20 text-warn' : r.reason === 'harassment' ? 'bg-danger/20 text-danger' : 'bg-side text-muted';
  return (
    <li className="mb-2 rounded-lg border border-divider bg-rail p-3" data-report={r.id}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar user={target as User} size={28} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-header">{target.username}</div>
            <div className="text-xs text-muted">{channelName} • {t('by')} {r.anonymous || !reporterName ? <span data-testid="anon-reporter">{t('anonymous reporter')}</span> : reporterName}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(r.reportCount ?? 1) > 1 && <span className="rounded-full bg-active px-2 py-0.5 text-xs font-semibold text-header" data-testid="report-count">{t('{n} reports', { n: r.reportCount ?? 1 })}</span>}
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{t(REASON_LABEL[r.reason])}</span>
          {r.status !== 'open' && <span className="text-xs text-muted">{timeAgo(r.createdAt)}</span>}
        </div>
      </div>
      {r.description ? <p className="mb-2 text-sm text-muted">{r.description}</p> : null}
      {snap && (snap.content || snap.attachments.length) ? (
        <div className="mb-2 rounded border border-divider/60 bg-side/60 p-2 text-sm">
          <div className="text-xs font-semibold text-muted">{t('Reported message')}</div>
          {snap.content && <p className="mt-0.5 break-words text-header">{snap.content}</p>}
          {hasMedia && (
            <div className="relative mt-1">
              <div className={`flex flex-wrap gap-1 ${blur ? 'select-none blur-md' : ''}`} aria-hidden={blur} data-testid="report-media">{snap.attachments.map((a) => <span key={a.url} className="text-xs text-muted">{a.filename}</span>)}</div>
              {blur && <button type="button" className="absolute inset-0 text-xs font-semibold text-header" data-testid="reveal-media" onClick={() => setRevealed(true)}>{t('Click to show media')}</button>}
            </div>)}
        </div>
      ) : null}
      {r.status === 'open' ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select className="field !min-h-[30px] !w-auto !py-0 text-xs" aria-label={t('Action when resolving')} value={action} onChange={(e) => setAction(e.target.value as ReportAction)}>
            {(Object.keys(ACTION_LABEL) as ReportAction[]).map((a) => <option key={a} value={a}>{a === 'none' ? t('No action') : t(ACTION_LABEL[a])}</option>)}</select>
          <button className="btn btn-sm btn-primary" disabled={!canAct} onClick={() => onResolve(action)} type="button">{t('Resolve')}</button>
          <button className="btn btn-sm btn-secondary" disabled={!canAct} onClick={onDismiss} type="button">{t('Dismiss')}</button>
        </div>
      ) : (
        <div className="text-xs text-muted">{r.actionTaken ? `${t(ACTION_LABEL[r.actionTaken as ReportAction] ?? r.actionTaken)} • ` : ''}{t('Handled by')} {handlerName ?? r.handledBy}</div>
      )}
    </li>
  );
}
