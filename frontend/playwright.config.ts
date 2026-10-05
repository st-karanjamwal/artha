import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

// Two isolated stacks (backend + production preview) so specs don't share server state:
//   core: acceptance + screenshots     mf: mutual-fund acceptance (AMFI served from a local fixture)
const CORE = { api: 8765, web: 5174 };
const MF = { api: 8767, web: 5175, fixtures: 8766 };

mkdirSync('.e2e-data', { recursive: true });
export const E2E_DATA_DIR = process.env.ARTHA_E2E_DATA ?? mkdtempSync(join('.e2e-data', 'run-'));
export const E2E_MF_DATA_DIR =
  process.env.ARTHA_E2E_MF_DATA ?? mkdtempSync(join('.e2e-data', 'mf-'));
process.env.ARTHA_E2E_DATA = E2E_DATA_DIR;
process.env.ARTHA_E2E_MF_DATA = E2E_MF_DATA_DIR;

const api = (port: number, dataDir: string, extra: Record<string, string> = {}) => ({
  command: `../backend/.venv/bin/uvicorn app.main:app --app-dir ../backend --port ${port}`,
  url: `http://127.0.0.1:${port}/api/health`,
  env: {
    ARTHA_DATA_DIR: dataDir,
    ARTHA_SETUP_TOKEN: 'e2e-setup-token',
    ARTHA_COOKIE_SECURE: 'false',
    ...extra,
  },
  reuseExistingServer: false,
});

const web = (port: number, apiPort: number, outDir: string) => ({
  command: `npx vite build --outDir ${outDir} && npx vite preview --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
  url: `http://127.0.0.1:${port}`,
  env: { ARTHA_API: `http://127.0.0.1:${apiPort}` },
  reuseExistingServer: false,
  timeout: 120_000,
});

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'core',
      testMatch: /(acceptance|screens)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${CORE.web}` },
    },
    {
      name: 'mf',
      testMatch: /mf.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${MF.web}` },
    },
  ],
  webServer: [
    api(CORE.api, E2E_DATA_DIR),
    web(CORE.web, CORE.api, '.e2e-data/dist-core'),
    {
      command: `../backend/.venv/bin/python -m http.server ${MF.fixtures} --bind 127.0.0.1 --directory src/features/mf/__fixtures__`,
      url: `http://127.0.0.1:${MF.fixtures}/NAVAll.sample.txt`,
      reuseExistingServer: false,
    },
    api(MF.api, E2E_MF_DATA_DIR, {
      ARTHA_AMFI_NAV_URL: `http://127.0.0.1:${MF.fixtures}/NAVAll.sample.txt`,
      ARTHA_NAV_HISTORY_PROVIDER: 'none',
    }),
    web(MF.web, MF.api, '.e2e-data/dist-mf'),
  ],
});
