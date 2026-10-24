import { useEffect, useState } from 'react';
import { Bell, Camera, ClipboardPaste, ExternalLink, MonitorUp, Mic, RefreshCw, ShieldAlert } from 'lucide-react';
import { Modal } from './primitives';
import { continuePrompt, settlePrompt, usePermFlow } from '@/lib/permissionFlow';
import { canOpenSettings, explainer, failureMessage, fixSteps, kindTitle, openSystemSettings, watchPermission, type MediaFailure, type PermKind } from '@/lib/permissions';
import { t } from '@/i18n';

export const KIND_ICON = { microphone: Mic, camera: Camera, screen: MonitorUp, notifications: Bell, clipboard: ClipboardPaste } as const;

/** Reusable blocked-state body: why it failed, how to fix it on this platform, Open settings (when the platform can) and Retry. */
export function BlockedHelp({ kind, failure, onRetry, busy }: { kind: PermKind; failure: MediaFailure; onRetry: () => void; busy?: boolean }) {
  const steps = failure === 'denied' ? fixSteps(kind) : [];
  const [opened, setOpened] = useState<boolean | null>(null);
  return (
    <div data-testid="perm-blocked" data-failure={failure}>
      <p className="flex items-start gap-2 text-sm text-header"><ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger" /><span>{failureMessage(kind, failure)}</span></p>
      {steps.length > 0 && <ol className="mt-3 list-decimal ps-5 text-sm text-muted">{steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {opened === false && <p className="mt-2 text-xs text-muted">{t('Jorcord could not open the settings for you. Follow the steps above.')}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {failure === 'denied' && canOpenSettings(kind) && <button type="button" className="btn btn-secondary" data-testid="perm-open-settings" onClick={() => void openSystemSettings(kind).then(setOpened)}><ExternalLink size={14} />{t('Open settings')}</button>}
        <button type="button" className="btn btn-primary" data-testid="perm-retry" disabled={busy} onClick={onRetry}><RefreshCw size={14} />{t('Retry')}</button>
      </div>
    </div>
  );
}

/** The single dialog behind ensurePermission(). Closes itself when the live permission state turns granted. */
export function PermissionHost() {
  const cur = usePermFlow((s) => s.current);
  const kind = cur?.kind; const id = cur?.id;
  useEffect(() => {
    if (!kind || id == null) return;
    return watchPermission(kind, (s) => { if (s === 'granted') settlePrompt(id, true); });
  }, [kind, id]);
  if (!cur) return null;
  const Icon = KIND_ICON[cur.kind];
  const close = () => settlePrompt(cur.id, false);
  if (cur.mode === 'explain') {
    const ex = explainer(cur.kind);
    return (
      <Modal title={ex.title} onClose={close} width={440} footer={<>
        <button type="button" className="btn btn-secondary" data-testid="perm-not-now" onClick={close}>{t('Not now')}</button>
        <button type="button" className="btn btn-primary" data-testid="perm-continue" disabled={cur.busy} onClick={() => void continuePrompt(cur.id)}>{t('Continue')}</button>
      </>}>
        <div data-testid="perm-explain" data-kind={cur.kind} className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/15 text-brand"><Icon size={28} /></span>
          <p className="text-sm text-muted">{ex.body}</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('{what} is not available', { what: kindTitle(cur.kind) })} onClose={close} width={460} footer={<button type="button" className="btn btn-secondary" onClick={close}>{t('Close')}</button>}>
      <BlockedHelp kind={cur.kind} failure={cur.failure ?? 'other'} busy={cur.busy} onRetry={() => void continuePrompt(cur.id)} />
    </Modal>
  );
}
