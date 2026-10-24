import { UpdateBanner } from './UpdateBanner';
import { ConnectionBanner } from './ConnectionBanner';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { DiscoveryPage } from '@/components/home/DiscoveryPage';
import { t } from '@/i18n';
import { Home, MessageSquare, Users, UserCircle } from 'lucide-react';
import { useData, findChannel, channelUnread } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { ServerRail } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { DmSidebar } from './DmSidebar';
import { UserPanel } from './UserPanel';
import { QuickSwitcher } from './QuickSwitcher';
import { ChatView } from '@/components/chat/ChatView';
import { ForumView } from '@/components/chat/ForumView';
import { FriendsHome } from '@/components/home/FriendsHome';
import { lazyNamed, Lazy } from '@/lib/lazy';
const VoiceChannelView = lazyNamed(() => import('@/components/VoiceChannelView'), 'VoiceChannelView');
const LazyMobileVoiceBar = lazyNamed(() => import('@/voice/views'), 'MobileVoiceBar');
import { VoiceRoot } from '@/voice/VoiceRoot';
import { BaseCtx, useNav, useRouteIds } from '@/lib/nav';
import { useIsMobile } from '@/lib/hooks';
import { useFirstTextChannel } from '@/lib/useGuild';
import { cx } from '@/lib/format';
import { ReportQueuePanel } from '@/components/chat/Panels';
import { Badge } from '@/components/ui/primitives';
import { comboFromEvent } from '@/lib/combo';
import { useVoiceUI } from '@/stores/voiceui';
import { OverlayBridge } from '@/overlay/OverlayBridge';

function Sidebar() {
  const { guildId } = useRouteIds();
  return (
    <div className="flex h-full w-60 shrink-0 flex-col rounded-ss-lg bg-side max-md:w-full max-md:rounded-none">
      {guildId ? <ChannelSidebar guildId={guildId} /> : <DmSidebar />}
      <UserPanel />
    </div>
  );
}

function GuildRedirect() {
  const { guildId } = useRouteIds(); const nav = useNav(); const last = useUI((s) => s.lastChannel[guildId ?? '']); const first = useFirstTextChannel(guildId);
  const g = useData((s) => (guildId ? s.guilds[guildId] : undefined)); const ready = useData((s) => s.ready);
  const mobile = useIsMobile(); const setLeft = useUI((s) => s.setLeftDrawer);
  useEffect(() => {
    const target = last && g?.channels[last] ? last : first?.id;
    if (target) nav.go(guildId, target, { replace: true });
    else if (mobile) setLeft(true);
  }, [guildId, last, first?.id, g]); // eslint-disable-line
  if (ready && !g) return <Navigate to={`${nav.base}/channels/@me`} replace />;
  return <div className="flex flex-1 items-center justify-center bg-chat text-muted">{g ? 'No text channels yet.' : ''}</div>;
}

function ChannelPage() {
  const { channelId, guildId } = useRouteIds(); const ready = useData((s) => s.ready); const nav = useNav();
  const ch = useData((s) => findChannel(s, channelId)); const known = useData((s) => (guildId ? !!s.guilds[guildId] : true));
  if (!ch) { if (ready && (!known || channelId)) return ready && !known ? <Navigate to={`${nav.base}/channels/@me`} replace /> : <GuildRedirect />; return null; }
  if (ch.type === 'voice' || ch.type === 'stage') return <Lazy><VoiceChannelView key={ch.id} channel={ch} /></Lazy>;
  if (ch.type === 'forum' || ch.type === 'media') return <ForumView key={ch.id} channel={ch} />;
  return <ChatView key={ch.id} channel={ch} />;
}

function MainContent() {
  const { isHome, channelId } = useRouteIds(); const { pathname } = useLocation();
  if (pathname.endsWith('/discover')) return <DiscoveryPage />;
  if (isHome && !channelId) return <FriendsHome />;
  if (!channelId) return <GuildRedirect />;
  return <ChannelPage />;
}

function MobileTabBar() {
  const tab = useUI((s) => s.mobileTab); const setTab = useUI((s) => s.setMobileTab); const nav = useNav(); const openSettings = useUI((s) => s.openSettings); const setLeft = useUI((s) => s.setLeftDrawer);
  const mentions = useData((s) => Object.values(s.readStates).reduce((a, r) => a + r.mentionCount, 0));
  const reqs = useData((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
  const me = useData((s) => s.me);
  const T = ({ id, label, icon: I, badge, onClick }: { id: any; label: string; icon: any; badge?: number; onClick: () => void }) => (
    <button role="tab" aria-selected={tab === id} aria-label={label} onClick={() => { setTab(id); onClick(); }} className={cx('relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', tab === id ? 'text-header' : 'text-muted')}>
      <span className="relative"><I size={24} />{!!badge && <Badge n={badge} className="absolute -end-3 -top-1.5" />}</span>{label}
    </button>);
  return (
    <div role="tablist" aria-label={t('Main navigation')} className="flex shrink-0 border-t border-divider bg-rail" style={{ paddingBottom: 'var(--sab)' }}>
      <T id="servers" label={t('Home')} icon={Home} onClick={() => setLeft(true)} />
      <T id="dms" label={t('Messages')} icon={MessageSquare} badge={mentions} onClick={() => { nav.go('@me'); }} />
      <T id="friends" label={t('Friends')} icon={Users} badge={reqs} onClick={() => { nav.go('@me'); }} />
      <T id="you" label={me?.displayName || 'You'} icon={UserCircle} onClick={() => openSettings({ kind: 'user' })} />
    </div>
  );
}

export function AppShell({ base = '' }: { base?: string }) {
  const mobile = useIsMobile(); const left = useUI((s) => s.leftDrawer); const setLeft = useUI((s) => s.setLeftDrawer); const setRight = useUI((s) => s.setRightDrawer); const right = useUI((s) => s.rightDrawer);
  const navigate = useNavigate(); const ref = useRef<HTMLDivElement>(null);
  const { guildId } = useRouteIds();
  // goto events from menus / notifications
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; navigate(`${base}/channels/${d.guildId ?? '@me'}${d.channelId ? '/' + d.channelId : ''}`); setLeft(false); };
    window.addEventListener('jorcord:goto', h); return () => window.removeEventListener('jorcord:goto', h);
  }, [navigate, base, setLeft]);
  useEffect(() => {
    const h = (e: Event) => { const to = (e as CustomEvent).detail?.to; if (typeof to === 'string' && to.startsWith('/') && !to.startsWith('//')) { navigate(`${base}${to}`); setLeft(false); } };
    window.addEventListener('jorcord:navigate', h); return () => window.removeEventListener('jorcord:navigate', h);
  }, [navigate, base, setLeft]);
  useGlobalKeys(base);
  // swipe drawers
  useEffect(() => {
    if (!mobile) return; const el = ref.current; if (!el) return;
    let sx = 0, sy = 0, t = 0, ok = true;
    const ts = (e: TouchEvent) => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; t = Date.now(); ok = !(e.target as HTMLElement).closest('pre,[data-noswipe],input[type=range],textarea,.hljs,video,audio'); };
    const te = (e: TouchEvent) => {
      if (!ok) return; const p = e.changedTouches[0]; const dx = p.clientX - sx, dy = p.clientY - sy;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - t > 600) return;
      const s = useUI.getState(); const rtl = document.documentElement.dir === 'rtl';
      if ((rtl ? -dx : dx) > 0) { if (s.rightDrawer) setRight(false); else if (!s.leftDrawer && (rtl ? sx > window.innerWidth * 0.4 : sx < window.innerWidth * 0.6)) setLeft(true); }
      else { if (s.leftDrawer) setLeft(false); else if (!s.rightDrawer && guildId) setRight(true); }
    };
    el.addEventListener('touchstart', ts, { passive: true }); el.addEventListener('touchend', te, { passive: true });
    return () => { el.removeEventListener('touchstart', ts); el.removeEventListener('touchend', te); };
  }, [mobile, guildId, setLeft, setRight]);
  useEffect(() => { if (!mobile) { setLeft(false); setRight(false); } }, [mobile, setLeft, setRight]);

  const main = <MainContent />;
  return (
    <BaseCtx.Provider value={base}>
     <VoiceRoot>
      <OverlayBridge />
      <div ref={ref} className="relative flex h-full flex-col bg-rail">
        <a href="#main" onClick={(e) => { e.preventDefault(); const m = document.getElementById('main'); (m?.querySelector<HTMLElement>('[role=textbox], textarea') ?? m)?.focus(); }}
          className="fixed start-2 top-2 z-[200] -translate-y-24 rounded bg-brand px-3 py-2 text-sm font-semibold text-white focus:translate-y-0">{t('Skip to chat')}</a>
        <UpdateBanner />
        <ConnectionBanner />
        <Lazy><LazyMobileVoiceBar /></Lazy>
        <div className="relative flex min-h-0 flex-1">
          {!mobile && <><ServerRail /><Sidebar /></>}
          <main id="main" tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col bg-chat md:rounded-ss-lg" style={{ paddingInlineStart: 'var(--sal)', paddingInlineEnd: 'var(--sar)' }}>{main}</main>
          {mobile && (
            <>
              <div aria-hidden className={cx('fixed inset-0 z-40 bg-black/60 transition-opacity', left ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => setLeft(false)} />
              <div role="dialog" aria-label={t('Navigation')} aria-hidden={!left} className={cx('drawer fixed inset-y-0 start-0 z-50 flex w-[calc(100%-40px)] max-w-[420px] flex-col bg-rail', left ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full')} {...{ inert: left ? undefined : ('' as any) }}>
                <div className="flex min-h-0 flex-1"><ServerRail onNavigate={undefined} /><div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-ss-2xl bg-side"><Sidebar /></div></div>
                <MobileTabBar />
                {/* Reports panel for mobile */}
                {useUI.getState().panel === 'reports' && useUI.getState().reportGuildId && (
                  <ReportQueuePanel guildId={useUI.getState().reportGuildId!} onClose={useUI.getState().closeReports} />
                )}
              </div>
            </>
          )}
        </div>
        {mobile && !left && !right && <HomeTabBarGate />}
        {!mobile && useUI.getState().panel === 'reports' && useUI.getState().reportGuildId && (
          <ReportQueuePanel guildId={useUI.getState().reportGuildId!} onClose={useUI.getState().closeReports} />
        )}
        <QuickSwitcher />
      </div>
     </VoiceRoot>
    </BaseCtx.Provider>
  );
}

/** Show the bottom tab bar on the home (friends/DM list) screen like Discord mobile. */
function HomeTabBarGate() {
  const { isHome, channelId } = useRouteIds();
  if (!(isHome && !channelId)) return null;
  return <MobileTabBar />;
}

function useGlobalKeys(base: string) {
  const navigate = useNavigate(); const { guildId, channelId } = useRouteIds();
  const ref = useRef({ guildId, channelId }); ref.current = { guildId, channelId };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const kb = useUI.getState().prefs.keybinds; const c = comboFromEvent(e); if (!c) return;
      const s = useUI.getState(); const d = useData.getState();
      const go = (g: string | undefined, ch?: string) => navigate(`${base}/channels/${g ?? '@me'}${ch ? '/' + ch : ''}`);
      if (c === kb.quickSwitcher) { e.preventDefault(); s.setSwitcher(!s.switcher); return; }
      if (c === kb.shortcuts && !(e.target as HTMLElement).closest('input,textarea')) { e.preventDefault(); s.openModal({ kind: 'shortcuts' }); return; }
      if (c === kb.toggleMute) { e.preventDefault(); useVoiceUI.getState().toggleMute(); return; }
      if (c === kb.toggleDeafen) { e.preventDefault(); useVoiceUI.getState().toggleDeaf(); return; }
      if (c === kb.toggleMembers) { e.preventDefault(); s.togglePanel('members'); return; }
      if (c === kb.search) { e.preventDefault(); s.setPanel('search'); return; }
      if (c === 'Escape') { if (s.menu) s.closeMenu(); else if (s.popout) s.closePopout(); return; }
      if (c === kb.prevChannel || c === kb.nextChannel) {
        e.preventDefault(); const { guildId: g, channelId: ch } = ref.current; const dir = c === kb.nextChannel ? 1 : -1;
        const list = g ? Object.values(d.guilds[g]?.channels ?? {}).filter((x) => x.type === 'text' || x.type === 'announcement' || x.type === 'forum' || x.type === 'media').sort((a, b) => a.position - b.position) : Object.values(d.dms).sort((a, b) => (b.lastMessageId ?? '').localeCompare(a.lastMessageId ?? ''));
        const i = list.findIndex((x) => x.id === ch); const n = list[(i + dir + list.length) % list.length]; if (n) go(g, n.id); return;
      }
      if (c === kb.prevServer || c === kb.nextServer) {
        e.preventDefault(); const order = d.guildOrder; const i = ref.current.guildId ? order.indexOf(ref.current.guildId) : -1; const dir = c === kb.nextServer ? 1 : -1;
        const n = order[(i + dir + order.length) % Math.max(1, order.length)]; if (n) go(n, s.lastChannel[n]); return;
      }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [navigate, base]);
}