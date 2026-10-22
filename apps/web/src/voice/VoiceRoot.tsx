import { useEffect, type ReactNode } from 'react';
import { VoiceProvider } from '@jorcord/voice/react';
import { api } from '@/lib/api';
import { useUI } from '@/stores/ui';
import { useData, findChannel } from '@/stores/data';
import { LiveCaptionsRunner } from './Captions';
import { applyPrefs, currentVoiceChannel, getVoiceClient, leaveVoice } from './controller';

/** Mounts the single VoiceClient for the signed-in session and keeps it in sync with prefs and the gateway. */
export function VoiceRoot({ children }: { children: ReactNode }) {
  const client = getVoiceClient();
  useEffect(() => {
    const u1 = useUI.subscribe((s, p) => { if (s.prefs !== p.prefs) applyPrefs(s.prefs); });
    // Channel deleted / kicked from the guild while connected: leave.
    const u2 = useData.subscribe((s) => { const ch = currentVoiceChannel(); if (ch && s.ready && !findChannel(s, ch)) void leaveVoice(); });
    const bye = () => { void leaveVoice(); };
    window.addEventListener('pagehide', bye);
    return () => { u1(); u2(); window.removeEventListener('pagehide', bye); void leaveVoice(); };
  }, []);
  return (
    <VoiceProvider client={client} fetchToken={(id) => api.voice.token(id)}>
      <LiveCaptionsRunner />
      {children}
    </VoiceProvider>
  );
}
