import { useEffect, useMemo, useRef } from 'react';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { findChannel, useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { applyOverlay, DEFAULT_OVERLAY_SHORTCUT, emitOverlayState, isOverlayWindow, onOverlayAction, type OverlayState } from '@/lib/overlay';

/**
 * Lives in the main window (inside VoiceRoot). Mirrors the current voice call into the overlay window,
 * pushes overlay prefs to the native shell, and routes the overlay's buttons back to the voice client.
 */
export function OverlayBridge() {
  const overlay = isOverlayWindow();
  const snap = useVoiceSnapshot();
  const channelId = snap.channelId;
  const channelName = useData((s) => (channelId ? findChannel(s, channelId)?.name ?? null : null));
  const guildName = useData((s) => { const ch = channelId ? findChannel(s, channelId) : undefined; return ch?.guildId ? s.guilds[ch.guildId]?.guild.name ?? null : null; });
  const selfMute = useVoiceUI((s) => s.selfMute);
  const selfDeaf = useVoiceUI((s) => s.selfDeaf);
  const enabled = useUI((s) => s.prefs.overlayEnabled);
  const locked = useUI((s) => s.prefs.overlayLocked);
  const corner = useUI((s) => s.prefs.overlayCorner);

  const active = snap.status === 'connected' || snap.status === 'reconnecting';
  const state = useMemo<OverlayState>(() => ({
    active,
    channel: active ? channelName : null,
    guild: active ? guildName : null,
    locked,
    selfMuted: selfMute || selfDeaf,
    selfDeafened: selfDeaf,
    participants: (active ? snap.participants : []).map((p) => ({ id: p.userId, name: p.name, speaking: p.speaking, muted: p.micMuted, self: p.isLocal })),
  }), [active, channelName, guildName, locked, selfMute, selfDeaf, snap.participants]);

  // Push appearance + behaviour to the native window whenever prefs change.
  useEffect(() => {
    if (overlay) return;
    void applyOverlay({ enabled, locked, corner, shortcut: DEFAULT_OVERLAY_SHORTCUT });
  }, [overlay, enabled, locked, corner]);

  // Publish the call state to the overlay window (only when something actually changed).
  const sig = useRef('');
  useEffect(() => {
    if (overlay) return;
    const s = JSON.stringify(state);
    if (s === sig.current) return;
    sig.current = s;
    emitOverlayState(state);
  }, [overlay, state]);

  // Buttons pressed in the overlay window.
  useEffect(() => {
    if (overlay) return;
    let off = () => {};
    void onOverlayAction((a) => {
      if (a === 'toggle-mute') useVoiceUI.getState().toggleMute();
      else if (a === 'toggle-deafen') useVoiceUI.getState().toggleDeaf();
      else if (a === 'toggle-lock') useUI.getState().setPref('overlayLocked', !useUI.getState().prefs.overlayLocked);
    }).then((u) => { off = u; });
    return () => off();
  }, [overlay]);

  return null;
}
