import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { H1, H3 } from './SettingsLayout';
import { BlockedHelp, KIND_ICON } from '@/components/ui/PermissionHost';
import { ensurePermission } from '@/lib/permissionFlow';
import { PERM_KINDS, canOpenSettings, detectEnv, kindTitle, openSystemSettings, queryPermission, watchPermission, type PermKind, type PermState } from '@/lib/permissions';
import { cx } from '@/lib/format';
import { T, t } from '@/i18n';

const STATE_LABEL: Record<PermState, string> = { granted: T('Allowed'), denied: T('Blocked'), prompt: T('Not asked yet'), unknown: T('Unknown'), unsupported: T('Not available') };
const STATE_CLASS: Record<PermState, string> = { granted: 'bg-success text-white', denied: 'bg-danger text-white', prompt: 'bg-active text-header', unknown: 'bg-active text-muted', unsupported: 'bg-active text-muted' };

function why(kind: PermKind): string {
  switch (kind) {
    case 'microphone': return t('Voice channels, calls, voice messages and clips.');
    case 'camera': return t('Video in calls and scanning a QR code to log in another device.');
    case 'screen': return t('Sharing your screen or a window in a call. Asked each time you start sharing.');
    case 'notifications': return t('Mentions, direct messages and incoming calls while Jorcord is in the background.');
    case 'clipboard': return t('Pasting invite links and codes. Copying never needs permission.');
  }
}

/** Live state of one permission (updates through the Permissions API `change` event and when the app regains focus). */
export function usePermState(kind: PermKind): [PermState | null, () => void] {
  const [state, setState] = useState<PermState | null>(null);
  const refresh = useCallback(() => { void queryPermission(kind).then(setState); }, [kind]);
  useEffect(() => { refresh(); return watchPermission(kind, setState); }, [kind, refresh]);
  return [state, refresh];
}

function PermRow({ kind }: { kind: PermKind }) {
  const [state, refresh] = usePermState(kind);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[kind];
  const env = detectEnv();
  const request = async () => { setBusy(true); try { await ensurePermission(kind); } finally { setBusy(false); refresh(); } };
  return (
    <li data-testid={`perm-row-${kind}`} data-state={state ?? 'loading'} className="border-b border-divider/50 py-3">
      <div className="flex items-center gap-3">
        <Icon size={22} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium text-header">{kindTitle(kind)}
            {state && <span data-testid={`perm-state-${kind}`} className={cx('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', STATE_CLASS[state])}>{t(STATE_LABEL[state])}</span>}
          </div>
          <div className="text-sm text-muted">{why(kind)}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {(state === 'prompt' || state === 'unknown') && kind !== 'screen' && <button type="button" className="btn btn-primary" data-testid={`perm-request-${kind}`} disabled={busy} onClick={() => void request()}>{t('Allow')}</button>}
          {state === 'denied' && <button type="button" className="btn btn-secondary" data-testid={`perm-howto-${kind}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{t('How to fix')}</button>}
          {canOpenSettings(kind, env) && state !== 'unsupported' && <button type="button" className="btn btn-secondary" data-testid={`perm-settings-${kind}`} onClick={() => void openSystemSettings(kind, env)}><ExternalLink size={14} />{t('Open settings')}</button>}
          <button type="button" className="btn btn-secondary" aria-label={t('Check again')} title={t('Check again')} onClick={refresh}><RefreshCw size={14} /></button>
        </div>
      </div>
      {state === 'denied' && open && <div className="mt-3 rounded-lg bg-side p-3"><BlockedHelp kind={kind} failure="denied" busy={busy} onRetry={() => void request()} /></div>}
    </li>
  );
}

export function PermissionsPanel() {
  const env = detectEnv();
  const kinds = PERM_KINDS.filter((k) => !(k === 'clipboard' && env.shell === 'capacitor'));
  const extras: string[] = [
    ...(env.shell === 'tauri' ? [t('Launch at login and the global push-to-talk shortcut are controlled in Desktop App settings. They do not need an operating-system permission (on Wayland the shortcut may be unavailable).')] : []),
    ...(env.shell === 'capacitor' && env.os === 'android' ? [t('During a call Android shows an ongoing-call notification so calls keep working with the screen off. Bluetooth headsets are used automatically when Android allows it.')] : []),
    ...(env.shell === 'capacitor' && env.os === 'ios' ? [t('iOS asks to find devices on your local network the first time you connect to a self-hosted server on your LAN. You can change it in Settings > Jorcord.')] : []),
  ];
  return (<>
    <H1>{t('Permissions')}</H1>
    <p className="mb-3 text-sm text-muted">{t('Jorcord only asks for access when you use a feature that needs it. Here is where each permission stands right now.')}</p>
    <ul aria-label={t('Permissions')} data-testid="permissions-list">{kinds.map((k) => <PermRow key={k} kind={k} />)}</ul>
    {extras.length > 0 && <><H3>{t('Other')}</H3>{extras.map((x) => <p key={x} className="mb-2 text-sm text-muted">{x}</p>)}</>}
  </>);
}
