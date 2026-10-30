// Eigen webshop (stap 1, alleen lezen): openbare, server-side opgebouwde
// pagina's voor de artikelen uit de voorraad: startpagina, hoofdcategorie
// (/groep/), categorie, zoeken (/zoeken/) en productpagina (/product/<slug>/, zoals WooCommerce). Geen winkelwagen
// of betaling; wel inloggen en registreren (accounts.js: dezelfde accounts als de planner). De shop is een Express-router die op een eigen
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
const { loginPage, registerPage, accountPage, plannerPage } = require('./storefront-account-pages');

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
  'favicon.png': { file: path.join(SHARED_DIR, 'icons', 'favicon-48.png'), type: 'image/png' },
};
/** Afbeeldingen van de shop zelf (logo, hero, merken, pictogrammen) uit de map assets/ naast dit bestand. */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
for (const name of fs.readdirSync(path.join(__dirname, 'assets'))) {
  const type = IMAGE_TYPES[path.extname(name)];
  if (type) ASSETS[name] = { file: path.join(__dirname, 'assets', name), type };
}
/** Paden waar een formulier naartoe mag posten (inloggen, registreren, uitloggen, planner). */
const ACCOUNT_POSTS = /^\/(inloggen|registreren|uitloggen|planner)\/?$/;
const FONT_FILE = /^montserrat-latin-(400|600|700|800)-normal\.woff2$/;

/**
 * Maakt de router van de webshop.
 * @param {{ db: object, tenantId: string, settingsFor: Function, accounts?: object }} options db = database, tenantId = omgeving waarvan de artikelen getoond worden, settingsFor(tenantId) = instellingen van die omgeving (leest `storefront`) en accounts = de accountfuncties (shop-accounts.js; zonder geen inloggen).
 * @returns {Function} Express-router, te monteren met app.use('/winkel', router).
 */
function createStorefront({ db, tenantId, settingsFor, accounts = null }) {
  const data = createStorefrontData(db);
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 240, keyFn: remoteIp });

  /**
   * Stuurt een bestand (CSS, afbeelding, lettertype). Met `?v=<versie>` in het
   * adres (zo linkt elke pagina) een jaar cache, want een nieuwe versie heeft een
   * ander adres; zonder versie maar 5 minuten, zodat een oude CSS niet blijft hangen.
   * @param {object} res Het antwoord.
   * @param {string} file Pad van het bestand.
   * @param {string} type Content-Type.
   * @param {boolean} versioned Of het adres een versie bevat.
   * @returns {void}
   */
  const sendAsset = (res, file, type, versioned) => {
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
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
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(/<!--planner:([^>]*)-->/g, (_, root) => (plannerOn() ? `<li class="nav-planner"><a href="${root}planner/">Planner</a></li>` : '')));
  };
  /**
   * Of het kopje Planner (aanmelden en doorgaan naar de planner) aan staat.
   * @returns {boolean} true als de instelling shopPlanner aan staat en de shop accounts heeft.
   */
  const plannerOn = () => Boolean(accounts) && settingsFor(tenantId).get('shopPlanner') !== false;

  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
    res.setHeader('Referrer-Policy', 'same-origin');
    const accountPost = req.method === 'POST' && accounts && ACCOUNT_POSTS.test(req.path);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !accountPost) return res.status(405).set('Allow', 'GET, HEAD').end();
    if (!settingsFor(tenantId).get('storefront')) return res.status(404).type('text').send('Niet gevonden.');
    next();
  });
  router.use(limiter);

  router.get('/assets/:name', (req, res) => {
    const asset = Object.prototype.hasOwnProperty.call(ASSETS, req.params.name) ? ASSETS[req.params.name] : null;
    if (!asset) return res.status(404).end();
    sendAsset(res, asset.file, asset.type, Boolean(req.query.v));
  });
  router.get('/assets/fonts/:name', (req, res) => {
    if (!FONT_FILE.test(req.params.name)) return res.status(404).end();
    sendAsset(res, path.join(SHARED_DIR, 'fonts', req.params.name), 'font/woff2', true);
  });

  router.get('/', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    sendPage(res, 200, homePage(data.catalogOf(tenantId)));
  });

  if (accounts) {
    const form = express.urlencoded({ extended: false, limit: '4kb' });
    /**
     * Weigert een formulier van een andere site (zelfde regel als de API).
     * @param {object} req Het verzoek.
     * @returns {boolean} true als het verzoek van een andere site komt.
     */
    const crossSite = (req) => ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
    /**
     * Stuurt een bezoeker zonder slash naar het adres met slash.
     * @param {object} req Het verzoek.
     * @param {object} res Het antwoord.
     * @returns {boolean} true als er is doorverwezen.
     */
    const withSlash = (req, res) => {
      const pathname = req.originalUrl.split('?')[0];
      if (pathname.endsWith('/')) return false;
      res.redirect(302, `${path.posix.basename(pathname)}/`);
      return true;
    };
    /**
     * Stuurt een pagina met de productgroepen voor het menu.
     * @param {object} res Het antwoord.
     * @param {number} status De statuscode.
     * @param {Function} render Functie (groepen) => HTML.
     * @returns {void}
     */
    const sendWithGroups = (res, status, render) => sendPage(res, status, render(data.catalogOf(tenantId).groups));

    router.get('/account', (req, res) => {
      if (withSlash(req, res)) return;
      const viewer = accounts.viewer(req);
      if (!viewer) return res.redirect(302, '../inloggen/');
      res.setHeader('Cache-Control', 'no-store');
      sendWithGroups(res, 200, (groups) => accountPage(viewer, groups));
    });
    router.get('/inloggen', (req, res) => {
      if (withSlash(req, res)) return;
      if (accounts.viewer(req)) return res.redirect(302, req.query.volgende === 'planner' ? '../../beregening/' : '../account/');
      sendWithGroups(res, 200, (groups) => loginPage({ next: req.query.volgende === 'planner' ? 'planner' : '' }, groups));
    });
    router.get('/registreren', (req, res) => {
      if (withSlash(req, res)) return;
      if (accounts.viewer(req)) return res.redirect(302, '../account/');
      sendWithGroups(res, 200, (groups) => registerPage({}, groups));
    });
    router.post('/inloggen', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      try {
        const out = await accounts.login(req, res, { login: req.body?.login, password: req.body?.password });
        if (out.error) return sendWithGroups(res, out.status, (groups) => loginPage({ error: out.error, login: String(req.body?.login ?? '').slice(0, 200), next: req.body?.volgende === 'planner' ? 'planner' : '' }, groups));
        res.redirect(303, out.user.must_change_password ? '../../wachtwoord' : req.body?.volgende === 'planner' && plannerOn() ? '../../beregening/' : '../account/');
      } catch (error) { next(error); }
    });
    router.post('/registreren', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      try {
        const out = await accounts.register(req, res, req.body || {});
        if (out.skipped) return res.redirect(303, '../');
        if (out.error) return sendWithGroups(res, out.status, (groups) => registerPage({ error: out.error, displayName: String(req.body?.displayName ?? '').slice(0, 80), email: String(req.body?.email ?? '').slice(0, 200) }, groups));
        res.redirect(303, '../account/');
      } catch (error) { next(error); }
    });
    router.get('/planner', (req, res) => {
      if (withSlash(req, res)) return;
      if (!plannerOn()) return sendWithGroups(res, 404, (groups) => notFoundPage('../', groups));
      if (accounts.viewer(req)) return res.redirect(302, '../../beregening/');
      sendWithGroups(res, 200, (groups) => plannerPage({}, groups));
    });
    router.post('/planner', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      if (!plannerOn()) return sendWithGroups(res, 404, (groups) => notFoundPage('../', groups));
      try {
        const out = await accounts.register(req, res, { ...(req.body || {}), password2: undefined });
        if (out.skipped) return res.redirect(303, '../');
        if (out.error) return sendWithGroups(res, out.status, (groups) => plannerPage({ error: out.error, displayName: String(req.body?.displayName ?? '').slice(0, 80), email: String(req.body?.email ?? '').slice(0, 200) }, groups));
        res.redirect(303, '../../beregening/');
      } catch (error) { next(error); }
    });
    router.post('/uitloggen', (req, res) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      accounts.logout(req, res);
      res.redirect(303, '../');
    });
  }

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
