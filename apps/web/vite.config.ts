import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

const target = process.env.JORCORD_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/gateway': { target, ws: true, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Jorcord', short_name: 'Jorcord', description: 'Free, open chat for communities and friends.',
        theme_color: '#1e1f22', background_color: '#313338', display: 'standalone', start_url: '/', scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Web Push handlers (push + notificationclick) live in public/push-sw.js
        importScripts: ['push-sw.js'],
        navigateFallbackDenylist: [/^\/api/, /^\/gateway/, /^\/files/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
});
