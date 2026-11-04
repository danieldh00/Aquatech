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
const { registerAddressRoute } = require('../platform/address-lookup');
const { remoteIp } = require('../beveiliging/auth');
const { createStorefrontData } = require('./storefront-data');
const { homePage, aboutPage, contentPage, renderWith, groupPage, categoryPage, searchPage, productPage, notFoundPage } = require('./storefront-pages');
const { DEFAULT_SITE } = require('./shop-content');
const { wantsBusiness } = require('./business-profile');
const { loginPage, registerPage, accountPage, plannerPage } = require('./storefront-account-pages');
const { cartPage, checkoutPage, checkoutLoginPage, orderPage, ordersPage } = require('./storefront-order-pages');
const { wholesalePage, orderableProducts } = require('./storefront-wholesale-pages');
const Wholesale = require('./wholesale');
const { returnsBlock } = require('./storefront-return-pages');
const { legalDefaults } = require('./legal-pages');
const Shipping = require('./shipping');
const Vat = require('./vat');
const { validPaymentId } = require('./mollie');
const { readCart, writeCart, applyCartAction, cartActionRejected, addCartLines, MAX_QTY } = require('./storefront-cart');

/** Inhoud wanneer er geen opslag is: de standaardblokken, geen eigen pagina's. */
const DEFAULT_CONTENT = { site: DEFAULT_SITE, pages: [] };

/** Content-Security-Policy van de shop: alleen de eigen scripts voor de keuzelijsten van varianten en het afrekenen (die laatste vraagt het adres bij een postcode op bij onze eigen server); afbeeldingen van de webshop komen van https-adressen. */
const STOREFRONT_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "style-src 'self'", "img-src 'self' https:", "font-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SHARED_DIR = path.join(FRONTEND_DIR, 'shared');
/** Vaste bestanden die de shop serveert (pad onder assets/ → bestand en type). */
const ASSETS = {
  'brand.css': { file: path.join(SHARED_DIR, 'brand.css'), type: 'text/css; charset=utf-8' },
  'winkel.css': { file: path.join(__dirname, 'storefront.css'), type: 'text/css; charset=utf-8' },
  'varianten.js': { file: path.join(__dirname, 'storefront-variants.js'), type: 'text/javascript; charset=utf-8' },
  'adres.js': { file: path.join(SHARED_DIR, 'address-lookup.js'), type: 'text/javascript; charset=utf-8' },
  'afrekenen.js': { file: path.join(__dirname, 'storefront-checkout.js'), type: 'text/javascript; charset=utf-8' },
  'groothandel.js': { file: path.join(__dirname, 'storefront-wholesale.js'), type: 'text/javascript; charset=utf-8' },
  'favicon.png': { file: path.join(SHARED_DIR, 'icons', 'favicon-48.png'), type: 'image/png' },
};
/** Afbeeldingen van de shop zelf (logo, hero, merken, pictogrammen) uit de map assets/ naast dit bestand. */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
for (const name of fs.readdirSync(path.join(__dirname, 'assets'))) {
  const type = IMAGE_TYPES[path.extname(name)];
  if (type) ASSETS[name] = { file: path.join(__dirname, 'assets', name), type };
}
/** Paden waar een formulier naartoe mag posten (inloggen, registreren, uitloggen, planner). */
const ACCOUNT_POSTS = /^\/(inloggen|registreren|uitloggen|planner|account\/zakelijk)\/?$/;
/** Paden waar de winkelwagen, het groothandelsvenster, het afrekenformulier, de webhook van Mollie en het retourformulier (met intrekken) naartoe posten. */
const ORDER_POSTS = /^\/(winkelwagen|afrekenen|groothandel|mollie\/webhook\/[^/]+|bestelling\/[^/]+\/retour(\/[^/]+\/intrekken)?)\/?$/;
/** Aantal bestellingen per pagina in de bestelhistorie van een klant. */
const HISTORY_PAGE = 25;
const FONT_FILE = /^montserrat-latin-(400|600|700|800)-normal\.woff2$/;

/**
 * Maakt de router van de webshop.
 * @param {{ addressLookup?: object, addressGuard?: object, db: object, tenantId: string, settingsFor: Function, accounts?: object, content?: object, itemImages?: object, previewAllowed?: Function, orders?: object, orderMail?: object, orderInvoices?: object, returns?: object, payments?: object, onOrder?: Function, onReturn?: Function }} options addressLookup = de opzoekdienst voor adressen (platform/address-lookup.js; zonder vult het afrekenformulier niets automatisch in), addressGuard = de adrescontrole (zonder wordt een Nederlands adres niet gecontroleerd), db = database, tenantId = omgeving waarvan de artikelen getoond worden, settingsFor(tenantId) = instellingen van die omgeving (leest `storefront` en `shopOrdering`), accounts = de accountfuncties (shop-accounts.js; zonder geen inloggen), content = de opgeslagen inhoud uit Beheer (shop-content.js; zonder geldt de standaard), itemImages = de afbeeldingen bij artikelen (item-images.js; zonder alleen de adressen van de webshopproducten), previewAllowed(req) = of dit verzoek een beheerder is die het concept mag bekijken (`?voorbeeld=1`), orders = de bestelopslag (web-orders.js; zonder geen bestellen), orderMail = de bevestigingsmail (web-orders-mail.js), orderInvoices = de facturen bij bestellingen (web-order-invoices.js; voor de factuur in de bestelhistorie) returns = de retouropslag (web-returns.js; zonder geen retourneren in het account), payments = het online betalen (web-payments.js; zonder alleen op rekening), onOrder(req, order) = aanroep na een geplaatste bestelling (auditlog) en onReturn(req, retour) = aanroep na een aangevraagde retour (auditlog).
 * @returns {Function} Express-router, te monteren met app.use('/winkel', router).
 */
function createStorefront({ addressLookup = null, addressGuard = null, db, tenantId, settingsFor, accounts = null, content = null, itemImages = null, previewAllowed = () => false, orders = null, orderMail = null, orderInvoices = null, returns = null, payments = null, onOrder = () => {}, onReturn = () => {} }) {
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
    // Een zakelijke klant ziet overal prijzen excl. btw; die pagina's zijn persoonlijk en worden niet gedeeld.
    const viewer = accounts ? accounts.viewer(req) : null;
    const business = Boolean(viewer) && viewer.customerGroup === 'zakelijk';
    if (business) res.setHeader('Cache-Control', 'private, no-store');
    const html = renderWith(contentOf(req), render, { ordering, cartCount: ordering ? (req.pendingCart || readCart(req)).reduce((total, line) => total + line.qty, 0) : 0, business, wholesale: ordering && business && viewer.wholesale });
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
  // Een categorie toont alle producten met hun foto: de afbeeldingen krijgen een ruimere eigen limiet.
  const imageLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 1200, keyFn: (req) => `foto:${remoteIp(req)}` });
  router.use((req, res, next) => (req.path.startsWith('/artikelfoto/') ? imageLimiter : limiter)(req, res, next));

  if (addressLookup) registerAddressRoute(router, '/adres/', addressLookup, createRateLimiter({ windowMs: 60 * 1000, max: 30, keyFn: (req) => `adres:${remoteIp(req)}` }));

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
      sendWithGroups(req, res, 200, (groups) => accountPage(viewer, groups, { ordering: orderingOn(), profile: accounts.businessProfile(viewer), requested: req.query.aangevraagd === '1' }));
    });
    router.post('/account/zakelijk', form, (req, res) => {
      if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
      const viewer = accounts.viewer(req);
      if (!viewer) return res.redirect(303, '../../inloggen/');
      if (!viewer.isCustomer) return res.status(403).type('text').send('Alleen klanten kunnen een zakelijk account aanvragen.');
      const out = accounts.requestBusiness(req, viewer, req.body || {});
      if (out.error) {
        const values = { companyName: String(req.body?.companyName ?? '').slice(0, 120), kvkNumber: String(req.body?.kvkNumber ?? '').slice(0, 20), vatNumber: String(req.body?.vatNumber ?? '').slice(0, 40) };
        res.setHeader('Cache-Control', 'no-store');
        return sendWithGroups(req, res, out.status, (groups) => accountPage(viewer, groups, { ordering: orderingOn(), profile: accounts.businessProfile(viewer), error: out.error, values }));
      }
      res.redirect(303, '../?aangevraagd=1');
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
        if (out.error) return sendWithGroups(req, res, out.status, (groups) => registerPage({ error: out.error, displayName: String(req.body?.displayName ?? '').slice(0, 80), email: String(req.body?.email ?? '').slice(0, 200), next,
          business: wantsBusiness(req.body?.business), companyName: String(req.body?.companyName ?? '').slice(0, 120), kvkNumber: String(req.body?.kvkNumber ?? '').slice(0, 20), vatNumber: String(req.body?.vatNumber ?? '').slice(0, 40) }, groups));
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

      /**
       * De klantgroep van de ingelogde bezoeker (bepaalt de prijzen in de winkelwagen).
       * @param {object} req Het verzoek.
       * @returns {string} 'zakelijk', of een lege tekst (particulier of niet ingelogd).
       */
      const groupOf = (req) => {
        const viewer = accounts.viewer(req);
        return viewer && viewer.customerGroup === 'zakelijk' ? 'zakelijk' : '';
      };

      /**
       * De groothandelsvoorwaarden van de ingelogde bezoeker (de vaste korting van een groothandelsklant), of niets.
       * @param {?{ wholesale?: boolean, wholesaleDiscount?: number }} viewer De ingelogde klant.
       * @returns {?{ discountPct: number }} De voorwaarden voor de prijsberekening, of null.
       */
      const wholesaleOf = (viewer) => (viewer && viewer.wholesale ? { discountPct: viewer.wholesaleDiscount } : null);
      /**
       * De klantgroep en groothandelsvoorwaarden waarmee de winkelwagen van deze bezoeker geprijsd wordt.
       * @param {object} req Het verzoek.
       * @returns {{ group: string, wholesale: ?{ discountPct: number } }} De opties voor priceCart.
       */
      const priceOptionsOf = (req) => ({ group: groupOf(req), wholesale: wholesaleOf(accounts.viewer(req)) });

      router.get('/winkelwagen', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
        sendWithGroups(req, res, 200, (groups) => cartPage(cart, groups, req.query.vol === '1' ? 'Je winkelwagen is vol: deze wijziging paste er niet meer bij. Plaats eerst deze bestelling en bestel de rest daarna.' : ''));
      });
      /**
       * Controleert dat de bezoeker een groothandelsklant is bij een bestelling; anders is de pagina er niet (of moet hij eerst inloggen).
       * @param {object} req Het verzoek.
       * @param {object} res Het antwoord.
       * @returns {?object} De ingelogde groothandelsklant, of null nadat er een antwoord is gestuurd.
       */
      const wholesaleViewer = (req, res) => {
        if (!orderingOn()) { orderingOff(req, res); return null; }
        const viewer = accounts.viewer(req);
        if (!viewer) { res.redirect(req.method === 'POST' ? 303 : 302, '../inloggen/'); return null; }
        if (!viewer.wholesale) { sendWithGroups(req, res, 404, (groups) => notFoundPage('../', groups)); return null; }
        return viewer;
      };
      /**
       * Zet gevraagde artikelen om in winkelwagenregels: onbekende codes vallen af (met een melding) en aantallen worden naar boven afgerond op de verpakkingseenheid en minimale afname.
       * @param {object} catalog De catalogus.
       * @param {{ code: string, qty: number }[]} wanted De gevraagde codes en aantallen.
       * @returns {{ entries: { code: string, qty: number }[], adjusted: object[], problems: object[] }} De regels voor de wagen, de aangepaste aantallen en de codes die niet bestaan.
       */
      const resolveWanted = (catalog, wanted) => {
        const byCode = new Map(orderableProducts(catalog).map((product) => [product.code.toUpperCase(), product]));
        const entries = [];
        const adjusted = [];
        const problems = [];
        for (const want of wanted) {
          const product = byCode.get(want.code);
          if (!product) { problems.push({ text: want.code, message: 'Onbekende artikelcode, of niet meer te koop.' }); continue; }
          const terms = { packSize: product.packSize, orderMinQty: product.minimum };
          const qty = Wholesale.roundUpQty(want.qty, terms);
          if (qty > MAX_QTY) { problems.push({ text: want.code, message: `Het afgeronde aantal (${qty}) is hoger dan het maximum van ${MAX_QTY} stuks per regel.` }); continue; }
          if (qty !== want.qty) adjusted.push({ code: product.code, from: want.qty, to: qty, reason: Wholesale.quantityProblem(want.qty, terms) });
          entries.push({ code: product.code.toUpperCase(), qty });
        }
        return { entries, adjusted, problems };
      };
      /**
       * De gevraagde artikelen uit een formulier van het groothandelsvenster: de ingevulde lijst, een geplakte lijst of een eerdere bestelling.
       * @param {object} body De velden van het formulier (action, q:<code>, lijst of orderId).
       * @param {object} viewer De ingelogde klant.
       * @returns {{ wanted: { code: string, qty: number }[], problems: object[], pasted: string }|null} De gevraagde regels, de regels die niet te lezen waren en de geplakte tekst; null bij een onbekende actie.
       */
      const wantedFrom = (body, viewer) => {
        if (body.action === 'bestellen') {
          const wanted = [];
          for (const [key, value] of Object.entries(body)) {
            const qty = Math.floor(Number(value));
            if (key.startsWith('q:') && qty >= 1) wanted.push({ code: key.slice(2).trim().toUpperCase(), qty });
          }
          return { wanted, problems: wanted.length ? [] : [{ text: 'Snelbestellijst', message: 'Vul bij minstens één artikel een aantal in.' }], pasted: '' };
        }
        if (body.action === 'plakken') {
          const text = String(body.lijst ?? '').slice(0, 20000);
          const parsed = Wholesale.parseOrderList(text);
          const problems = parsed.problems.map((problem) => ({ text: `Regel ${problem.line} (${problem.text})`, message: problem.message }));
          if (parsed.truncated) problems.push({ text: 'Lijst', message: `Alleen de eerste ${Wholesale.MAX_PASTE_LINES} regels zijn gelezen; plak de rest apart.` });
          if (!parsed.entries.length && !problems.length) problems.push({ text: 'Lijst', message: 'Er staan geen artikelcodes in de lijst.' });
          return { wanted: parsed.entries, problems, pasted: text, problemLines: parsed.problems.map((problem) => problem.line), rows: parsed.rows, stoppedAt: parsed.stoppedAt };
        }
        if (body.action === 'opnieuw') {
          const order = orders.getForUser(tenantId, viewer.id, String(body.orderId ?? ''));
          if (!order) return { wanted: [], problems: [{ text: 'Bestelling', message: 'Deze bestelling is niet gevonden.' }], pasted: '' };
          return { wanted: order.lines.map((line) => ({ code: String(line.code).toUpperCase(), qty: line.qty })), problems: [], pasted: '' };
        }
        return null;
      };
      /**
       * De regels van een geplakte lijst die niet verwerkt zijn (onleesbaar, onbekende code of niet meer in de wagen gepast), zodat een gecorrigeerde lijst geen regels dubbel toevoegt.
       * @param {{ pasted: string, problemLines?: number[], rows?: object[], stoppedAt?: number }} request De uitkomst van wantedFrom.
       * @param {Set<string>} failedCodes De artikelcodes die niet in de wagen kwamen.
       * @returns {string} De overgebleven regels, onder elkaar.
       */
      const unprocessedLines = (request, failedCodes) => {
        if (!request.problemLines) return request.pasted;
        const unreadable = new Set(request.problemLines);
        const failedRows = new Set(request.rows.filter((row) => failedCodes.has(row.code)).map((row) => row.line));
        return request.pasted.replace(/\r/g, '').split('\n').filter((line, index) => line.trim() && (unreadable.has(index + 1) || failedRows.has(index + 1) || index >= request.stoppedAt)).join('\n');
      };
      /**
       * Toont het groothandelsvenster.
       * @param {object} req Het verzoek.
       * @param {object} res Het antwoord.
       * @param {object} viewer De groothandelsklant.
       * @param {{ notice?: ?object, pasted?: string }} [state] De melding na een actie en de geplakte tekst.
       * @returns {void}
       */
      const showWholesale = (req, res, viewer, { notice = null, pasted = '' } = {}) => {
        res.setHeader('Cache-Control', 'no-store');
        const recent = orders.listForUser(tenantId, viewer.id, { limit: 5 }).items.filter((order) => order.status !== 'geannuleerd');
        sendWithGroups(req, res, 200, (groups) => wholesalePage({ catalog: data.catalogOf(tenantId), viewer, recent, notice, pasted }, groups));
      };
      router.get('/groothandel', (req, res) => {
        if (withSlash(req, res)) return;
        const viewer = wholesaleViewer(req, res);
        if (viewer) showWholesale(req, res, viewer);
      });
      // Eén adres voor alle acties van het venster (veld action), zodat de pagina na een actie op dezelfde plek blijft.
      router.post('/groothandel', express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 3000 }), (req, res) => {
        if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
        const viewer = wholesaleViewer(req, res);
        if (!viewer) return;
        const request = wantedFrom(req.body || {}, viewer);
        if (!request) return res.redirect(303, './');
        const resolved = resolveWanted(data.catalogOf(tenantId), request.wanted);
        const merged = addCartLines(readCart(req), resolved.entries);
        if (resolved.entries.length) writeCart(req, res, merged.lines);
        const problems = [...request.problems, ...resolved.problems];
        const notice = { added: resolved.entries.length - merged.skipped.length, adjusted: resolved.adjusted, problems, skipped: merged.skipped };
        // Alles gelukt zonder iets te melden: meteen naar de winkelwagen.
        if (notice.added > 0 && !problems.length && !notice.adjusted.length && !notice.skipped.length) return res.redirect(303, '../winkelwagen/');
        if (resolved.entries.length) req.pendingCart = merged.lines;
        const failedCodes = new Set([...resolved.problems.map((problem) => problem.text), ...merged.skipped]);
        showWholesale(req, res, viewer, { notice, pasted: problems.length || notice.skipped.length ? unprocessedLines(request, failedCodes) : '' });
      });
      router.post('/winkelwagen', form, (req, res) => {
        if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
        if (!orderingOn()) return orderingOff(req, res);
        const before = readCart(req);
        const after = applyCartAction(before, req.body || {});
        writeCart(req, res, after);
        res.redirect(303, cartActionRejected(before, after, req.body || {}) ? './?vol=1' : './');
      });
      /**
       * De verzendinstelling van deze winkel (de instelling `shopShipping`, gesaneerd).
       * @returns {object} De instelling met ophalen en DPD.
       */
      const shippingConfig = () => Shipping.sanitizeShipping(settingsFor(tenantId).get('shopShipping'));
      /**
       * De betaalwijzen die deze klant bij het afrekenen mag kiezen.
       * @param {{ customerGroup?: string }} viewer De ingelogde klant.
       * @returns {string[]} 'online' en/of 'rekening'.
       */
      const paymentOptionsOf = (viewer) => (payments ? payments.optionsFor(tenantId, viewer) : ['rekening']);
      /**
       * Bepaalt het land en de verzendmethode die bij het afrekenen getoond worden.
       * @param {object} cart De geprijsde winkelwagen.
       * @param {object} input Het gekozen land en de gekozen methode (query of formulier).
       * @returns {{ quote: object, country: string, method: string, summary: ?object, summaries: object }} De opties, het land (een bezorgbaar land), de methode (de gekozen, anders de eerste beschikbare), de totalen bij die methode en de totalen per beschikbare methode.
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
        const chosen = available.find((option) => option.method === method);
        const group = cart.pricesExcl ? 'zakelijk' : '';
        const vatNumber = Vat.normalizeVatNumber(input.vatNumber);
        const summaries = {};
        for (const option of available) summaries[option.method] = orders.orderTotals(cart, option, { group, country, vatNumber });
        return { quote, country, method, summary: chosen ? summaries[method] : null, summaries };
      };

      /**
       * Vult een zakelijke klant aan met de bedrijfsgegevens uit het account (voor het vooraf invullen van het afrekenformulier).
       * @param {object|null} viewer De ingelogde klant, of null.
       * @returns {object|null} De klant, bij een zakelijke klant met `profile` (companyName, vatNumber).
       */
      const withBusinessProfile = (viewer) => (viewer && viewer.customerGroup === 'zakelijk' ? { ...viewer, profile: accounts.businessProfile(viewer) } : viewer);

      router.get('/afrekenen', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
        if (!cart.lines.length || !cart.ok) return res.redirect(302, '../winkelwagen/');
        const viewer = withBusinessProfile(accounts.viewer(req));
        if (!viewer) return sendWithGroups(req, res, 200, (groups) => checkoutLoginPage(groups));
        sendWithGroups(req, res, 200, (groups) => checkoutPage({ cart, viewer, paymentOptions: paymentOptionsOf(viewer), ...checkoutChoice(cart, { vatNumber: viewer.profile ? viewer.profile.vatNumber : '', ...(req.query || {}) }) }, groups));
      });
      router.post('/afrekenen', form, async (req, res, next) => {
        if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
        if (!orderingOn()) return orderingOff(req, res);
        const viewer = withBusinessProfile(accounts.viewer(req));
        if (!viewer) return res.redirect(303, './');
        const body = req.body || {};
        // Land wijzigen: alleen de pagina opnieuw tonen met de kosten voor dat land, zonder te bestellen.
        if (body.action === 'update') {
          res.setHeader('Cache-Control', 'no-store');
          const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
          if (!cart.lines.length || !cart.ok) return res.redirect(303, '../winkelwagen/');
          return sendWithGroups(req, res, 200, (groups) => checkoutPage({ cart, viewer, paymentOptions: paymentOptionsOf(viewer), values: body, ...checkoutChoice(cart, body) }, groups));
        }
        // Hoort het getoonde totaal niet bij de actuele invoer (btw-nummer, land, methode) of ontbreekt het? Dan eerst opnieuw tonen, zonder te bestellen.
        {
          const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
          if (cart.lines.length && cart.ok) {
            const choice = checkoutChoice(cart, body);
            const shown = String(body.expectedTotal === undefined ? '' : body.expectedTotal).trim();
            const current = choice.summary ? choice.summary.totals.total : null;
            if (current !== null && (!/^\d+(\.\d+)?$/.test(shown) || Math.abs(Number(shown) - current) > 0.005)) {
              res.setHeader('Cache-Control', 'no-store');
              return sendWithGroups(req, res, 200, (groups) => checkoutPage({ cart, viewer, paymentOptions: paymentOptionsOf(viewer), error: 'Het totaal is bijgewerkt voor je invoer. Controleer het bedrag en plaats je bestelling opnieuw.', values: body, ...choice }, groups));
            }
          }
        }
        if (orderLimited(req, res)) return res.status(429).type('text').send('Te veel bestellingen vanaf dit adres. Probeer het later opnieuw.');
        try {
          // Een Nederlands bezorgadres komt altijd uit postcode + huisnummer (PDOK): straat en woonplaats uit de browser worden niet vertrouwd.
          let placed = body;
          if (addressGuard && String(body.shippingMethod || '') === 'dpd' && String(body.country || 'NL').toUpperCase() === 'NL') {
            const resolved = await addressGuard.resolveParts({ street: String(body.street || '').trim(), postcode: String(body.postcode || '').trim() });
            if (!resolved.ok) {
              res.setHeader('Cache-Control', 'no-store');
              const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
              return sendWithGroups(req, res, resolved.status, (groups) => checkoutPage({ cart, viewer, paymentOptions: paymentOptionsOf(viewer), error: resolved.message, values: body, ...checkoutChoice(cart, body) }, groups));
            }
            placed = { ...body, street: resolved.street, postcode: resolved.postcode, city: resolved.city };
          }
          const out = orders.place(tenantId, { id: viewer.id, group: viewer.customerGroup, wholesale: wholesaleOf(viewer) }, placed, readCart(req), shippingConfig(), Number(body.expectedTotal), paymentOptionsOf(viewer));
          if (out.cart) return res.redirect(303, '../winkelwagen/');
          if (out.error) {
            const cart = orders.priceCart(tenantId, readCart(req), priceOptionsOf(req));
            return sendWithGroups(req, res, out.status, (groups) => checkoutPage({ cart, viewer, paymentOptions: paymentOptionsOf(viewer), error: out.error, values: body, ...checkoutChoice(cart, body) }, groups));
          }
          writeCart(req, res, []);
          // De bestelling staat al vast: een fout in audit of mail mag de klant niet naar een foutpagina sturen, en de ene stap niet de andere overslaan.
          try { onOrder(req, out.order); } catch (failure) { console.error(`Audit van bestelling ${out.order.number} mislukt: ${failure.message}`); }
          // Een online bestelling wordt pas bevestigd als hij betaald is (zie payments.onPaid); de klant gaat eerst naar de betaalpagina.
          if (out.order.payment === 'online') return res.redirect(303, `../bestelling/${out.order.id}/?bedankt=1&betalen=1`);
          try { if (orderMail) await orderMail.sendPlaced(tenantId, out.order); } catch (failure) { console.error(`Mail van bestelling ${out.order.number} mislukt: ${failure.message}`); }
          res.redirect(303, `../bestelling/${out.order.id}/?bedankt=1`);
        } catch (error) { next(error); }
      });
      router.get('/bestelling/:id', async (req, res, next) => {
        try {
          if (withSlash(req, res)) return;
          if (!orderingOn()) return orderingOff(req, res);
          res.setHeader('Cache-Control', 'no-store');
          const viewer = accounts.viewer(req);
          if (!viewer) return res.redirect(302, '../../inloggen/');
          let order = orders.getForUser(tenantId, viewer.id, req.params.id);
          if (!order) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../../', groups));
          // Terug van de betaalpagina (of een open betaling): de uitkomst eerst bij Mollie opvragen, want de webhook kan nog onderweg zijn.
          if (payments && order.payment === 'online' && order.pay && order.pay.status === 'open' && order.pay.id) {
            try {
              const synced = await payments.sync(tenantId, order.id);
              if (synced.order) order = orders.getForUser(tenantId, viewer.id, order.id) || order;
                          } catch (failure) { console.error(`Betaling van bestelling ${order.number} opvragen mislukt: ${failure.message}`); }
          }
          const invoice = orderInvoices ? orderInvoices.invoiceFor(tenantId, order.id) : null;
          const payError = req.query.betaalfout === '1' ? 'De betaalpagina is nu niet bereikbaar. Probeer het zo opnieuw met de knop hieronder.' : '';
          sendWithGroups(req, res, 200, (groups) => orderPage(order, groups, { thanks: req.query.bedankt === '1' || (req.query.betaald === '1' && order.pay && order.pay.status === 'betaald'), invoice: invoice && invoice.status !== 'concept' ? invoice : null, returnsHtml: returnsHtmlOf(order), payError, autoPay: req.query.betalen === '1' }));
        } catch (error) { next(error); }
      });
      if (payments) {
        const payLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 40, keyFn: (req) => `betalen:${remoteIp(req)}` });
        const webhookLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyFn: (req) => `mollie:${remoteIp(req)}` });
        /**
         * Past een limiet toe zonder JSON-antwoord.
         * @param {Function} limit De limiet (createRateLimiter).
         * @param {object} req Het verzoek.
         * @param {object} res Het antwoord.
         * @returns {boolean} true als het verzoek geweigerd moet worden.
         */
        const limitedBy = (limit, req, res) => {
          let refused = false;
          limit(req, { setHeader: (name, value) => res.setHeader(name, value), status: () => ({ json: () => { refused = true; } }) }, () => {});
          return refused;
        };
        // Naar de betaalpagina van Mollie: de lopende betaling, of een nieuwe als de vorige mislukte.
        router.get('/bestelling/:id/betalen', async (req, res, next) => {
          try {
            if (withSlash(req, res)) return;
            if (!orderingOn()) return orderingOff(req, res);
            res.setHeader('Cache-Control', 'no-store');
            const viewer = accounts.viewer(req);
            if (!viewer) return res.redirect(302, '../../../inloggen/');
            const order = orders.getForUser(tenantId, viewer.id, req.params.id);
            if (!order) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../../../', groups));
            if (limitedBy(payLimiter, req, res)) return res.status(429).type('text').send('Te veel pogingen vanaf dit adres. Probeer het later opnieuw.');
            const out = await payments.start(tenantId, order);
            if (out.paid) return res.redirect(303, '../?betaald=1');
            if (out.checkoutUrl && /^https:\/\//.test(out.checkoutUrl)) return res.redirect(302, out.checkoutUrl);
            if (out.status === 502) return res.redirect(303, '../?betaalfout=1');
            res.redirect(303, '../');
          } catch (error) { next(error); }
        });
        // De melding van Mollie dat een betaling van stand is veranderd. Alleen het id komt mee; de uitkomst vragen we zelf bij Mollie op.
        router.post('/mollie/webhook/:orderId', form, async (req, res) => {
          if (limitedBy(webhookLimiter, req, res)) return res.status(429).end();
          const paymentId = String(req.body && req.body.id || '');
          if (!validPaymentId(paymentId)) return res.status(200).end();
          try {
            await payments.sync(tenantId, String(req.params.orderId), { paymentId });
          } catch (failure) {
            console.error(`Webhook van Mollie voor ${paymentId} mislukt: ${failure.message}`);
            return res.status(502).end();
          }
          res.status(200).end();
        });
      }
      /**
       * Het blok Retourneren van een bestelling (leeg als retourneren uit staat).
       * @param {object} order De bestelling van de ingelogde klant.
       * @param {{ values?: object, error?: string }} [formState] Bij een fout de ingevulde waarden en de melding.
       * @returns {string} HTML van het blok.
       */
      const returnsHtmlOf = (order, formState = {}) => (returns ? returnsBlock({ items: returns.listForOrder(tenantId, order.id), eligibility: returns.eligibility(tenantId, order), ...formState }) : '');
      if (returns) {
        const returnLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => `retour:${remoteIp(req)}` });
        /**
         * Past de retourlimiet toe zonder JSON-antwoord.
         * @param {object} req Het verzoek.
         * @param {object} res Het antwoord.
         * @returns {boolean} true als het verzoek geweigerd moet worden.
         */
        const returnLimited = (req, res) => {
          let refused = false;
          returnLimiter(req, { setHeader: (name, value) => res.setHeader(name, value), status: () => ({ json: () => { refused = true; } }) }, () => {});
          return refused;
        };
        // Een retour aanvragen voor een eigen bestelling.
        router.post('/bestelling/:id/retour', form, (req, res, next) => {
          try {
            if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
            if (!orderingOn()) return orderingOff(req, res);
            const viewer = accounts.viewer(req);
            if (!viewer) return res.redirect(303, '../../inloggen/');
            if (returnLimited(req, res)) return res.status(429).type('text').send('Te veel aanvragen vanaf dit adres. Probeer het later opnieuw.');
            res.setHeader('Cache-Control', 'no-store');
            const body = req.body || {};
            const out = returns.request(tenantId, viewer, req.params.id, {
              reason: body.reason, note: body.note,
              lines: Object.keys(body).filter((key) => key.startsWith('qty:')).map((key) => ({ code: key.slice(4), qty: body[key] })),
            });
            if (out.error) {
              const order = orders.getForUser(tenantId, viewer.id, req.params.id);
              if (!order) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../../', groups));
              return sendWithGroups(req, res, out.status || 400, (groups) => orderPage(order, groups, { returnsHtml: returnsHtmlOf(order, { values: body, error: out.error }) }));
            }
            try { onReturn(req, out.return); } catch (failure) { console.error(`Audit van retour ${out.return.number} mislukt: ${failure.message}`); }
            res.redirect(303, './');
          } catch (error) { next(error); }
        });
        // Een aangevraagde retour intrekken.
        router.post('/bestelling/:id/retour/:returnId/intrekken', (req, res, next) => {
          try {
            if (crossSite(req)) return res.status(403).type('text').send('Verzoek van een andere site geweigerd.');
            if (!orderingOn()) return orderingOff(req, res);
            const viewer = accounts.viewer(req);
            if (!viewer) return res.redirect(303, '../../../../inloggen/');
            const found = returns.getForUser(tenantId, viewer.id, req.params.returnId);
            if (!found || found.orderId !== req.params.id) return sendWithGroups(req, res, 404, (groups) => notFoundPage('../../../../', groups));
            const out = returns.withdraw(tenantId, viewer, found.id);
            if (out.error) return res.status(out.status || 400).type('text').send(out.error);
            res.redirect(303, '../../');
          } catch (error) { next(error); }
        });
      }
      // De factuur van een eigen bestelling als PDF (alleen als hij definitief is).
      router.get('/bestelling/:id/factuur.pdf', (req, res) => {
        if (!orderingOn() || !orderInvoices) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const viewer = accounts.viewer(req);
        if (!viewer) return res.redirect(302, '../../inloggen/');
        const order = orders.getForUser(tenantId, viewer.id, req.params.id);
        const pdf = order ? orderInvoices.pdfFor(tenantId, order.id) : null;
        if (!pdf) return res.status(404).type('text').send('Geen factuur gevonden.');
        res.setHeader('Content-Disposition', `attachment; filename="${pdf.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        res.type('application/pdf').send(pdf.body);
      });
      // De bestelhistorie van de ingelogde klant.
      router.get('/bestellingen', (req, res) => {
        if (withSlash(req, res)) return;
        if (!orderingOn()) return orderingOff(req, res);
        res.setHeader('Cache-Control', 'no-store');
        const viewer = accounts.viewer(req);
        if (!viewer) return res.redirect(302, '../inloggen/');
        const page = Math.max(1, Math.floor(Number(req.query.pagina)) || 1);
        sendWithGroups(req, res, 200, (groups) => ordersPage(orders.listForUser(tenantId, viewer.id, { limit: HISTORY_PAGE, offset: (page - 1) * HISTORY_PAGE }), groups, { page, pageSize: HISTORY_PAGE }));
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
    const site = contentOf(req).site;
    const page = contentOf(req).pages.find((candidate) => candidate.slug === req.params.slug) || legalDefaults(site.contact)[req.params.slug];
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

  // Afbeeldingen die bij een artikel zijn geüpload of overgenomen; het id is onraadbaar en de afbeelding verandert nooit.
  router.get('/artikelfoto/:id', (req, res) => {
    const file = itemImages ? itemImages.file(tenantId, req.params.id) : null;
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
