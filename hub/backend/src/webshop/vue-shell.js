// Brug naar de Vue-tekenlaag van de webshop (hub/frontend-vue/src/shop): laadt het gebouwde bestand `shop-ssr.mjs` en tekent daarmee de
// schil (kop, menu, voet) van een pagina. Staat uit tenzij SHOP_VUE_SHELL=1 en het bestand er is; dan blijft de oude schil in
// storefront-pages.js gewoon werken. Het gebouwde bestand komt uit de Docker-bouwstap (zie hub/Dockerfile, bouwargument VUE_SHOP).
const path = require('path');
const { pathToFileURL } = require('url');
const { FRONTEND_DIR } = require('../paths');

/** Hoeveel verschillende schillen hoogstens onthouden worden (kop, menu en voet hangen af van klantgroep, winkelwagen en pagina-adres). */
const CACHE_SIZE = 300;

const state = { render: null, loading: null, cache: new Map() };

/**
 * Het pad van het gebouwde bestand (naast de frontend-map in het image; SHOP_SSR_BUNDLE wijkt daarvan af, voor tests).
 * @returns {string} Het pad.
 */
function bundlePath() {
  return process.env.SHOP_SSR_BUNDLE || path.join(FRONTEND_DIR, '..', 'shop-ssr', 'shop-ssr.mjs');
}

/**
 * Laadt de tekenlaag als SHOP_VUE_SHELL=1 staat. Een ontbrekend of kapot bestand geeft een waarschuwing en de oude schil.
 * @returns {Promise<boolean>} Of de Vue-schil daarna actief is.
 */
function preload() {
  if (process.env.SHOP_VUE_SHELL !== '1') return Promise.resolve(false);
  if (!state.loading) {
    state.loading = import(pathToFileURL(bundlePath()).href)
      .then((module) => { state.render = module.renderShell; return true; })
      .catch((error) => { console.warn(`[webshop] Vue-schil niet geladen (${error.code || error.message}); de oude schil blijft in gebruik.`); return false; });
  }
  return state.loading;
}

/**
 * Zet zelf een tekenfunctie (voor tests).
 * @param {?Function} render Functie (schilgegevens) → belofte van de HTML, of null om uit te zetten.
 * @returns {void}
 */
function configure(render) {
  state.render = render;
  state.cache.clear();
}

/**
 * Of de Vue-schil nu gebruikt kan worden.
 * @returns {boolean} Waar als de tekenlaag geladen is.
 */
function ready() {
  return typeof state.render === 'function';
}

/**
 * Tekent de schil, met een kleine geheugencache op de gegevens (dezelfde klantgroep op dezelfde pagina geeft dezelfde schil).
 * @param {object} shell De gegevens van de schil.
 * @returns {Promise<string>} De HTML van de schil, met het commentaar `<!--shop-body-->` op de plek van de inhoud.
 */
async function render(shell) {
  const key = JSON.stringify(shell);
  const known = state.cache.get(key);
  if (known !== undefined) return known;
  const html = await state.render(shell);
  if (state.cache.size >= CACHE_SIZE) state.cache.delete(state.cache.keys().next().value);
  state.cache.set(key, html);
  return html;
}

module.exports = { preload, configure, ready, render, bundlePath };
