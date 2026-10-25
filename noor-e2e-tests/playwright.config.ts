import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

// API projects call the backend directly; these headers must not reach browser page loads
const api = { extraHTTPHeaders: { Accept: 'application/json', 'X-Platform': process.env.X_PLATFORM ?? 'web' } };

// E2E projects drive the merchant panel in a browser, logged in once per area by tests/e2e/auth.setup.ts
const panelUrl = process.env.PANEL_URL ?? 'https://tmerchant.noor.uz';
const e2e = (area: 'delivery' | 'eats' | 'common') => [
  {
    name: `e2e-${area}-setup`,
    testDir: './tests/e2e',
    testMatch: /auth\.setup\.ts/,
    metadata: { authFile: `.auth/merchant-${area}.json` },
    use: { baseURL: panelUrl },
  },
  {
    name: `e2e-${area}`,
    testDir: `./tests/e2e/${area}`,
    dependencies: [`e2e-${area}-setup`],
    use: {
      ...devices['Desktop Chrome'],
      baseURL: panelUrl,
      locale: 'ru-RU',
      timezoneId: 'Asia/Tashkent',
      viewport: { width: 1440, height: 900 },
      storageState: `.auth/merchant-${area}.json`,
      // SLOWMO=800 npx playwright test … --headed  → watch each click/type step (milliseconds per action)
      launchOptions: { slowMo: Number(process.env.SLOWMO ?? 0) },
      screenshot: 'only-on-failure' as const,
      trace: 'retain-on-failure' as const,
    },
  },
];

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // One project per panel: npm run test:delivery / test:eats / test:common / test:admin / test:e2e:<area>
  projects: [
    { name: 'delivery', testDir: './tests/delivery', use: api },
    { name: 'eats', testDir: './tests/eats', use: api },
    { name: 'common', testDir: './tests/common', use: api },
    { name: 'admin', testDir: './tests/admin', use: api },
    ...e2e('delivery'),
    ...e2e('eats'),
    ...e2e('common'),
  ],
});
