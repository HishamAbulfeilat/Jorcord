import { HeadphoneOff, Headphones, Lock, Mic, MicOff, Unlock } from 'lucide-react';
import { cx, idColor, initials } from '@/lib/format';
import type { OverlayAction, OverlayState, OverlayToast } from '@/lib/overlay';

/** Presentational overlay card: header (channel + lock), member list with speaking rings, mute/deafen, toasts. */
export function OverlayView({ state, toasts, onAction }: { state: OverlayState; toasts: OverlayToast[]; onAction: (a: OverlayAction) => void }) {
  const muted = state.selfMuted || state.selfDeafened;
  const btn = 'flex h-8 w-8 items-center justify-center rounded';
  return (
    <div data-testid="overlay" data-active={state.active || undefined} className="pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-[rgb(var(--float)/0.92)] text-normal shadow-elev backdrop-blur">
      <div className="flex items-center gap-2 border-b border-divider/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          {state.active
            ? <><div className="truncate text-sm font-semibold text-header">{state.channel ?? 'Voice'}</div>{state.guild && <div className="truncate text-[11px] text-muted">{state.guild}</div>}</>
            : <div className="truncate text-sm font-semibold text-muted">Not connected</div>}
        </div>
        <button type="button" aria-label={state.locked ? 'Unlock overlay' : 'Lock overlay'} aria-pressed={state.locked} onClick={() => onAction('toggle-lock')}
          className={cx(btn, 'text-interactive hover:bg-hover hover:text-interactive-hover')}>{state.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
      </div>

      {state.active ? (
        <ul aria-label="Voice members" className="scroller min-h-0 flex-1 space-y-0.5 px-2 py-2">
          {state.participants.map((p) => (
            <li key={p.id} data-testid="overlay-member" data-speaking={p.speaking || undefined} className="flex items-center gap-2 rounded px-1 py-1">
              <span aria-hidden className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white', p.speaking && 'ring-2 ring-success')} style={{ background: idColor(p.id) }}>{initials(p.name)}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}{p.self && <span className="text-muted"> (you)</span>}</span>
              {p.muted && <MicOff size={14} className="shrink-0 text-danger" aria-label="Muted" />}
            </li>
          ))}
          {!state.participants.length && <li className="px-1 py-2 text-sm text-muted">Waiting for others to join…</li>}
        </ul>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted">Join a voice channel to see who is in the call.</div>
      )}

      <div className="flex items-center gap-2 border-t border-divider/60 px-2 py-2">
        <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} disabled={!state.active} onClick={() => onAction('toggle-mute')}
          className={cx(btn, muted ? 'bg-danger text-white' : 'text-interactive hover:bg-hover hover:text-interactive-hover', 'disabled:opacity-50')}>{muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
        <button type="button" aria-label={state.selfDeafened ? 'Undeafen' : 'Deafen'} aria-pressed={state.selfDeafened} disabled={!state.active} onClick={() => onAction('toggle-deafen')}
          className={cx(btn, state.selfDeafened ? 'bg-danger text-white' : 'text-interactive hover:bg-hover hover:text-interactive-hover', 'disabled:opacity-50')}>{state.selfDeafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}</button>
      </div>

      {!!toasts.length && (
        <ul aria-label="Notifications" className="space-y-1 border-t border-divider/60 px-2 py-2">
          {toasts.map((t) => (
            <li key={t.id} data-testid="overlay-toast" className="animate-slideUp rounded bg-side px-2 py-1">
              <div className="truncate text-xs font-semibold text-header">{t.author}{t.channel && <span className="font-normal text-muted"> in #{t.channel}</span>}</div>
              {!!t.text && <div className="truncate text-xs text-muted">{t.text}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
