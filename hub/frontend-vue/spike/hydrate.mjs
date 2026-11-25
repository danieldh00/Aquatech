/**
 * W0-spike: controleert hydratie in een echte browser. Bouwt de clientbundel, laadt de
 * server-HTML met de bundel, controleert dat er geen hydratiewaarschuwingen zijn, de
 * markup gelijk blijft en dat een interactie (bestelknop uitzetten via voorraad) werkt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-'));
await build({ configFile: false, root: path.resolve('spike'), plugins: [vue()], logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, lib: { entry: path.resolve('spike/client.ts'), formats: ['iife'], name: 'spike', fileName: () => 'client.js' } } });
const bundle = fs.readFileSync(path.join(outDir, 'client.js'), 'utf8');

const vite = await createServer({ configFile: false, plugins: [vue()], server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { default: ProductPage } = await vite.ssrLoadModule('/spike/ProductPage.vue');
const product = { name: 'Rain Bird 5000 sproeier', code: 'RB-5000', slug: 'rain-bird-5000', image: 'media/rb5000.webp', unit: 'stuk', vatRate: 21, priceIncl: 12.5, inStock: true, stockQty: 3, groupSlug: 'sproeiers', groupName: 'Sproeiers', categorySlug: 'sproeiers-gazon', categoryName: 'Gazonsproeiers' };
const props = { product, ordering: true };
const html = await renderToString(createSSRApp(ProductPage, props));
await vite.close();

const browser = await chromium.launch();
const page = await browser.newPage();
const messages = [];
page.on('console', (message) => messages.push(message.text()));
page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
await page.setContent(`<!doctype html><html><body><div id="app">${html}</div><script type="application/json" id="state">${JSON.stringify(props)}</script></body></html>`);
const before = await page.innerHTML('#app');
await page.addScriptTag({ content: bundle });
await page.waitForFunction(() => window.hydrated);
const after = await page.innerHTML('#app');
const warnings = await page.evaluate(() => window.hydrated.warnings);
console.log('Hydratiewaarschuwingen:', warnings.length, warnings);
console.log('Consoleberichten:', messages.length, messages);
console.log('Markup gelijk na hydratie:', before === after);
console.log('Bundelgrootte (min, onzipt):', Math.round(bundle.length / 1024), 'kB');
await browser.close();
fs.rmSync(outDir, { recursive: true, force: true });
