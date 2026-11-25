/**
 * W0-spike: rendert de productpagina met Vue (SSR) en met de bestaande
 * sjabloonfunctie, vergelijkt de HTML van het artikelblok en meet tijd en CPU.
 * Gebruik: `node spike/spike.mjs` in hub/frontend-vue; hydratie: `node spike/hydrate.mjs`.
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';

const require = createRequire(import.meta.url);
const pages = require('../../backend/src/webshop/storefront-pages.js');
const { DEFAULT_SITE } = require('../../backend/src/webshop/shop-content.js');

const product = {
  name: 'Rain Bird 5000 sproeier', code: 'RB-5000', slug: 'rain-bird-5000', image: 'media/rb5000.webp', unit: 'stuk',
  vatRate: 21, priceIncl: 12.5, priceBusiness: 10.33, priceBusinessIncl: 12.5, inStock: true, stockQty: 3, variants: [],
  groupSlug: 'sproeiers', groupName: 'Sproeiers', categorySlug: 'sproeiers-gazon', categoryName: 'Gazonsproeiers',
};
const groups = [{ slug: 'sproeiers', name: 'Sproeiers', categories: [] }];
const shop = { indexing: false, ordering: true, cartCount: 0, business: false, staff: false, wholesale: false, baseUrl: '', analytics: '', clarity: '', captcha: '' };
const content = { site: DEFAULT_SITE, pages: [] };

/**
 * Pakt het artikelblok (kruimelpad + artikel) uit een volledige pagina en haalt witruimte weg.
 * @param {string} html De HTML.
 * @returns {string} Genormaliseerd blok.
 */
function articleBlock(html) {
  const start = html.indexOf('<nav class="crumbs"');
  const end = html.indexOf('</article>') + '</article>'.length;
  return html.slice(start, end).replace(/<!--[\s\S]*?-->/g, '').replace(/<ul class="trust-strip".*?<\/ul>/, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}

const vite = await createServer({ configFile: false, plugins: [vue()], server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { default: ProductPage } = await vite.ssrLoadModule('/spike/ProductPage.vue');

const oldHtml = pages.renderWith(content, () => pages.productPage(product, groups), shop);
const newHtml = await renderToString(createSSRApp(ProductPage, { product, ordering: true }));
const oldBlock = articleBlock(oldHtml);
const newBlock = articleBlock(newHtml.replace(/<!--\[-->|<!--\]-->/g, ''));
console.log('HTML gelijk (genormaliseerd):', oldBlock === newBlock);
if (oldBlock !== newBlock) { console.log('OUD :', oldBlock); console.log('NIEUW:', newBlock); }

/**
 * Meet de gemiddelde tijd en CPU van een weergave.
 * @param {string} label Naam in de uitvoer.
 * @param {() => Promise<unknown>} render De weergave.
 * @param {number} rounds Aantal herhalingen.
 */
async function measure(label, render, rounds) {
  for (let warm = 0; warm < 200; warm += 1) await render();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let round = 0; round < rounds; round += 1) await render();
  const wall = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(`${label}: ${(wall / rounds).toFixed(3)} ms per pagina, CPU ${((cpu.user + cpu.system) / 1000 / rounds).toFixed(3)} ms per pagina, ${Math.round(rounds / (wall / 1000))} pagina's/s`);
}
await measure('oud (sjabloonfunctie)', async () => pages.renderWith(content, () => pages.productPage(product, groups), shop), 5000);
await measure('nieuw (Vue SSR)      ', async () => renderToString(createSSRApp(ProductPage, { product, ordering: true })), 5000);

await vite.close();

export { product, newHtml };
