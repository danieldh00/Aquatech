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
const { homePage, aboutPage, contentPage, renderWith, groupPage, categoryPage, searchPage, productPage, notFoundPage } = require('./storefront-pages');
const { DEFAULT_SITE } = require('./shop-content');
const { loginPage, registerPage, accountPage, plannerPage } = require('./storefront-account-pages');
const { cartPage, checkoutPage, checkoutLoginPage, orderPage } = require('./storefront-order-pages');
const Shipping = require('./shipping');
const { readCart, writeCart, applyCartAction } = require('./storefront-cart');

/** Inhoud wanneer er geen opslag is: de standaardblokken, geen eigen pagina's. */
const DEFAULT_CONTENT = { site: DEFAULT_SITE, pages: [] };

/** Content-Security-Policy van de shop: alleen het eigen script voor de keuzelijsten van varianten; afbeeldingen van de webshop komen van https-adressen. */
const STOREFRONT_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' https:", "font-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SHARED_DIR = path.join(FRONTEND_DIR, 'shared');
/** Vaste bestanden die de shop serveert (pad onder assets/ → bestand en type). */
const ASSETS = {
  'brand.css': { file: path.join(SHARED_DIR, 'brand.css'), type: 'text/css; charset=utf-8' },
  'winkel.css': { file: path.join(__dirname, 'storefront.css'), type: 'text/css; charset=utf-8' },
  'varianten.js': { file: path.join(__dirname, 'storefront-variants.js'), type: 'text/javascript; charset=utf-8' },
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
/** Paden waar de winkelwagen en het afrekenformulier naartoe posten. */
const ORDER_POSTS = /^\/(winkelwagen|afrekenen)\/?$/;
const FONT_FILE = /^montserrat-latin-(400|600|700|800)-normal\.woff2$/;

/**
 * Maakt de router van de webshop.
 * @param {{ db: object, tenantId: string, settingsFor: Function, accounts?: object, content?: object, previewAllowed?: Function, orders?: object, orderMail?: object, onOrder?: Function }} options db = database, tenantId = omgeving waarvan de artikelen getoond worden, settingsFor(tenantId) = instellingen van die omgeving (leest `storefront` en `shopOrdering`), accounts = de accountfuncties (shop-accounts.js; zonder geen inloggen), content = de opgeslagen inhoud uit Beheer (shop-content.js; zonder geldt de standaard), previewAllowed(req) = of dit verzoek een beheerder is die het concept mag bekijken (`?voorbeeld=1`), orders = de bestelopslag (web-orders.js; zonder geen bestellen), orderMail = de bevestigingsmail (web-orders-mail.js) en onOrder(req, order) = aanroep na een geplaatste bestelling (auditlog).
 * @returns {Function} Express-router, te monteren met app.use('/winkel', router).
 */
function createStorefront({ db, tenantId, settingsFor, accounts = null, content = null, previewAllowed = () => false, orders = null, orderMail = null, onOrder = () => {} }) {
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
   * @param {number} unversionedSeconds Hoe lang (s) zonder versie in het adres gecachet mag worden.
   * @returns {void}
   */
  const sendAsset = (res, file, type, versioned, unversionedSeconds = 300) => {
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : `public, max-age=${unversionedSeconds}`);
    res.type(type);
    fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
  };

  /**
   * Bouwt een HTML-pagina op met de inhoud uit Beheer en stuurt hem met de kopjes van de shop.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {number} status De statuscode.
   * @param {Function} render Functie zonder argumenten die de pagina (HTML) opbouwt.
   * @returns {void}
   */
  const sendPage = (req, res, status, render) => {
    const preview = isPreview(req);
    const ordering = orderingOn();
    res.status(status);
    if (preview) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); }
    else if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', ordering ? 'private, no-cache' : 'no-cache');
    const html = renderWith(contentOf(req), render, { ordering, cartCount: ordering ? readCart(req).reduce((total, line) => total + line.qty, 0) : 0 });
    res.type('html').send(html.replace(/<!--planner:([^>]*)-->/g, (_, root) => (plannerOn() ? `<li class="nav-planner"><a href="${root}planner/">Planner</a></li>` : '')));
  };
  /**
   * Of dit verzoek het concept van de inhoud moet tonen: `?voorbeeld=1` door een beheerder.
   * @param {object} req Het verzoek.
   * @returns {boolean} true bij een voorbeeld.
   */
  const isPreview = (req) => req.query.voorbeeld === '1' && Boolean(content) && previewAllowed(req);
  /**
   * De inhoud uit Beheer waarmee een pagina wordt getekend (gepubliceerd, of het concept bij een voorbeeld).
   * @param {object} req Het verzoek.
   * @returns {{ site: object, pages: object[] }} Blokken en pagina's.
   */
  const contentOf = (req) => (content ? content.publicContent(tenantId, { preview: isPreview(req) }) : DEFAULT_CONTENT);
  /**
   * Of het kopje Planner (aanmelden en doorgaan naar de planner) aan staat.
   * @returns {boolean} true als de instelling shopPlanner aan staat en de shop accounts heeft.
   */
  const plannerOn = () => Boolean(accounts) && settingsFor(tenantId).get('shopPlanner') !== false;
  /**
   * Of bestellen aan staat: de instelling shopOrdering, met accounts en een bestelopslag.
   * @returns {boolean} true als klanten mogen bestellen.
   */
  const orderingOn = () => Boolean(orders) && Boolean(accounts) && settingsFor(tenantId).get('shopOrdering') === true;

  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', STOREFRONT_CSP);
    res.setHeader('Referrer-Policy', 'same-origin');
    const accountPost = req.method === 'POST' && accounts && (ACCOUNT_POSTS.test(req.path) || (orders && ORDER_POSTS.test(req.path)));
    if (req.method !== 'GET' && req.method !== 'HEAD' && !accountPost) return res.status(405).set('Allow', 'GET, HEAD').end();
    const previewFile = Boolean(content) && /^\/(assets|media)\//.test(req.path) && previewAllowed(req);
    if (!settingsFor(tenantId).get('storefront') && !isPreview(req) && !previewFile) return res.status(404).type('text').send('Niet gevonden.');
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
    sendAsset(res, path.join(SHARED_DIR, 'fonts', req.params.name), 'font/woff2', Boolean(req.query.v), 86400);
  });

  router.get('/', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    sendPage(req, res, 200, () => homePage(data.catalogOf(tenantId)));
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
     * @param {object} req Het verzoek.
     * @param {object} res Het antwoord.
     * @param {number} status De statuscode.
     * @param {Function} render Functie (groepen) => HTML.
     * @returns {void}
     */
    const sendWithGroups = (req, res, status, render) => sendPage(req, res, status, () => render(data.catalogOf(tenantId).groups));

    router.get('/account', (req, res) => {
      if (withSlash(req, res)) return;
      const viewer = accounts.viewer(req);
      if (!viewer) return res.redirect(302, '../inloggen/');
      res.setHeader('Cache-Control', 'no-store');
      sendWithGroups(req, res, 200, (groups) => accountPage(viewer, groups));
    });
    /**
     * Waar een bezoeker na inloggen of registreren naartoe gaat (het veld volgende): de planner, het afrekenen of het account.
     * @param {*} value De waarde van het veld.
     * @returns {string} 'planner', 'afrekenen' (alleen als bestellen aan staat) of ''.
     */
    const nextOf = (value) => (value === 'planner' || (value === 'afrekenen' && orderingOn()) ? value : '');
    /**
     * Het adres (relatief aan een pagina één niveau diep) waar een bezoeker naartoe gaat na inloggen of registreren.
     * @param {string} next 'planner', 'afrekenen' of ''.
     * @param {string} fallback Adres als er geen bestemming is.
     * @returns {string} Het relatieve adres.
     */
    const destination = (next, fallback) => (next === 'planner' && plannerOn() ? '../../beregening/' : next === 'afrekenen' ? '../afrekenen/' : fallback);
    router.get('/inloggen', (req, res) => {
      if (withSlash(req, res)) return;
      const next = nextOf(req.query.volgende);
      if (accounts.viewer(req)) return res.redirect(302, destination(next, '../account/'));
      sendWithGroups(req, res, 200, (groups) => loginPage({ next }, groups));
    });
    router.get('/registreren', (req, res) => {
      if (withSlash(req, res)) return;
      const next = nextOf(req.query.volgende);
      if (accounts.viewer(req)) return res.redirect(302, destination(next, '../account/'));
      sendWithGroups(req, res, 200, (groups) => registerPage({ next: next === 'afrekenen' ? next : '' }, groups));
    });
    router.post('/inloggen', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      try {
        const out = await accounts.login(req, res, { login: req.body?.login, password: req.body?.password });
        const next = nextOf(req.body?.volgende);
        if (out.error) return sendWithGroups(req, res, out.status, (groups) => loginPage({ error: out.error, login: String(req.body?.login ?? '').slice(0, 200), next }, groups));
        res.redirect(303, out.user.must_change_password ? '../../wachtwoord' : destination(next, '../account/'));
      } catch (error) { next(error); }
    });
    router.post('/registreren', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      try {
        const out = await accounts.register(req, res, req.body || {});
        if (out.skipped) return res.redirect(303, '../');
        const next = nextOf(req.body?.volgende) === 'afrekenen' ? 'afrekenen' : '';
        if (out.error) return sendWithGroups(req, res, out.status, (groups) => registerPage({ error: out.error, displayName: String(req.body?.displayName ?? '').slice(0, 80), email: String(req.body?.email ?? '').slice(0, 200), next }, groups));
        res.redirect(303, destination(next, '../account/'));
      } catch (error) { next(error); }
    });
    router.get('/planner', (req, res) => {
      if (withSlash(req, res)) return;
      if (!plannerOn()) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../', groups));
      if (accounts.viewer(req)) return res.redirect(302, '../../beregening/');
      sendWithGroups(req, res, 200, (groups) => plannerPage({}, groups));
    });
    router.post('/planner', form, async (req, res, next) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      if (!plannerOn()) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../', groups));
      try {
        const out = await accounts.register(req, res, { ...(req.body || {}), password2: undefined });
        if (out.skipped) return res.redirect(303, '../');
        if (out.error) return sendWithGroups(req, res, out.status, (groups) => plannerPage({ error: out.error, displayName: String(req.body?.displayName ?? '').slice(0, 80), email: String(req.body?.email ?? '').slice(0, 200) }, groups));
        res.redirect(303, '../../beregening/');
      } catch (error) { next(error); }
    });
    router.post('/uitloggen', (req, res) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      accounts.logout(req, res);
      res.redirect(303, '../');
    });

    if (orders) {
      const orderLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `order:${remoteIp(req)}` });
      /**
       * Past de bestellimiet toe zonder JSON-antwoord.
       * @param {object} req Het verzoek.
       * @param {object} res Het antwoord.
       * @returns {boolean} true als het verzoek geweigerd moet worden.
       */
      const orderLimited = (req, res) => {
        let refused = false;
        orderLimiter(req, { setHeader: (name, value) => res.setHeader(name, value), status: () => ({ json: () => { refused = true; } }) }, () => {});
        return refused;
      };
      /**
       * Antwoord als bestellen uit staat: de pagina bestaat dan niet.
       * @param {object} req Het verzoek.
       * @param {object} res Het antwoord.
       * @returns {void}
       */
      const orderingOff = (req, res) => sendWithGroups(req, res, 404, (groups) => notFoundPage('../', groups));

      router.get('/winkelwagen', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const cart = orders.priceCart(tenantId, readCart(req));
        sendWithGroups(req, res, 200, (groups) => cartPage(cart, groups));
      });
      router.post('/winkelwagen', form, (req, res) => {
        if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
        if (!orderingOn()) return orderingOff(req, res);
        writeCart(req, res, applyCartAction(readCart(req), req.body || {}));
        res.redirect(303, './');
      });
      /**
       * De verzendinstelling van deze winkel (de instelling `shopShipping`, gesaneerd).
       * @returns {object} De instelling met ophalen en DPD.
       */
      const shippingConfig = () => Shipping.sanitizeShipping(settingsFor(tenantId).get('shopShipping'));
      /**
       * Bepaalt het land en de verzendmethode die bij het afrekenen getoond worden.
       * @param {object} cart De geprijsde winkelwagen.
       * @param {object} input Het gekozen land en de gekozen methode (query of formulier).
       * @returns {{ quote: object, country: string, method: string }} De opties, het land (een bezorgbaar land) en de methode (de gekozen, anders de eerste beschikbare).
       */
      const checkoutChoice = (cart, input) => {
        const config = shippingConfig();
        const countries = Shipping.countriesOf(config);
        const asked = String(input.country || input.land || '').toUpperCase();
        const country = countries.some((entry) => entry.code === asked) ? asked : countries.length ? countries[0].code : 'NL';
        const quote = orders.shippingQuote(cart, config, country);
        const asking = String(input.shippingMethod || '');
        const available = quote.options.filter((option) => option.available);
        const method = available.some((option) => option.method === asking) ? asking : available.length ? available[0].method : '';
        return { quote, country, method };
      };

      router.get('/afrekenen', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const cart = orders.priceCart(tenantId, readCart(req));
        if (!cart.lines.length || !cart.ok) return res.redirect(302, '../winkelwagen/');
        const viewer = accounts.viewer(req);
        if (!viewer) return sendWithGroups(req, res, 200, (groups) => checkoutLoginPage(groups));
        sendWithGroups(req, res, 200, (groups) => checkoutPage({ cart, viewer, ...checkoutChoice(cart, req.query || {}) }, groups));
      });
      router.post('/afrekenen', form, async (req, res, next) => {
        if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
        if (!orderingOn()) return orderingOff(req, res);
        const viewer = accounts.viewer(req);
        if (!viewer) return res.redirect(303, './');
        const body = req.body || {};
        // Land wijzigen: alleen de pagina opnieuw tonen met de kosten voor dat land, zonder te bestellen.
        if (body.action === 'update') {
          res.setHeader('Cache-Control', 'no-store');
          const cart = orders.priceCart(tenantId, readCart(req));
          if (!cart.lines.length || !cart.ok) return res.redirect(303, '../winkelwagen/');
          return sendWithGroups(req, res, 200, (groups) => checkoutPage({ cart, viewer, values: body, ...checkoutChoice(cart, body) }, groups));
        }
        if (orderLimited(req, res)) return res.status(429).type('text').send('Te veel bestellingen vanaf dit adres. Probeer het later opnieuw.');
        try {
          const out = orders.place(tenantId, { id: viewer.id }, body, readCart(req), shippingConfig());
          if (out.cart) return res.redirect(303, '../winkelwagen/');
          if (out.error) {
            const cart = orders.priceCart(tenantId, readCart(req));
            return sendWithGroups(req, res, out.status, (groups) => checkoutPage({ cart, viewer, error: out.error, values: body, ...checkoutChoice(cart, body) }, groups));
          }
          writeCart(req, res, []);
          // De bestelling staat al vast: een fout in audit of mail mag de klant niet naar een foutpagina sturen, en de ene stap niet de andere overslaan.
          try { onOrder(req, out.order); } catch (failure) { console.error(`Audit van bestelling ${out.order.number} mislukt: ${failure.message}`); }
          try { if (orderMail) await orderMail.sendPlaced(tenantId, out.order); } catch (failure) { console.error(`Mail van bestelling ${out.order.number} mislukt: ${failure.message}`); }
          res.redirect(303, `../bestelling/${out.order.id}/`);
        } catch (error) { next(error); }
      });
      router.get('/bestelling/:id', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const viewer = accounts.viewer(req);
        if (!viewer) return res.redirect(302, '../../inloggen/');
        const order = orders.getForUser(tenantId, viewer.id, req.params.id);
        if (!order) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../../', groups));
        sendWithGroups(req, res, 200, (groups) => orderPage(order, groups));
      });
    }
  }

  // Over ons: de standaardpagina, of een eigen versie uit Beheer (pagina "over-ons").
  router.get('/over-ons', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const own = contentOf(req).pages.find((page) => page.slug === 'over-ons');
    sendPage(req, res, 200, () => (own ? contentPage(own, data.catalogOf(tenantId).groups, '../') : aboutPage(data.catalogOf(tenantId).groups)));
  });

  // Vaste pagina's uit Beheer.
  router.get('/pagina/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const page = contentOf(req).pages.find((candidate) => candidate.slug === req.params.slug);
    const groups = data.catalogOf(tenantId).groups;
    if (!page) return sendPage(req, res, 404, () => notFoundPage('../../', groups));
    sendPage(req, res, 200, () => contentPage(page, groups, '../../'));
  });

  // Afbeeldingen die in Beheer zijn geüpload; het id is onraadbaar en de afbeelding verandert nooit.
  router.get('/media/:id', (req, res) => {
    const file = content && /^[0-9a-f-]{36}$/.test(req.params.id) ? content.imageFile(tenantId, req.params.id) : null;
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(file.mime).send(file.body);
  });

  router.get('/groep/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/`);
    const catalog = data.catalogOf(tenantId);
    const group = catalog.groups.find((candidate) => candidate.slug === req.params.slug);
    if (!group) return sendPage(req, res, 404, () => notFoundPage('../../', catalog.groups));
    sendPage(req, res, 200, () => groupPage(group, catalog.groups));
  });

  router.get('/zoeken', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const catalog = data.catalogOf(tenantId);
    const query = typeof req.query.q === 'string' ? Array.from(req.query.q.trim()).slice(0, 80).join('') : '';
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const onlyInStock = req.query.voorraad === '1';
    const found = words.length
      ? catalog.products.filter((product) => {
        const base = `${product.name} ${product.code} ${product.categoryName}`;
        // Alle woorden moeten bij het hoofdartikel samen met één variant passen, niet verspreid over meerdere varianten;
        // bij het voorraadfilter moet diezelfde variant ook op voorraad zijn.
        const candidates = (product.variants || []).length
          ? product.variants.map((variant) => ({ haystack: `${base} ${variant.code} ${variant.label}`, inStock: variant.inStock }))
          : [{ haystack: base, inStock: product.inStock }];
        return candidates.some((candidate) => (!onlyInStock || candidate.inStock) && words.every((word) => candidate.haystack.toLowerCase().includes(word)));
      })
      : [];
    sendPage(req, res, 200, () => searchPage(query, found, catalog.groups, onlyInStock, isPreview(req)));
  });

  router.get('/categorie/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const catalog = data.catalogOf(tenantId);
    const category = catalog.categories.find((candidate) => candidate.slug === req.params.slug);
    if (!category) return sendPage(req, res, 404, () => notFoundPage('../../', catalog.groups));
    const onlyInStock = req.query.voorraad === '1';
    const inCategory = catalog.products.filter((product) => product.categorySlug === category.slug && (!onlyInStock || product.inStock));
    sendPage(req, res, 200, () => categoryPage(category, inCategory, catalog.groups, onlyInStock, isPreview(req)));
  });

  router.get('/product/:slug', (req, res) => {
    const pathname = req.originalUrl.split('?')[0];
    if (!pathname.endsWith('/')) return res.redirect(302, `${path.posix.basename(pathname)}/${req.originalUrl.slice(pathname.length)}`);
    const catalog = data.catalogOf(tenantId);
    const variant = catalog.variantProducts.find((candidate) => candidate.slug === req.params.slug);
    const parent = variant && catalog.products.find((candidate) => candidate.slug === variant.parentSlug);
    // Een variant krijgt de keuzelijst van zijn hoofdartikel en staat zelf geselecteerd.
    const product = catalog.products.find((candidate) => candidate.slug === req.params.slug)
      || (parent ? { ...variant, variants: parent.variants, attributeName: parent.attributeName } : variant);
    if (!product) return sendPage(req, res, 404, () => notFoundPage('../../', catalog.groups));
    const chosenCode = typeof req.query.v === 'string' ? req.query.v.slice(0, 80) : (variant ? variant.code : '');
    sendPage(req, res, 200, () => productPage(product, catalog.groups, chosenCode || (variant ? variant.code : '')));
  });

  router.use((req, res) => {
    const segments = req.path.split('/').filter(Boolean).length;
    const depth = req.path.endsWith('/') ? segments : Math.max(segments - 1, 0);
    sendPage(req, res, 404, () => notFoundPage('../'.repeat(depth), data.catalogOf(tenantId).groups));
  });
  router.clearCache = data.clearCache;
  return router;
}

module.exports = { createStorefront, STOREFRONT_CSP };
