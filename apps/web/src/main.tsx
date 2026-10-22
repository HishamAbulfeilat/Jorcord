import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { OverlayApp } from './overlay/OverlayApp';
import { isOverlayWindow, markOverlayDocument } from './lib/overlay';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './index.css';
import './cosmetics.css';

import { queryClient as qc } from './lib/queryClient';
import { isNative, isTauri } from './lib/server';
import { setLocale } from './i18n';
import { useUI } from './stores/ui';
import { useAuth } from './stores/auth';
import { hydrateSecureAuth, loadAuth } from './lib/authStorage';

setLocale(useUI.getState().prefs.language);
// Wrappers bundle their assets already (docs/WRAPPER_WEB_NEEDS.md section 7): no PWA service worker there.
if (!isNative()) registerSW({ immediate: true });

// The overlay is a second Tauri window that loads this same bundle: render only the overlay card there.
if (isOverlayWindow()) {
  markOverlayDocument();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><ErrorBoundary><OverlayApp /></ErrorBoundary></React.StrictMode>,
  );
} else {
  const render = () => ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}><BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary><App /></ErrorBoundary></BrowserRouter></QueryClientProvider>
    </React.StrictMode>,
  );
  // Desktop: the login tokens live in the OS keychain, which is async; load them into the auth store before the first render. Any failure renders anyway.
  if (isTauri()) {
    void hydrateSecureAuth().then((on) => { if (on) { const a = loadAuth(); useAuth.setState({ access: a.access ?? null, refresh: a.refresh ?? null }); } }).catch(() => {}).finally(render);
  } else render();
}
