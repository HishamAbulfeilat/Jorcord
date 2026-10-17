import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCopy, Loader2, RefreshCw, Stethoscope, X, XCircle } from 'lucide-react';
import { formatDiagnostics, runDiagnostics, type DiagCheck } from '@jorcord/voice';
import { useVoiceClient, useVoiceSnapshot } from '@jorcord/voice/react';
import { useUI } from '@/stores/ui';
import { useVoiceUI, type VoiceFailure } from '@/stores/voiceui';
import { cx } from '@/lib/format';
import { t } from '@/i18n';
import { retryVoice } from './controller';

/** Generic checklist per failure code, shown under the specific hint. */
const CHECKLIST: Record<string, string[]> = {
  'signal-unreachable': ['Is the livekit container running? (docker compose ps)', 'Is LIVEKIT_URL reachable from this browser? Use LIVEKIT_URL=auto to route signalling through the app port.', 'Does a VPN, proxy or ad blocker block WebSockets?'],
  'ice-failed': ['Set LIVEKIT_NODE_IP to the address your browser reaches the host at (127.0.0.1 for localhost).', 'Publish UDP 50000-50200 and TCP 7881 (or the single UDP port) and allow them in the firewall.', 'On strict networks enable TURN/TLS (see docs/DEPLOY.md).'],
  timeout: ['Is the livekit container healthy? (docker compose logs livekit)', 'Is the machine under heavy load or is the network very slow?'],
  'insecure-context': ['Open the app via https:// or http://localhost:3000.'],
  'permission-denied': ['Allow the microphone for this site in the browser, then press Retry.'],
  token: ['Do you have the Connect permission for this channel?', 'Reload the page to refresh your session.'],
};

export function useDiagnostics(signalUrl: string | null | undefined) {
  const [checks, setChecks] = useState<DiagCheck[] | null>(null); const [busy, setBusy] = useState(false);
  const run = useCallback(async () => { setBusy(true); try { setChecks(await runDiagnostics({ signalUrl })); } finally { setBusy(false); } }, [signalUrl]);
  return { checks, busy, run };
}

const ICON = { ok: <CheckCircle2 size={14} className="text-success" />, warn: <AlertTriangle size={14} className="text-warn" />, fail: <XCircle size={14} className="text-danger" /> };

export function CheckList({ checks }: { checks: DiagCheck[] }) {
  return (
    <ul className="grid gap-1.5 text-start text-xs" aria-label={t('Diagnostics results')}>
      {checks.map((c) => <li key={c.id} data-status={c.status} className="flex gap-2"><span className="mt-0.5 shrink-0">{ICON[c.status]}</span><span><b className="text-header">{c.label}</b> <span className="text-muted">{c.detail}</span></span></li>)}
    </ul>
  );
}

/** Join failed / session lost: the real reason, what to check, Retry and a built-in self-test. */
export function TroubleshootPanel({ failure }: { failure: VoiceFailure }) {
  const snap = useVoiceSnapshot(); const toast = useUI((s) => s.toast);
  const { checks, busy, run } = useDiagnostics(snap.serverUrl);
  const [open, setOpen] = useState(false);
  const list = CHECKLIST[failure.code] ?? ['Check that the voice service is running, then retry.'];
  return (
    <div role="alert" data-testid="voice-troubleshoot" data-code={failure.code} className="w-full max-w-lg rounded-lg border border-danger/40 bg-side p-4 text-start">
      <div className="flex items-start gap-2 text-sm font-semibold text-header"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" /><span>{t("Couldn't connect to voice")}<span className="mt-0.5 block text-[13px] font-normal text-muted">{failure.message}</span></span></div>
      {failure.hint && <p className="mt-2 text-[13px] text-interactive">{failure.hint}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => retryVoice()}><RefreshCw size={14} />{t('Retry')}</button>
        <button className="btn btn-secondary" aria-expanded={open} onClick={() => { setOpen((v) => !v); if (!checks) void run(); }}><Stethoscope size={14} />{t('Troubleshoot')}</button>
      </div>
      {open && (
        <div data-testid="voice-troubleshoot-details" className="mt-3 grid gap-3 border-t border-divider pt-3">
          <ul className="list-disc ps-5 text-xs text-muted">{list.map((x) => <li key={x}>{t(x)}</li>)}</ul>
          {busy && !checks ? <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" />{t('Running checks…')}</div> : checks && <CheckList checks={checks} />}
          <div className="flex gap-2">
            <button className="btn btn-secondary" disabled={busy} onClick={() => void run()}>{t('Run checks again')}</button>
            {checks && <button className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText(formatDiagnostics(checks, { error: `${failure.code}: ${failure.message}`, signalling: snap.serverUrl, page: location.origin })).then(() => toast(t('Copied'), 'info')); }}><ClipboardCopy size={14} />{t('Copy report')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

const fmtMs = (v: number | null | undefined) => (v == null ? '-' : `${v} ms`);
const fmtLoss = (v: number | null | undefined) => (v == null ? '-' : `${v}%`);
const PATH: Record<string, string> = { udp: 'UDP (direct)', tcp: 'TCP (fallback)', relay: 'TURN relay' };

/** Live session details + self-test ("Open diagnostics"). */
export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const snap = useVoiceSnapshot(); const client = useVoiceClient(); const toast = useUI((s) => s.toast);
  const { checks, busy, run } = useDiagnostics(snap.serverUrl);
  useEffect(() => { void run(); }, [run]);
  const c = snap.connection;
  const rows: [string, string][] = [
    ['Status', snap.status === 'reconnecting' ? `reconnecting (${snap.reconnect.phase}, attempt ${snap.reconnect.attempt}/${snap.reconnect.maxAttempts})` : snap.status],
    ['Ping', fmtMs(c?.rttMs)], ['Packet loss', fmtLoss(c?.packetLossPct)], ['Media path', c?.transport ? PATH[c.transport]! : '-'],
    ['Local candidate', c?.localCandidate ?? '-'], ['Remote candidate', c?.remoteCandidate ?? '-'],
    ['Bitrate in / out', c ? `${c.bitrateInKbps} / ${c.bitrateOutKbps} kbps` : '-'],
    ['Signalling', snap.serverUrl ?? '-'], ['LiveKit', snap.serverVersion ?? '-'], ['Page', location.origin],
  ];
  return (
    <div role="dialog" aria-label={t('Voice diagnostics')} data-testid="voice-diagnostics" className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[70vh] overflow-y-auto rounded-lg border border-divider bg-side p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold text-header">{t('Voice diagnostics')}</h3><button aria-label={t('Close')} onClick={onClose} className="text-interactive hover:text-interactive-hover"><X size={16} /></button></div>
      <dl className="grid gap-0.5 font-mono text-[11px]">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="m-0 break-all text-end text-header">{v}</dd></div>)}</dl>
      {snap.error && <p className="mt-2 text-xs text-danger">{snap.error.message}</p>}
      <div className="mt-3 border-t border-divider pt-2">{busy && !checks ? <Loader2 size={14} className="animate-spin text-muted" /> : checks && <CheckList checks={checks} />}</div>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-secondary" disabled={busy} onClick={() => void run()}>{t('Run checks again')}</button>
        <button className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText(formatDiagnostics(checks ?? [], Object.fromEntries(rows))).then(() => toast(t('Copied'), 'info')); }}><ClipboardCopy size={14} />{t('Copy report')}</button>
        {snap.status !== 'connected' && snap.status !== 'idle' && <button className="btn btn-secondary" onClick={() => client.retry()}>{t('Retry now')}</button>}
      </div>
    </div>
  );
}

/** Discord-style "Voice Connected" details: ping, packet loss, media path, Disconnect and Open diagnostics. */
export function ConnectionPopover({ onDisconnect, onDiagnostics, onClose }: { onDisconnect: () => void; onDiagnostics: () => void; onClose: () => void }) {
  const snap = useVoiceSnapshot(); const c = snap.connection;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const bad = (c?.packetLossPct ?? 0) > 5 || (c?.rttMs ?? 0) > 300;
  return (
    <div role="dialog" aria-label={t('Connection details')} data-testid="voice-conn-popover" className="absolute inset-x-1 bottom-full z-30 mb-1 rounded-lg border border-divider bg-side p-3 shadow-xl">
      <div className={cx('text-sm font-bold', snap.status === 'connected' ? (bad ? 'text-warn' : 'text-success') : 'text-warn')}>{snap.status === 'connected' ? t('Voice Connected') : snap.status === 'reconnecting' ? t('Reconnecting…') : t('Connecting…')}</div>
      <dl className="mt-2 grid gap-1 text-xs">
        <div className="flex justify-between"><dt className="text-muted">{t('Ping')}</dt><dd data-testid="voice-ping" className="m-0 text-header">{fmtMs(c?.rttMs)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">{t('Packet loss')}</dt><dd data-testid="voice-loss" className="m-0 text-header">{fmtLoss(c?.packetLossPct)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">{t('Media path')}</dt><dd className="m-0 text-header">{c?.transport ? PATH[c.transport] : '-'}</dd></div>
      </dl>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-secondary flex-1" onClick={onDiagnostics}>{t('Open diagnostics')}</button>
        <button className="btn btn-danger flex-1" onClick={onDisconnect}>{t('Disconnect')}</button>
      </div>
    </div>
  );
}

export function useConnectingElapsed() {
  const since = useVoiceUI((s) => s.connectingSince); const [now, setNow] = useState(Date.now());
  useEffect(() => { if (since == null) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [since]);
  return since == null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}
