import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
// Identifies this exact build. The deployed copy publishes it in /version.json so an open tab can tell it has been superseded.
const buildId = Date.now().toString(36);
const versionJson = { name: 'version-json', apply: 'build' as const, closeBundle() { writeFileSync(path.resolve(__dirname, 'dist/version.json'), JSON.stringify({ version: pkg.version, build: buildId })); } };

const target = process.env.JORCORD_SERVER ?? 'http://localhost:3000';
// Public base path. '/' for the server / Tauri / Capacitor; '/Jorcord/' for GitHub Pages (set VITE_BASE).
const rawBase = process.env.VITE_BASE || '/';
const base = rawBase.endsWith('/') ? rawBase : rawBase + '/';

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(buildId) },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/gateway': { target, ws: true, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // vendor chunks cache independently of app code (an app deploy no longer invalidates react / livekit / hljs)
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/livekit-client|@livekit|protobuf|ts-debounce|events|loglevel|jose|sdp/.test(id)) return 'vendor-livekit';
          if (id.includes('highlight.js')) return 'vendor-hljs';
          if (/react-router|@remix-run/.test(id)) return 'vendor-router';
          if (/@dnd-kit/.test(id)) return 'vendor-dnd';
          if (/@tanstack/.test(id)) return 'vendor-query';
          if (/react-dom|\/react\/|scheduler/.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
  plugins: [
    react(),
    versionJson,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Jorcord', short_name: 'Jorcord', description: 'Free, open chat for communities and friends.',
        theme_color: '#1e1f22', background_color: '#313338', display: 'standalone', start_url: base, scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        navigateFallback: `${base}index.html`,
        // Web Push handlers (push + notificationclick) live in public/push-sw.js
        importScripts: ['push-sw.js'],
        navigateFallbackDenylist: [/^\/api/, /^\/gateway/, /^\/files/, new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(api|gateway|files)')],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // the ~2 MB RNNoise/WASM worklet is only needed when someone enables noise suppression: cache it on first use instead of on install
        globIgnores: ['**/NoiseSuppressorWorklet-*.js', '**/vision_wasm_*.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: ({ url }) => /\/assets\/NoiseSuppressorWorklet-.*\.js$/.test(url.pathname), handler: 'CacheFirst', options: { cacheName: 'jorcord-noise', expiration: { maxEntries: 2 } } },
          // avatars / attachments / emoji are content-addressed by id: serve from cache, bounded
          { urlPattern: ({ url, request }) => request.destination === 'image' && /^\/(api\/)?files\//.test(url.pathname), handler: 'StaleWhileRevalidate', options: { cacheName: 'jorcord-images', expiration: { maxEntries: 150, maxAgeSeconds: 14 * 24 * 3600, purgeOnQuotaError: true }, cacheableResponse: { statuses: [200] } } },
          { urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com', handler: 'CacheFirst', options: { cacheName: 'jorcord-fonts', expiration: { maxEntries: 20 } } },
        ],
      },
    }),
  ],
});
