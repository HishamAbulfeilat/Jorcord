import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { VoiceToken } from '@jorcord/shared';
import { VoiceClient, type VoiceClientOptions } from '../client';

export interface VoiceContextValue { client: VoiceClient; fetchToken: (channelId: string) => Promise<VoiceToken> }
export const VoiceContext = createContext<VoiceContextValue | null>(null);

export interface VoiceProviderProps extends VoiceClientOptions {
  /** Provide your own token fetcher, or use apiBase + getAuthToken. */
  fetchToken?: (channelId: string) => Promise<VoiceToken>;
  apiBase?: string;
  getAuthToken?: () => string | null | undefined;
  /** Pass an existing client (tests / custom setup). */
  client?: VoiceClient;
  children?: ReactNode;
}

export function VoiceProvider({ children, fetchToken, apiBase = '', getAuthToken, client: external, ...opts }: VoiceProviderProps) {
  const ref = useRef<VoiceClient | null>(external ?? null);
  const fetchRef = useRef<((channelId: string) => Promise<VoiceToken>) | undefined>(undefined);
  if (!ref.current) ref.current = new VoiceClient({ getToken: (id) => fetchRef.current!(id), ...opts });
  const client = ref.current;
  const getAuth = useRef(getAuthToken); getAuth.current = getAuthToken;
  const custom = useRef(fetchToken); custom.current = fetchToken;
  const value = useMemo<VoiceContextValue>(() => ({
    client,
    fetchToken: async (channelId) => {
      if (custom.current) return custom.current(channelId);
      const t = getAuth.current?.();
      const res = await fetch(`${apiBase}/voice/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ channelId }),
      });
      if (!res.ok) throw Object.assign(new Error(`voice token ${res.status}`), { name: 'TokenError', status: res.status });
      return (await res.json()) as VoiceToken;
    },
  }), [client, apiBase]);
  fetchRef.current = value.fetchToken;
  useEffect(() => () => { if (!external) void client.dispose(); }, [client, external]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoiceContext(): VoiceContextValue {
  const v = useContext(VoiceContext);
  if (!v) throw new Error('useVoice* must be used inside <VoiceProvider>');
  return v;
}
