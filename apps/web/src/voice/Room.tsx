import { useMemo } from 'react';
import { AlertTriangle, Hand, Loader2, Mic, Volume2 } from 'lucide-react';
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
import { ParticipantTile, ScreenTile } from './tiles';
import { t } from '@/i18n';

export function VoiceBanners() {
  const snap = useVoiceSnapshot(); const client = useVoiceClient(); const { blocked, unlock } = useAudioUnlock();
  return (
    <>
      {snap.status === 'reconnecting' && <div role="status" className="flex items-center justify-center gap-2 bg-warn px-3 py-1 text-sm font-semibold text-black"><Loader2 size={14} className="animate-spin" />{t('Reconnecting to voice…')}</div>}
      {blocked && snap.status === 'connected' && <button onClick={unlock} className="bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-hover">{t('Click to enable audio')}</button>}
      {snap.error && (
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

/** The call surface: participant grid, or a spotlighted stream with a filmstrip. */
export function CallSurface({ compact, tall }: { compact?: boolean; tall?: boolean }) {
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
  const hands = audience.filter((p) => states[p.identity]?.requestToSpeakAt).sort((a, b) => String(states[a.identity]?.requestToSpeakAt).localeCompare(String(states[b.identity]?.requestToSpeakAt)));
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
      {hands.length > 0 && (
        <section aria-label={t('Requests to speak')}>
          <h3 className="section-title mb-2">Requests to speak — {hands.length}</h3>
          <ul className="grid gap-1">{hands.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 rounded bg-side px-3 py-2 text-sm text-header"><Hand size={16} className="text-warn" /><span className="min-w-0 flex-1 truncate">{p.name}</span>
              {canModerate && <button className="btn btn-primary" onClick={() => run(api.voice.stageSpeaker(channelId, p.identity, true))}>{t('Invite to Speak')}</button>}</li>))}</ul>
        </section>
      )}
      <section aria-label={t('Audience')}>
        <h3 className="section-title mb-2">Audience — {audience.length}</h3>
        <ul className="flex flex-wrap gap-2">
          {audience.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 rounded-full bg-side py-1 ps-1 pe-3 text-sm text-header"><Avatar user={{ id: p.identity, username: p.name, displayName: p.name, avatar: null }} size={24} />{p.name}{states[p.identity]?.requestToSpeakAt && <Hand size={14} className="text-warn" />}</li>
          ))}
        </ul>
      </section>
      {canModerate && speakers.some((p) => !p.isLocal) && (
        <section aria-label={t('Moderate speakers')} className="flex flex-wrap gap-2">{speakers.filter((p) => !p.isLocal).map((p) => <button key={p.identity} className="btn btn-secondary" onClick={() => run(api.voice.stageSpeaker(channelId, p.identity, false))}>Move {p.name} to Audience</button>)}</section>
      )}
      {iAmAudience && (
        <button className={cx('btn btn-lg w-full max-w-xs self-center', myHand ? 'btn-secondary' : 'btn-primary')} onClick={() => run(api.voice.stageRequest(channelId, !myHand))}>
          <Hand size={16} />{myHand ? 'Lower Hand' : 'Request to Speak'}
        </button>
      )}
      {me && !iAmAudience && <div className="flex flex-col items-center gap-2 text-sm text-muted"><p className="flex items-center gap-2"><Mic size={14} />{t('You are a speaker.')}</p>{(
        <button className="btn btn-secondary" onClick={() => run(api.voice.stageSpeaker(channelId, '@me', false))}>{t('Move to Audience')}</button>)}</div>}
    </div>
  );
}

export function Lobby({ name, stage, users, busy, onJoin, disabledReason, icon }: { name: string; stage?: boolean; users: { id: string; username: string; displayName: string | null; avatar: string | null }[]; busy: boolean; onJoin: () => void; disabledReason?: string; icon?: React.ReactNode }) {
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
    </div>
  );
}
