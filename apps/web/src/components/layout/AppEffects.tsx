import { useEffect } from 'react';
import { useData, selfMember } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useLayout } from '@/stores/layout';
import { useNotif } from '@/stores/notif';
import { useRouteIds } from '@/lib/nav';
import { api } from '@/lib/api';
import { syncPush } from '@/lib/push';
import { setBadgeCount } from '@/lib/native';

/** Post-login side effects that need the router + loaded data: layout/notification hydration, push, badge, status expiry, onboarding. */
export function AppEffects() {
  const me = useData((s) => s.me); const { guildId } = useRouteIds();
  const guilds = useData((s) => s.guilds); const onboarded = useLayout((s) => s.onboarded);
  const mentions = useData((s) => Object.values(s.readStates).reduce((a, r) => a + r.mentionCount, 0));

  useEffect(() => { if (!me) return; useLayout.getState().hydrateFromServer(me.settings); }, [me?.id]); // eslint-disable-line
  useEffect(() => { if (!me) return; void useNotif.getState().load(); void syncPush().catch(() => {}); }, [me?.id]); // eslint-disable-line
  useEffect(() => { setBadgeCount(mentions); }, [mentions]);

  // custom status expiry ("clear after")
  const expires = useLayout((s) => s.statusExpiresAt);
  useEffect(() => {
    if (!expires) return;
    const run = () => {
      if (Date.now() < expires) return;
      const cur = useData.getState().me; if (!cur) return;
      useLayout.getState().setStatusExpiry(null);
      api.users.patchMe({ customStatus: null }).then(() => useData.getState().apply('USER_UPDATE', { ...cur, customStatus: null })).catch(() => {});
    };
    run(); const t = setInterval(run, 15_000); return () => clearInterval(t);
  }, [expires]);

  // welcome + rules screening for people who just joined a server that configured it
  const g = guildId ? guilds[guildId] : undefined; const mem = guildId ? selfMember(useData.getState(), guildId) : undefined;
  useEffect(() => {
    if (!guildId || !g || !me || !mem) return;
    if (g.guild.ownerId === me.id || onboarded[guildId]) return;
    if (!g.guild.rulesChannelId && !g.guild.description) return;
    if (Date.now() - Date.parse(mem.joinedAt) > 7 * 86_400_000) return;
    try { if (sessionStorage.getItem('jorcord.onb.' + guildId)) return; } catch { /* */ }
    if (useUI.getState().modal) return;
    useUI.getState().openModal({ kind: 'onboarding', guildId });
  }, [guildId, g?.guild.rulesChannelId, g?.guild.description, !!mem, onboarded[guildId ?? '']]); // eslint-disable-line
  return null;
}
