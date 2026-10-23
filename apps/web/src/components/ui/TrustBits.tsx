/** Small trust-and-safety presentational pieces: scam link warning on messages and the account-age hint. */
import { ShieldAlert } from 'lucide-react';
import { LINK_REASON_TEXT, accountAge, type LinkWarning } from '@jorcord/shared';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

/** Shown under a message whose link looks like a scam or phishing attempt (scored by the server). */
export function LinkWarningBanner({ warnings }: { warnings?: LinkWarning[] }) {
  if (!warnings?.length) return null;
  const worst = warnings.some((w) => w.level === 'dangerous') ? 'dangerous' : 'suspicious';
  const reasons = [...new Set(warnings.flatMap((w) => w.reasons))].map((r) => t(LINK_REASON_TEXT[r])).join('. ');
  const hosts = warnings.map((w) => w.host).join(', ');
  return (
    <div role="note" data-testid="link-warning" className={cx('mt-1 flex items-start gap-2 rounded-md border-s-4 px-3 py-2 text-sm', worst === 'dangerous' ? 'border-danger bg-danger/10' : 'border-brand bg-brand/10')}>
      <ShieldAlert size={18} className={cx('mt-0.5 shrink-0', worst === 'dangerous' ? 'text-danger' : 'text-header')} aria-hidden />
      <span className="min-w-0 text-normal">
        <strong className="text-header">{worst === 'dangerous' ? t('Likely scam link.') : t('This link looks suspicious.')}</strong>{' '}
        {t('Do not enter your password or scan QR codes on it.')} <span className="text-muted">({hosts}{reasons ? `: ${reasons}` : ''})</span>
      </span>
    </div>
  );
}

/** "New account" chip for accounts under a week old, otherwise just how old the account is. */
export function AccountAge({ createdAt, className, now }: { createdAt: string; className?: string; now?: number }) {
  const a = accountAge(createdAt, now);
  return (
    <span data-testid="account-age" className={cx('inline-flex items-center gap-1 text-xs', a.isNew ? 'font-semibold text-danger' : 'text-muted', className)} title={new Date(createdAt).toLocaleString()}>
      {a.isNew && <span className="rounded bg-danger/15 px-1.5 py-0.5 uppercase tracking-wide">{t('New account')}</span>}
      <span>{t(a.label)}</span>
    </span>
  );
}
