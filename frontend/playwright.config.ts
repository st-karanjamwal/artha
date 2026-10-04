import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const API_PORT = 8765;
const WEB_PORT = 5174;
export const E2E_DATA_DIR =
  process.env.ARTHA_E2E_DATA ??
  (mkdirSync('.e2e-data', { recursive: true }), mkdtempSync(join('.e2e-data', 'run-')));
process.env.ARTHA_E2E_DATA = E2E_DATA_DIR;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `../backend/.venv/bin/uvicorn app.main:app --app-dir ../backend --port ${API_PORT}`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: {
        ARTHA_DATA_DIR: E2E_DATA_DIR,
        ARTHA_SETUP_TOKEN: 'e2e-setup-token',
        ARTHA_COOKIE_SECURE: 'false',
      },
      reuseExistingServer: false,
    },
    {
      command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { ARTHA_API: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
