import { defineConfig } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    extraHTTPHeaders: { Accept: 'application/json', 'X-Platform': process.env.X_PLATFORM ?? 'web' },
  },
  // One project per panel: npm run test:delivery / test:eats / test:common / test:admin
  projects: [
    { name: 'delivery', testDir: './tests/delivery' },
    { name: 'eats', testDir: './tests/eats' },
    { name: 'common', testDir: './tests/common' },
    { name: 'admin', testDir: './tests/admin' },
  ],
});
