import { useMemo } from 'react';
import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, Crown, Hand, Loader2, Mic, MonitorUp, Volume2 } from 'lucide-react';
import { useAudioUnlock, useVoiceClient, useVoiceSnapshot } from '@jorcord/voice/react';
import type { ParticipantView } from '@jorcord/voice';
import { useUI } from '@/stores/ui';
import { useData } from '@/stores/data';
import { api } from '@/lib/api';
import { Perm } from '@jorcord/shared';
import { myChannelPerms } from '@/lib/session';
import { useVoiceUI } from '@/stores/voiceui';
import { useIsMobile } from '@/lib/hooks';
import { cx } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { NetBars, ParticipantTile, ScreenTile } from './tiles';
import { TroubleshootPanel } from './Troubleshoot';
import { retryVoice, startScreenShare } from './controller';
import { RecordingIndicator } from './Recording';
import { RaiseHand, StageBlockedList, StageHands, useStageBlocks, useStageQueue } from './StageQueue';
import type { VoiceFailure } from '@/stores/voiceui';
import { t } from '@/i18n';

/** "Reconnecting…" with spinner, attempt count and a live countdown to the next try (Retry now skips the wait). */
function ReconnectBanner() {
  const snap = useVoiceSnapshot(); const { phase, attempt, maxAttempts, nextRetryAt } = snap.reconnect;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (phase !== 'waiting') return; const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, [phase]);
  const secs = phase === 'waiting' && nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  return (
    <div role="status" data-testid="voice-reconnecting" data-phase={phase} data-attempt={attempt} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warn px-3 py-1 text-sm font-semibold text-black">
      <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{t('Reconnecting to voice…')}</span>
      {attempt > 0 && <span className="text-xs font-medium">{`${t('Attempt')} ${attempt}/${maxAttempts}`}{secs > 0 ? ` · ${t('retrying in')} ${secs}s` : ''}</span>}
      {phase !== 'resuming' && <button className="rounded bg-black/20 px-2 py-0.5 text-xs font-semibold hover:bg-black/30" onClick={() => retryVoice()}>{t('Retry now')}</button>}
      {snap.error && phase !== 'resuming' && <span className="basis-full text-center text-[11px] font-normal">{snap.error.message}</span>}
    </div>
  );
}

/** While a priority speaker talks the other voices are ducked for everyone else: say so, so the quieter room is not mistaken for a fault. */
function PriorityBanner() {
  const snap = useVoiceSnapshot();
  const talker = snap.participants.find((p) => p.priority && p.speaking);
  if (!talker) return null;
  return (
    <div role="status" data-testid="priority-ducking" className="flex items-center justify-center gap-2 bg-warn px-3 py-1 text-sm font-semibold text-black">
      <Crown size={14} aria-hidden />{talker.isLocal ? t('You are speaking with priority: others are quieter for everyone else.') : `${talker.name} ${t('is speaking with priority: other voices are quieter.')}`}
    </div>
  );
}

export function VoiceBanners() {
  const snap = useVoiceSnapshot(); const client = useVoiceClient(); const { blocked, unlock } = useAudioUnlock();
  const reconnecting = snap.status === 'reconnecting';
  return (
    <>
      <RecordingIndicator />
      <PriorityBanner />
      {reconnecting && <ReconnectBanner />}
      {snap.screenResumeNeeded && snap.status === 'connected' && (
        <div role="status" data-testid="voice-screen-resume" className="flex items-center justify-center gap-3 bg-brand/90 px-3 py-1.5 text-sm text-white">
          <MonitorUp size={16} />{t('Your screen share stopped when the connection dropped.')}
          <button className="rounded bg-black/30 px-2 py-0.5 font-medium hover:bg-black/50" onClick={() => void startScreenShare({ preset: snap.settings.screenPreset, hint: snap.settings.screenHint, audio: snap.settings.screenAudio })}>{t('Resume sharing')}</button>
          <button className="rounded px-2 py-0.5 font-medium hover:bg-black/30" onClick={() => client.dismissScreenResume()}>{t('Dismiss')}</button>
        </div>
      )}
      {blocked && snap.status === 'connected' && <button onClick={unlock} className="bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-hover">{t('Click to enable audio')}</button>}
      {snap.error && !reconnecting && (
        <div role="alert" data-code={snap.error.code} className="flex items-center justify-between gap-3 bg-danger/90 px-3 py-2 text-sm text-white">
          <span className="flex items-center gap-2"><AlertTriangle size={16} />{snap.error.message}</span>
          <button className="rounded bg-black/30 px-2 py-0.5 font-medium hover:bg-black/50" onClick={() => client.clearError()}>{t('Dismiss')}</button>
        </div>
      )}
    </>
  );
}

function gridCols(n: number, mobile: boolean) {
  if (mobile) return n <= 1 ? 1 : 2;
  return n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

/** Connection quality / ping strip, shown above the call while "Show Connection Stats" is on. */
export function ConnectionStatus() {
  const snap = useVoiceSnapshot(); const c = snap.connection;
  const me = snap.participants.find((p) => p.isLocal);
  return (
    <div data-testid="connection-status" role="status" className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-side px-3 py-1 text-xs text-muted">
      <NetBars quality={me?.quality ?? 'unknown'} />
      <span>{c?.rttMs != null ? `${c.rttMs} ms` : t('Measuring…')}</span>
      {!!c?.packetLossPct && <span>{c.packetLossPct}% {t('loss')}</span>}
    </div>
  );
}

/** The call surface: participant grid, or a spotlighted stream with a filmstrip. */
import { CaptionsOverlay } from './Captions';

export function CallSurface(props: { compact?: boolean; tall?: boolean }) {
  const showStats = useUI((s) => s.prefs.showVoiceStats);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showStats && <ConnectionStatus />}
      <CallSurfaceBody {...props} />
      <CaptionsOverlay />
    </div>
  );
}

function CallSurfaceBody({ compact, tall }: { compact?: boolean; tall?: boolean }) {
  const snap = useVoiceSnapshot(); const mobile = useIsMobile();
  const focus = useVoiceUI((s) => s.focus); const setFocus = useVoiceUI((s) => s.setFocus);
  const showStats = useUI((s) => s.prefs.showVoiceStats);
  const people = useMemo(() => [...snap.participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name)), [snap.participants]);
  const streams = people.filter((p) => p.screenOn);
  const validFocus = focus && people.some((p) => (focus === `${p.identity}:screen` && p.screenOn) || focus === `${p.identity}:camera`) ? focus : null;
  const mainKey = validFocus ?? (streams.length ? `${(streams.find((s) => !s.isLocal) ?? streams[0]).identity}:screen` : null);

  if (!mainKey) {
    const cols = compact ? Math.min(people.length, 3) || 1 : gridCols(people.length, mobile);
    return (
      <div data-testid="call-grid" className={cx('grid min-h-0 flex-1 auto-rows-fr gap-2 p-3', compact && 'p-2')} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {people.map((p) => <div key={p.identity} className={cx('min-h-0', !tall && !compact && cols === 1 && 'mx-auto w-full max-w-3xl')}><ParticipantTile p={p} showStats={showStats} onClick={() => setFocus(`${p.identity}:camera`)} /></div>)}
      </div>
    );
  }
  const [mid, mkind] = mainKey.split(':') as [string, 'camera' | 'screen'];
  const mainP = people.find((p) => p.identity === mid)!;
  const strip: { p: ParticipantView; kind: 'camera' | 'screen' }[] = [];
  for (const p of people) { strip.push({ p, kind: 'camera' }); if (p.screenOn) strip.push({ p, kind: 'screen' }); }
  const others = strip.filter((x) => !(x.p.identity === mid && x.kind === mkind));
  return (
    <div data-testid="call-spotlight" className="flex min-h-0 flex-1 flex-col gap-2 p-3 max-md:p-2">
      <div className="min-h-0 flex-1">
        {mkind === 'screen'
          ? <ScreenTile key={mainKey} p={mainP} focused onClick={validFocus ? () => setFocus(null) : undefined} />
          : <ParticipantTile key={mainKey} p={mainP} showStats={showStats} onClick={() => setFocus(null)} />}
      </div>
      {others.length > 0 && (
        <div className="flex h-[96px] shrink-0 gap-2 overflow-x-auto md:h-[128px]" data-noswipe>
          {others.map(({ p, kind }) => kind === 'screen'
            ? <ScreenTile key={`${p.identity}:screen`} p={p} size="sm" onClick={() => setFocus(`${p.identity}:screen`)} />
            : <ParticipantTile key={`${p.identity}:camera`} p={p} size="sm" onClick={() => setFocus(`${p.identity}:camera`)} />)}
        </div>
      )}
    </div>
  );
}

/** Stage channel layout: speakers (unsuppressed) on top, audience below; request-to-speak + moderator invites via the stage API. */
export function StageSurface({ channelId }: { channelId: string }) {
  const snap = useVoiceSnapshot(); const mobile = useIsMobile();
  const toast = useUI((s) => s.toast);
  const states = useData((s) => s.voiceStates); const meId = useData((s) => s.me?.id);
  const canModerate = (myChannelPerms(channelId) & Perm.MUTE_MEMBERS) !== 0n;
  const people = snap.participants;
  const suppressed = (id: string) => states[id]?.suppress ?? false;
  const speakers = people.filter((p) => !suppressed(p.identity));
  const audience = people.filter((p) => suppressed(p.identity));
  const queue = useStageQueue(channelId, canModerate); const { blocks, refresh: refreshBlocks } = useStageBlocks(channelId, canModerate);
  const names = Object.fromEntries(people.map((p) => [p.identity, p.name]));
  const me = people.find((p) => p.isLocal);
  const iAmAudience = !!me && suppressed(me.identity);
  const myHand = !!(meId && states[meId]?.requestToSpeakAt);
  const cols = mobile ? 1 : Math.min(3, Math.max(1, speakers.length));
  const streams = people.filter((p) => p.screenOn);
  const run = (fn: Promise<unknown>) => void fn.catch((e) => toast((e as Error).message || 'Stage action failed', 'error'));
  return (
    <div data-testid="stage" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 max-md:p-3">
      <section aria-label={t('Speakers')}>
        <h3 className="section-title mb-2">Speakers — {speakers.length}</h3>
        {speakers.length === 0
          ? <div className="rounded-lg bg-side p-6 text-center text-sm text-muted">{t('No one is speaking yet. Moderators can invite audience members to speak.')}</div>
          : <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: mobile ? '160px' : '200px' }}>{speakers.map((p) => <ParticipantTile key={p.identity} p={p} />)}</div>}
      </section>
      {streams.length > 0 && <section aria-label={t('Streams')} className="grid gap-2" style={{ gridAutoRows: mobile ? '200px' : '320px' }}>{streams.map((p) => <ScreenTile key={p.identity} p={p} />)}</section>}
      <StageHands channelId={channelId} mod={canModerate} entries={queue} names={names} onBlocked={refreshBlocks} />
      {canModerate && <StageBlockedList channelId={channelId} blocks={blocks} refresh={refreshBlocks} />}
      <section aria-label={t('Audience')}>
        <h3 className="section-title mb-2">Audience — {audience.length}</h3>
        <ul className="flex flex-wrap gap-2">
          {audience.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 rounded-full bg-side py-1 ps-1 pe-3 text-sm text-header"><Avatar user={{ id: p.identity, username: p.name, displayName: p.name, avatar: null }} size={24} />{p.name}{states[p.identity]?.requestToSpeakAt && <Hand size={14} className="text-warn" />}</li>
          ))}
        </ul>
      </section>
      {canModerate && speakers.some((p) => !p.isLocal) && (
        <section aria-label={t('Moderate speakers')} className="flex flex-wrap gap-2">{speakers.filter((p) => !p.isLocal).map((p) => <span key={p.identity} className="flex gap-1">
          <button className="btn btn-secondary" onClick={() => run(api.voice.stageSpeaker(channelId, p.identity, false))}>Move {p.name} to Audience</button>
          <button className="btn btn-secondary" aria-label={`${t('Block')} ${p.name} ${t('from speaking')}`} title={t('Block from speaking')} onClick={() => run(api.voice.stageBlock(channelId, p.identity, true).then(refreshBlocks))}><Ban size={14} /></button></span>)}</section>
      )}
      {iAmAudience && <RaiseHand channelId={channelId} myHand={myHand} />}
      {me && !iAmAudience && <div className="flex flex-col items-center gap-2 text-sm text-muted"><p className="flex items-center gap-2"><Mic size={14} />{t('You are a speaker.')}</p>{(
        <button className="btn btn-secondary" onClick={() => run(api.voice.stageSpeaker(channelId, '@me', false))}>{t('Move to Audience')}</button>)}</div>}
    </div>
  );
}

export function Lobby({ name, stage, users, busy, onJoin, disabledReason, icon, failure }: { failure?: VoiceFailure | null; name: string; stage?: boolean; users: { id: string; username: string; displayName: string | null; avatar: string | null }[]; busy: boolean; onJoin: () => void; disabledReason?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-side text-muted">{icon ?? <Volume2 size={40} />}</div>
      <div>
        <h2 className="text-2xl font-bold text-header">{name}</h2>
        <p className="mt-1 text-sm text-muted">{users.length ? `${users.length} ${users.length === 1 ? 'person is' : 'people are'} ${stage ? 'on this stage' : 'in here'}.` : stage ? 'No one is on stage yet. Start the conversation.' : 'No one is currently in voice. Hop in and start talking.'}</p>
      </div>
      {users.length > 0 && <div className="flex max-w-md flex-wrap justify-center gap-3">{users.slice(0, 12).map((u) => <div key={u.id} className="flex flex-col items-center gap-1 text-xs text-interactive"><Avatar user={u} size={48} /><span className="max-w-[72px] truncate">{u.displayName || u.username}</span></div>)}</div>}
      <button className="btn btn-primary btn-lg min-w-[160px]" onClick={onJoin} disabled={busy || !!disabledReason} title={disabledReason}>
        {busy ? <><Loader2 size={16} className="animate-spin" />{t('Connecting…')}</> : stage ? 'Join Stage' : 'Join Voice'}
      </button>
      {disabledReason && <p className="text-sm text-danger">{disabledReason}</p>}
      {failure && !busy && <TroubleshootPanel failure={failure} />}
    </div>
  );
}
