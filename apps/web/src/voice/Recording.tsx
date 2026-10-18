import { useEffect, useRef, useState } from 'react';
import { Circle, Mic, MonitorUp, Square } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { useData } from '@/stores/data';
import { useVoiceUI } from '@/stores/voiceui';
import { myChannelPerms } from '@/lib/session';
import { cx } from '@/lib/format';
import { Tip } from '@/components/ui/Tooltip';
import { t } from '@/i18n';
import { fmtRecordingDuration } from './callRecorder';
import { isDmChannel, startCallRecording, stopCallRecording, type CallRecordingMode } from './controller';

/** Red "Recording" banner: one server-owned indicator for everyone in the call, with the elapsed timer. */
export function RecordingIndicator() {
  const channelId = useVoiceUI((s) => s.connectedChannelId);
  const recording = useData((s) => (channelId ? s.voiceRecordings[channelId] : undefined));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording?.id]);
  if (!recording) return null;
  const started = Date.parse(recording.startedAt);
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, now - started);
  return (
    <div role="status" data-testid="voice-recording" className="flex items-center justify-center gap-2 bg-danger px-3 py-1.5 text-sm font-semibold text-white">
      <span aria-hidden className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
      <span>{t('Recording')}</span>
      <span data-testid="voice-recording-timer" className="font-mono tabular-nums">{fmtRecordingDuration(elapsed)}</span>
    </div>
  );
}

/** Record control: a mode menu when idle, a stop button for the member who started the take. */
export function RecordButton() {
  const snap = useVoiceSnapshot();
  const channelId = useVoiceUI((s) => s.connectedChannelId);
  const conn = useVoiceUI((s) => s.conn);
  const me = useData((s) => s.me);
  const recording = useData((s) => (channelId ? s.voiceRecordings[channelId] : undefined));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!channelId || conn !== 'connected' || isDmChannel(channelId)) return null;
  if ((myChannelPerms(channelId) & (Perm.RECORD_VOICE | Perm.MANAGE_CHANNELS)) === 0n) return null;

  const mine = !!recording && recording.startedBy === me?.id;
  const hasScreen = snap.participants.some((p) => p.screenOn);
  const pick = async (mode: CallRecordingMode) => {
    setOpen(false); setBusy(true);
    try { await startCallRecording(channelId, mode); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await stopCallRecording(); } finally { setBusy(false); }
  };
  const label = recording ? (mine ? t('Stop Recording') : t('Recording in progress')) : t('Record');

  return (
    <div ref={box} className="relative flex items-center">
      <Tip text={label} side="top">
        <button type="button" aria-label={label} aria-pressed={!!recording} disabled={busy || (!!recording && !mine)}
          onClick={() => { if (recording) { if (mine) void stop(); } else setOpen((v) => !v); }}
          className={cx('flex h-12 w-12 items-center justify-center rounded-full transition-colors disabled:opacity-40 max-md:h-11 max-md:w-11',
            recording ? 'bg-danger text-white hover:bg-danger-hover' : open ? 'bg-white text-black hover:bg-white/90' : 'bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]')}>
          {recording && mine ? <Square size={20} fill="currentColor" /> : <Circle size={22} fill="currentColor" />}
        </button>
      </Tip>
      {open && !recording && (
        <div role="menu" aria-label={t('Recording mode')} className="absolute bottom-full start-0 z-50 mb-2 w-56 animate-pop rounded-lg bg-float p-1.5 text-start shadow-elev">
          <button role="menuitem" type="button" disabled={busy} onClick={() => void pick('audio')} className="flex w-full items-center gap-2 rounded px-2 py-2 text-sm text-header hover:bg-hover disabled:opacity-40">
            <Mic size={16} />{t('Audio only')}
          </button>
          <button role="menuitem" type="button" disabled={busy || !hasScreen} title={!hasScreen ? t('No one is sharing their screen.') : undefined}
            onClick={() => void pick('video')} className="flex w-full items-center gap-2 rounded px-2 py-2 text-sm text-header hover:bg-hover disabled:opacity-40">
            <MonitorUp size={16} />{t('Audio + screen')}
          </button>
        </div>
      )}
    </div>
  );
}
