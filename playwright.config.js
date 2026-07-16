// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // Spins up a plain static server for the demo page - no external
  // network calls needed, so it works the same locally and in CI.
  webServer: {
    command: 'python3 -m http.server 4173 --directory public',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 20 * 1000,
  },
});
