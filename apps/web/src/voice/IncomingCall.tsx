import { useEffect, useRef } from 'react';
import { Phone, PhoneOff, BellOff } from 'lucide-react';
import { useCalls, activeRing, type IncomingCall as Ring } from '@/stores/calls';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { api } from '@/lib/api';
import { displayName } from '@/lib/format';
import { useNav } from '@/lib/nav';
import { startRingLoop } from '@/lib/ringtone';
import { Avatar } from '@/components/ui/Avatar';
import { t } from '@/i18n';

/** Whether the ring tone may play: not silent (DND), sounds enabled, streamer mode not muting sounds. */
export function ringAudible(r: Ring | null, p: { notificationSounds: boolean; streamerMode: boolean; streamerNoSounds: boolean }): boolean {
  return !!r && !r.silent && p.notificationSounds && !(p.streamerMode && p.streamerNoSounds);
}

/** Rings while a call is incoming; stops as soon as it is answered / declined / ignored / ended / expired. */
export function useRingTone() {
  const ring = useCalls((s) => activeRing(s.rings)); const prefs = useUI((s) => s.prefs);
  const audible = ringAudible(ring, prefs);
  useEffect(() => { if (!audible) return; const loop = startRingLoop(); return () => loop.stop(); }, [audible, ring?.callId]);
}

export function IncomingCalls() {
  const ring = useCalls((s) => activeRing(s.rings));
  const connected = useVoiceUI((s) => s.connectedChannelId);
  const user = useData((s) => (ring ? s.users[ring.userId] : undefined));
  const nav = useNav(); const accept = useRef<HTMLButtonElement>(null);
  useRingTone();
  // expiry: the server sends CALL_RING_END, this is the fallback when the socket was down
  useEffect(() => {
    const next = Object.values(useCalls.getState().rings).map((r) => Date.parse(r.expiresAt)).sort((a, b) => a - b)[0];
    if (!next) return;
    const id = setTimeout(() => useCalls.getState().expire(), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [ring?.callId, ring?.expiresAt]);
  // joined this call on this device: it is answered
  useEffect(() => { if (connected) useCalls.getState().end(connected); }, [connected]);
  useEffect(() => { if (ring) accept.current?.focus(); }, [ring?.callId]);
  // tab in the background: a system notification so the ring is not missed
  useEffect(() => {
    if (!ring || document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !useUI.getState().prefs.desktopNotifications) return;
    try { const n = new Notification(ring.groupName ?? ring.name, { body: ring.channelType === 'group_dm' ? `${ring.name} ${t('started a call.')}` : t('Incoming call'), tag: `call-${ring.channelId}`, requireInteraction: true }); return () => n.close(); } catch { /* */ }
  }, [ring?.callId]);
  if (!ring) return null;

  const who = ring.channelType === 'group_dm' ? (ring.groupName || t('Group call')) : (user ? displayName(user) : ring.name);
  const sub = ring.channelType === 'group_dm' ? `${ring.name} ${t('started a call.')}` : t('Incoming call');
  const end = () => useCalls.getState().end(ring.channelId, ring.callId);
  const onAccept = async () => {
    end();
    nav.go(null, ring.channelId);
    try { const { startCall } = await import('./DmCall'); await startCall(ring.channelId, false); } catch { /* the call UI reports join errors */ }
  };
  const onDecline = () => { end(); void api.voice.declineCall(ring.channelId).catch(() => {}); };
  const onIgnore = () => useCalls.getState().ignore(ring.channelId);
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby="incall-title" aria-describedby="incall-sub" data-testid="incoming-call"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onIgnore(); } }}
      className="fixed inset-x-0 top-4 z-[90] mx-auto flex w-[min(92vw,360px)] flex-col items-center gap-3 rounded-xl bg-float p-5 shadow-elev animate-pop">
      <Avatar user={user ?? { id: ring.userId, username: ring.name, displayName: ring.name, avatar: null }} size={64} />
      <div className="text-center">
        <p id="incall-title" className="text-lg font-semibold text-header">{who}</p>
        <p id="incall-sub" className="text-sm text-muted">{sub}</p>
      </div>
      <div className="flex w-full items-center justify-center gap-3">
        <button ref={accept} className="btn flex items-center gap-2 bg-success text-white hover:opacity-90" onClick={() => void onAccept()}><Phone size={18} />{t('Accept')}</button>
        <button className="btn btn-danger flex items-center gap-2" onClick={onDecline}><PhoneOff size={18} />{t('Decline')}</button>
        <button className="btn btn-secondary flex items-center gap-2" onClick={onIgnore} title={t('Stop ringing on this device; the call stays open')}><BellOff size={18} />{t('Ignore')}</button>
      </div>
    </div>
  );
}
