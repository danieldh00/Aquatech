/**
 * Playwright-configuratie voor de rooktests tegen de live omgeving (alleen lezen, snel, één werker).
 */
const { defineConfig } = require('@playwright/test');

const baseUrl = (process.env.SMOKE_BASE_URL || 'https://aquatech.den-hollander.com').replace(/\/+$/, '');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 30000,
  expect: { timeout: 10000 },
  retries: 1,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'resultaat.json' }]],
  use: {
    baseURL: `${baseUrl}/`,
    trace: 'off',
    screenshot: 'off',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    // Alleen lokaal nodig als de ingebouwde browser ontbreekt (SMOKE_CHROMIUM_PATH=/pad/naar/chromium).
    launchOptions: process.env.SMOKE_CHROMIUM_PATH ? { executablePath: process.env.SMOKE_CHROMIUM_PATH } : {},
  },
});
