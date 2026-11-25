/**
 * W0-spike: browserkant. Neemt de door de server getekende productpagina over (hydratie)
 * en zet een vlag zodra dat zonder waarschuwing is gelukt.
 */
import { createSSRApp } from 'vue';
import ProductPage from './ProductPage.vue';

const state = JSON.parse(document.getElementById('state')?.textContent || '{}');
const app = createSSRApp(ProductPage, state);
const warnings: string[] = [];
app.config.warnHandler = (message) => warnings.push(message);
app.mount('#app');
(window as unknown as { hydrated: { warnings: string[] } }).hydrated = { warnings };
