import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { setTransport, fetchTransport } from '@/lib/transport';
import { gateway, GatewayClient } from '@/lib/gateway';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { useUI } from '@/stores/ui';
import { AppShell } from '@/components/layout/AppShell';
import { demoReady, DEMO_START } from '@/demo/mockData';
import { demoTransport } from '@/demo/demoTransport';

/** Static mock-data route used for screenshots and offline evaluation. */
export function DemoPage() {
  const [ready, setReady] = useState(false); const [sp] = useSearchParams();
  useEffect(() => {
    const prevGw = gateway.get(); gateway.useNull(); setTransport(demoTransport);
    useMessages.setState({ ch: {}, pending: [] });
    useData.getState().applyReady(demoReady);
    setReady(true);
    return () => { gateway.set(prevGw instanceof GatewayClient ? prevGw : new GatewayClient()); setTransport(fetchTransport); useData.getState().reset(); useMessages.setState({ ch: {}, pending: [] }); };
  }, []);
  useEffect(() => { const t = sp.get('theme'); if (t === 'light' || t === 'dark' || t === 'amoled') useUI.getState().setPref('theme', t); }, [sp]);
  useEffect(() => { if (!ready) return; const s = sp.get('open'); const ui = useUI.getState(); if (s === 'settings') ui.openSettings({ kind: 'user', tab: sp.get('tab') ?? undefined }); if (s === 'guild') ui.openSettings({ kind: 'guild', guildId: DEMO_START.guildId, tab: sp.get('tab') ?? undefined }); if (s === 'switcher') ui.setSwitcher(true); if (s === 'drawer') ui.setLeftDrawer(true); if (s === 'members') ui.setRightDrawer(true); if (s === 'server') ui.openModal({ kind: 'createServer' }); }, [ready, sp]);
  if (!ready) return null;
  return (
    <Routes>
      <Route path="" element={<Navigate to={`channels/${DEMO_START.guildId}/${DEMO_START.channelId}${location.search}`} replace />} />
      <Route path="channels/:guildId/:channelId?/:messageId?" element={<AppShell base="/demo" />} />
    </Routes>
  );
}
