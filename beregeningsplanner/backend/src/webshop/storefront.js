// Eigen webshop (stap 1, alleen lezen): openbare, server-side opgebouwde
// pagina's voor de artikelen uit de voorraad: startpagina, hoofdcategorie
// (/groep/), categorie, zoeken (/zoeken/) en productpagina (/product/<slug>/, zoals WooCommerce). Geen winkelwagen,
// betaling of accounts. De shop is een Express-router die op een eigen
// domein of onder een pad (bijv. /winkel/) kan worden gemonteerd en alleen
// de gegevenslaag (storefront-data.js) nodig heeft; daardoor later ook als
// eigen container te draaien. Staat uit tot de instelling `storefront` aan is.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { FRONTEND_DIR } = require('../paths');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { remoteIp } = require('../beveiliging/auth');
const { createStorefrontData } = require('./storefront-data');
const { homePage, groupPage, categoryPage, searchPage, productPage, notFoundPage } = require('./storefront-pages');

/** Content-Security-Policy van de shop: geen scripts; afbeeldingen van de webshop komen van https-adressen. */
const STOREFRONT_CSP = [
  "default-src 'none'", "style-src 'self'", "img-src 'self' https:", "font-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SHARED_DIR = path.join(FRONTEND_DIR, 'shared');
/** Vaste bestanden die de shop serveert (pad onder assets/ → bestand en type). */
const ASSETS = {
  'brand.css': { file: path.join(SHARED_DIR, 'brand.css'), type: 'text/css; charset=utf-8' },
  'winkel.css': { file: path.join(__dirname, 'storefront.css'), type: 'text/css; charset=utf-8' },
  'aquatechshop-logo.png': { file: path.join(__dirname, 'assets', 'aquatechshop-logo.png'), type: 'image/png' },
  'favicon.png': { file: path.join(SHARED_DIR, 'icons', 'favicon-48.png'), type: 'image/png' },
};
const FONT_FILE = /^montserrat-latin-(400|600|700|800)-normal\.woff2$/;

/**
 * Maakt de router van de webshop.
 * @param {{ db: object, tenantId: string, settingsFor: Function }} options db = database, tenantId = omgeving waarvan de artikelen getoond worden, settingsFor(tenantId) = instellingen van die omgeving (leest `storefront`).
 * @returns {Function} Express-router, te monteren met app.use('/winkel', router).
 */
function createStorefront({ db, tenantId, settingsFor }) {
  const data = createStorefrontData(db);
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 240, keyFn: remoteIp });

  /**
   * Stuurt een bestand (CSS, logo, lettertype) met een dag cache.
   * @param {object} res Het antwoord.
   * @param {string} file Pad van het bestand.
   * @param {string} type Content-Type.
   * @returns {void}
   */
  const sendAsset = (res, file, type) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(type);
    fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
  };

  /**
   * Stuurt een HTML-pagina met de kopjes van de shop.
   * @param {object} res Het antwoord.
   * @param {number} status De statuscode.
   * @param {string} html De pagina.
   * @returns {void}
   */
  const sendPage = (res, status, html) => {
    res.status(status);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  };

  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end();
    if (!settingsFor(tenantId).get('storefront')) return res.status(404).type('text').send('Niet gevonden.');
    next();
  });
  router.use(limiter);

  router.get('/assets/:name', (req, res) => {
    const asset = Object.prototype.hasOwnProperty.call(ASSETS, req.params.name) ? ASSETS[req.params.name] : null;
    if (!asset) return res.status(404).end();
    sendAsset(res, asset.file, asset.type);
  });
  router.get('/assets/fonts/:name', (req, res) => {
    if (!FONT_FILE.test(req.params.name)) return res.status(404).end();
    sendAsset(res, path.join(SHARED_DIR, 'fonts', req.params.name), 'font/woff2');
  });

  router.get('/', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    sendPage(res, 200, homePage(data.catalogOf(tenantId)));
  });

  router.get('/groep/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/`);
    const catalog = data.catalogOf(tenantId);
    const group = catalog.groups.find((candidate) => candidate.slug === req.params.slug);
    if (!group) return sendPage(res, 404, notFoundPage('../../', catalog.groups));
    sendPage(res, 200, groupPage(group, catalog.groups));
  });

  router.get('/zoeken', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const catalog = data.catalogOf(tenantId);
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = words.length
      ? catalog.products.filter((product) => words.every((word) => `${product.name} ${product.code} ${product.categoryName}`.toLowerCase().includes(word)))
      : [];
    sendPage(res, 200, searchPage(query, found, catalog.groups));
  });

  router.get('/categorie/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/`);
    const catalog = data.catalogOf(tenantId);
    const category = catalog.categories.find((candidate) => candidate.slug === req.params.slug);
    if (!category) return sendPage(res, 404, notFoundPage('../../', catalog.groups));
    sendPage(res, 200, categoryPage(category, catalog.products.filter((product) => product.categorySlug === category.slug), catalog.groups));
  });

  router.get('/product/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/`);
    const catalog = data.catalogOf(tenantId);
    const product = catalog.products.find((candidate) => candidate.slug === req.params.slug);
    if (!product) return sendPage(res, 404, notFoundPage('../../', catalog.groups));
    sendPage(res, 200, productPage(product, catalog.groups));
  });

  router.use((req, res) => {
    const segments = req.path.split('/').filter(Boolean).length;
    const depth = req.path.endsWith('/') ? segments : Math.max(segments - 1, 0);
    sendPage(res, 404, notFoundPage('../'.repeat(depth), data.catalogOf(tenantId).groups));
  });
  router.clearCache = data.clearCache;
  return router;
}

module.exports = { createStorefront, STOREFRONT_CSP };
