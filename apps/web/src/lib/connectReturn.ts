/**
 * "Connect with Twitch / YouTube" ends with the server redirecting the browser to `/channels/@me?connect=<provider>&result=<code>`.
 * Pure parsing + wording live here; AppEffects shows the toast, opens Settings > Connections and cleans the URL.
 */
import { t } from '@/i18n';

export interface ConnectReturn { provider: string; result: string }

export function parseConnectReturn(search: string): ConnectReturn | null {
  const q = new URLSearchParams(search); const provider = q.get('connect'); const result = q.get('result');
  if (!provider || !result || !/^[a-z]{3,20}$/.test(provider) || !/^[a-z_]{2,30}$/.test(result)) return null;
  return { provider, result };
}

/** The same search string without the connect params (other params kept). */
export function stripConnectReturn(search: string): string {
  const q = new URLSearchParams(search); q.delete('connect'); q.delete('result');
  const s = q.toString(); return s ? `?${s}` : '';
}

const NAMES: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube' };
export function connectReturnMessage(r: ConnectReturn): { text: string; kind: 'success' | 'error' } {
  const name = NAMES[r.provider] ?? r.provider;
  switch (r.result) {
    case 'ok': return { text: t('{name} connected and verified', { name }), kind: 'success' };
    case 'denied': return { text: t('{name} connection was cancelled', { name }), kind: 'error' };
    case 'already_linked': return { text: t('That {name} account is already connected to another Jorcord account', { name }), kind: 'error' };
    case 'limit_reached': return { text: t('You have reached the connection limit'), kind: 'error' };
    case 'no_channel': return { text: t('That Google account has no YouTube channel'), kind: 'error' };
    case 'invalid_state': return { text: t('The {name} sign-in expired or was started in another browser. Try again from Settings.', { name }), kind: 'error' };
    case 'rate_limited': return { text: t('Too many attempts, try again in a minute'), kind: 'error' };
    case 'disabled': return { text: t('{name} sign-in is not enabled on this server', { name }), kind: 'error' };
    default: return { text: t('Could not connect {name}. Try again later.', { name }), kind: 'error' };
  }
}
