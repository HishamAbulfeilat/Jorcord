import { defineConfig } from '@playwright/test';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const reuse = !process.env.CI;

export default defineConfig({
  testDir: './tests',
  testMatch: /perf-soak\.spec\.ts/,
  // screenshots are produced on demand: `pnpm e2e:shots`
    outputDir: './test-results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:5273',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      executablePath: CHROMIUM,
      args: [
        '--no-sandbox',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: [
    { command: 'node scripts/server.mjs', port: 3100, timeout: 90_000, reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe' },
    { command: 'node scripts/web.mjs', port: 5273, timeout: 90_000, reuseExistingServer: reuse, stdout: 'pipe', stderr: 'pipe' },
  ],
});
