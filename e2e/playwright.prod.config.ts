// Self-contained: tests/voice-prod.spec.ts starts its own server (serving the built web app) and LiveKit, so no webServer here
// (it can run next to a dev stack or another e2e run: ports 3120/7895-7897/52000-52100).
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, testMatch: /voice-prod\.spec/, testIgnore: undefined, webServer: [], reporter: [['list']], outputDir: './test-results-prod' });
