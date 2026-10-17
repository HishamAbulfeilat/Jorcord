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
import { isNative } from './lib/server';
import { setLocale } from './i18n';
import { useUI } from './stores/ui';

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
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}><BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary><App /></ErrorBoundary></BrowserRouter></QueryClientProvider>
    </React.StrictMode>,
  );
}
