import type { CapacitorConfig } from '@capacitor/cli';

// Production: bundle the web build (../web/dist) inside the app; it connects to the one server baked in via VITE_SERVER_URL (apps/web/.env.production).
// To load a live server instead (no rebuild needed for web updates), set CAP_SERVER_URL at sync time, e.g.
//   CAP_SERVER_URL=https://chat.example.com pnpm exec cap sync
const serverUrl = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'app.jorcord.mobile',
  appName: 'Jorcord',
  webDir: '../web/dist',
  backgroundColor: '#1e1f22',
  server: serverUrl
    ? { url: serverUrl, cleartext: serverUrl.startsWith('http://') }
    : { androidScheme: 'https', iosScheme: 'capacitor' },
  android: { allowMixedContent: false },
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  plugins: {
    SplashScreen: { launchShowDuration: 800, backgroundColor: '#1e1f22', showSpinner: false },
    Keyboard: { resize: 'body', resizeOnFullScreen: true },
    StatusBar: { style: 'DARK', backgroundColor: '#1e1f22', overlaysWebView: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    LocalNotifications: { smallIcon: 'ic_stat_jorcord', iconColor: '#5865f2' },
  },
};

export default config;
