import { useEffect } from 'react';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast } from '@/stores/ui';
import { connectReturnMessage, parseConnectReturn, stripConnectReturn } from '@/lib/connectReturn';
import { useLayout } from '@/stores/layout';
import { useNotif } from '@/stores/notif';
import { useRouteIds } from '@/lib/nav';
import { syncPush } from '@/lib/push';
import { setBadgeCount } from '@/lib/native';
import { resetGameActivity, startGameDetection } from '@/lib/gameActivity';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';

/** Post-login side effects that need the router + loaded data: layout/notification hydration, push, badge, status expiry, onboarding. */
export function AppEffects() {
  const me = useData((s) => s.me); const { guildId } = useRouteIds();
  const guilds = useData((s) => s.guilds); const onboarded = useLayout((s) => s.onboarded);
  const mentions = useData((s) => Object.values(s.readStates).reduce((a, r) => a + r.mentionCount, 0));

  useEffect(() => { if (!me) return; useLayout.getState().hydrateFromServer(me.settings); useUI.getState().hydrateFromServer(me.settings); }, [me?.id]); // eslint-disable-line
  useEffect(() => { if (!me) return; void useNotif.getState().load(); void syncPush().catch(() => {}); }, [me?.id]); // eslint-disable-line
  useEffect(() => { setBadgeCount(mentions); }, [mentions]);
  // desktop: report "Playing <game>" while a detectable game is running (no-op in the browser)
  useEffect(() => { if (!me) { void resetGameActivity(); return; } return startGameDetection(); }, [me?.id]); // eslint-disable-line

  // back from "Connect with Twitch / YouTube": say how it went and show the Connections list
  useEffect(() => {
    if (!me) return;
    const r = parseConnectReturn(window.location.search); if (!r) return;
    try { window.history.replaceState(window.history.state, '', window.location.pathname + stripConnectReturn(window.location.search) + window.location.hash); } catch { /* */ }
    const m = connectReturnMessage(r); toast(m.text, m.kind);
    useUI.getState().openSettings({ kind: 'user', tab: 'connections' });
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
  }, [me?.id]); // eslint-disable-line

  // custom status expiry is enforced by the server (customStatus.expiresAt): it clears the status and broadcasts PRESENCE_UPDATE

  // welcome + rules screening for people who just joined a server that configured it
  const g = guildId ? guilds[guildId] : undefined; const mem = guildId ? selfMember(useData.getState(), guildId) : undefined;
  useEffect(() => {
    if (!guildId || !g || !me || !mem) return;
    // membership screening: pending members must accept the rules (server keeps them read-only until then)
    if (mem.pending && g.guild.features.includes('MEMBER_SCREENING')) {
      try { if (sessionStorage.getItem('jorcord.scr.' + guildId)) return; sessionStorage.setItem('jorcord.scr.' + guildId, '1'); } catch { /* */ }
      if (!useUI.getState().modal) useUI.getState().openModal({ kind: 'screening', guildId });
      return;
    }
    if (g.guild.features.includes('MEMBER_SCREENING')) return; // the server gates the rules now: the older, client-side welcome + rules screen would only repeat it
    if (g.guild.ownerId === me.id || onboarded[guildId]) return;
    if (!g.guild.rulesChannelId && !g.guild.description && !g.guild.welcomeScreen?.enabled) return;
    if (Date.now() - Date.parse(mem.joinedAt) > 7 * 86_400_000) return;
    try { if (sessionStorage.getItem('jorcord.onb.' + guildId)) return; } catch { /* */ }
    if (useUI.getState().modal) return;
    useUI.getState().openModal({ kind: 'onboarding', guildId });
  }, [guildId, g?.guild.rulesChannelId, g?.guild.description, !!mem, !!mem?.pending, onboarded[guildId ?? '']]); // eslint-disable-line
  // onboarding questions: newcomers of a server that has them are asked once (they can always redo it from the server menu)
  const onbOn = !!g?.guild.features.includes('ONBOARDING');
  useEffect(() => {
    if (!guildId || !me || !mem || !onbOn || mem.pending) return;
    try { if (sessionStorage.getItem('jorcord.cust.' + guildId)) return; } catch { /* */ }
    let dead = false;
    void queryClient.fetchQuery({ queryKey: ['onboarding', guildId], queryFn: () => api.guilds.onboarding(guildId), staleTime: 30_000 }).then((o) => {
      if (dead || o.responses || !o.prompts.length || useUI.getState().modal) return;
      try { sessionStorage.setItem('jorcord.cust.' + guildId, '1'); } catch { /* */ }
      useUI.getState().openModal({ kind: 'customize', guildId });
    }).catch(() => {});
    return () => { dead = true; };
  }, [guildId, onbOn, !!mem, !!mem?.pending]); // eslint-disable-line
  return null;
}
