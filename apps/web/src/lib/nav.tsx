import { createContext, useContext } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useUI } from '@/stores/ui';

export const BaseCtx = createContext<string>('');
export const useBase = () => { const c = useContext(BaseCtx); const { pathname } = useLocation(); return c || (pathname.startsWith('/demo') ? '/demo' : ''); };

export function useRouteIds() {
  const p = useParams();
  const guildId = p.guildId && p.guildId !== '@me' ? p.guildId : undefined;
  return { guildId, channelId: p.channelId, isHome: p.guildId === '@me' || !p.guildId };
}
export function useNav() {
  const base = useBase(); const nav = useNavigate();
  const setLeft = useUI((s) => s.setLeftDrawer);
  return {
    base,
    path: (guildId: string | undefined | null, channelId?: string | null) => `${base}/channels/${guildId ?? '@me'}${channelId ? `/${channelId}` : ''}`,
    go(guildId: string | undefined | null, channelId?: string | null, opts?: { replace?: boolean }) { nav(`${base}/channels/${guildId ?? '@me'}${channelId ? `/${channelId}` : ''}`, opts); setLeft(false); },
    home: () => nav(`${base}/channels/@me`),
    to: (p: string, opts?: { replace?: boolean }) => nav(base + p, opts),
  };
}
