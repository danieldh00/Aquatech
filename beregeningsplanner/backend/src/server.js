const path = require('path');
const fs = require('fs');
const express = require('express');

const { createAuth, remoteIp, parseCookies } = require('./beveiliging/auth');
const { createRateLimiter } = require('./beveiliging/rate-limit');
const { loadOrCreateSecret } = require('./beveiliging/session-secret');
const { createPlanAnalyzer, AnalyzeError, PROMPT_VERSION } = require('./beregening/plan-analyzer');
const { createRecognitionStore, sanitizeSamples, imageHash } = require('./beregening/recognitions');
const { openDb, openDatabase, isPg } = require('./database/db');
const { createStore, withRequestCache, hashPassword, passwordProblem, preferencesOf } = require('./platform/store');
const testdata = require('./platform/test-data');
const { createSettings, SettingsError, FIELDS } = require('./platform/settings');
const { createVault, loadOrCreateMasterKey } = require('./beveiliging/vault');
const backups = require('./backup');
const { createQuoteStore, registerQuoteRoutes, validShareBase, mailBody } = require('./verkoop/quotes');
const { createMailer } = require('./platform/mailer');
const { createWanIp } = require('./platform/wan-ip');
const { createWorkOrderStore, registerWorkOrderRoutes } = require('./uitvoering/workorders');
const { createPhotoStore, createDossierStore, registerPhotoRoutes } = require('./uitvoering/photos');
const { createWorkLogStore, registerWorkLogRoutes } = require('./uitvoering/worklog');
const { createImpersonationStore, createImpersonation } = require('./beveiliging/impersonation');
const { createShopStore, registerShopRoutes, loadArticles } = require('./webshop/shop');
const { createShopSync } = require('./webshop/shop-sync');
const { createShopOrders } = require('./webshop/shop-orders');
const { createDebtorStore, registerDebtorRoutes } = require('./verkoop/debtors');
const { createInvoiceSender } = require('./verkoop/invoice-mail');
const { createInvoiceStore, registerInvoiceRoutes } = require('./verkoop/invoices');
const { createVisma, registerVismaRoutes } = require('./verkoop/visma');
const { createPortalStore, registerPortalRoutes } = require('./uitvoering/portal');
const { createLocationStore, registerLocationRoutes } = require('./uitvoering/locations');
const { createServiceRequestStore, registerServiceRequestRoutes } = require('./uitvoering/service-requests');
const { createOutsourcingStore, registerOutsourcingRoutes } = require('./uitvoering/outsourcing');
const { createStockStore, registerStockRoutes } = require('./voorraad/stock');
const { createNewsStore, registerNewsRoutes, unreadCount } = require('./platform/news');
const { createSprinklerStore, registerSprinklerRoutes } = require('./beregening/sprinklers');
const { registerDrawingRoutes } = require('./beregening/drawings');
const { createAiUsageStore } = require('./platform/ai-usage');
const { createIdempotency, ifBaseOf } = require('./beveiliging/idempotency');
const crypto = require('crypto');

const { FRONTEND_DIR, PAGES_DIR } = require('./paths');
const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const MODULES = require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));
const LOGIN_PAGE = path.join(PAGES_DIR, 'login.html');
const SETUP_PAGE = path.join(PAGES_DIR, 'setup.html');
const PASSWORD_PAGE = path.join(PAGES_DIR, 'password.html');
const PKG = require('../package.json');

/**
 * De versie van de app (uit package.json).
 * @returns {string} Het versienummer.
 */
const readVersion = () => PKG.version;

/**
 * SHA-256-hashes van de inline scripts in deze pagina's, voor de
 * Content-Security-Policy hieronder: alleen eigen scripts (plus de inline
 * scripts van de inlog- en instelpagina, op hash), geen frames, geen plug-ins.
 * WebAssembly (OCR) en workers/blobs (pdf.js, Tesseract, Excel-export) zijn nodig.
 * @param {string[]} files Paden van de HTML-pagina's.
 * @returns {string[]} De hashes als CSP-bron ('sha256-...').
 */
function inlineScriptHashes(files) {
  const out = [];
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      out.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
    }
  }
  return out;
}
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes([LOGIN_PAGE, SETUP_PAGE, PASSWORD_PAGE]).join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Eenmalige installatiecode voor het eerste beheerdersaccount (zonder
 * toegangscode): staat alleen in het serverlog, zodat niet iedereen die als
 * eerste de publieke URL opent het beheer kan overnemen.
 * @returns {string} Code als XXXX-XXXX-XXXX.
 */
function newSetupCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from(crypto.randomBytes(12), (byte) => abc[byte % abc.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
/**
 * Maakt een code vergelijkbaar: hoofdletters, alleen letters en cijfers.
 * @param {*} code De ingevoerde code.
 * @returns {string} De genormaliseerde code.
 */
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Zonder inloggen bereikbaar: de openbare offertepagina (klant via een link
// met token) en precies de bestanden die die pagina nodig heeft. Geen
// ../-trucs: het pad moet na decoderen en normaliseren hetzelfde blijven.
const PUBLIC_FILES = new Set([
  '/openbaar/offerte.html', '/openbaar/offerte.js', '/openbaar/offerte.css',
  '/openbaar/afspraak.html', '/openbaar/afspraak.js', '/openbaar/afspraak.css', '/werkorders/workorder-core.js',
  '/shared/brand.css', '/shared/theme.css', '/shared/theme.js', '/shared/logo-white.png',
  '/offertes/quote-core.js', '/offertes/quote-view.js', '/offertes/quote-view.css',
  // Installeerbare app en offline werken: geen gegevens, wel nodig voordat
  // (en nadat) iemand is ingelogd (manifest en service worker worden zonder
  // cookies of buiten de sessie opgehaald).
  '/sw.js', '/manifest.json', '/shared/offline-core.js',
  '/shared/icons/app-192.png', '/shared/icons/app-512.png', '/shared/icons/app-maskable-512.png', '/shared/icons/apple-touch-icon.png',
]);
/**
 * Is dit een openbaar bestand (zonder inloggen bereikbaar, zie PUBLIC_FILES)?
 * @param {object} req Het verzoek.
 * @returns {boolean} true als het mag.
 */
function isPublicAsset(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let decodedPath;
  try { decodedPath = decodeURIComponent(req.path); } catch { return false; }
  if (decodedPath !== path.posix.normalize(decodedPath) || decodedPath.includes('\\')) return false;
  return PUBLIC_FILES.has(decodedPath) || /^\/shared\/fonts\/montserrat-latin-\d{3}-normal\.woff2$/.test(decodedPath);
}

// De planner zonder inloggen (tekening indienen, zie drawings.js): de pagina
// alleen met ?tekenen (anders gewoon de inlogpagina), en de code ervan. Er
// zit geen data in: zonder account blijft het plan in de browser tot het
// wordt ingediend.
const PLANNER_FILES = new Set(['/shared/common.js', '/shared/env.js', '/shared/sidebar.js', '/shared/sidebar.css', '/shared/schild-white.png', '/dashboard/modules.js']);
/**
 * De planner zonder inloggen (tekening indienen, zie drawings.js): de pagina
 * alleen met ?tekenen (anders gewoon de inlogpagina), en de code ervan. Er
 * zit geen data in: zonder account blijft het plan in de browser tot het
 * wordt ingediend.
 * @param {object} req Het verzoek.
 * @returns {boolean} true als het verzoek bij de openbare planner hoort.
 */
function isPublicPlanner(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let decodedPath;
  try { decodedPath = decodeURIComponent(req.path); } catch { return false; }
  if (decodedPath !== path.posix.normalize(decodedPath) || decodedPath.includes('\\')) return false;
  if (decodedPath === '/beregening/' || decodedPath === '/beregening/index.html') return Object.prototype.hasOwnProperty.call(req.query, 'tekenen');
  if (decodedPath === '/beregening') return Object.prototype.hasOwnProperty.call(req.query, 'tekenen');
  return PLANNER_FILES.has(decodedPath) || (decodedPath.startsWith('/beregening/') && !decodedPath.endsWith('.html') && /\.[a-z0-9]+(\.gz)?$/i.test(decodedPath));
}

/**
 * Een module is een map direct onder frontend/ met een eigen index.html.
 * @param {string} name Naam van de map.
 * @returns {boolean} true als het een module is.
 */
function isModule(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  try {
    return fs.statSync(path.join(FRONTEND_DIR, name, 'index.html')).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * Pagina's krijgen de appversie achter elke lokale stylesheet en elk script
 * (`css/app.css?v=<versie>`). Zo laadt een telefoon na een update gegarandeerd
 * de nieuwe bestanden, ook als de browser of een proxy (Cloudflare) een oude
 * versie in de cache heeft; zonder dit kreeg iOS de nieuwe HTML met oude CSS.
 * @param {string} html De pagina.
 * @param {string} version De appversie.
 * @returns {string} De pagina met ?v=<versie> achter de lokale bestanden.
 */
function versionAssets(html, version) {
  const versionParam = encodeURIComponent(version);
  return html.replace(/(<(?:link|script)\b[^>]*?\b(?:href|src)=")([^"?#:]+\.(?:css|js))(")/g, `$1$2?v=${versionParam}$3`);
}

/**
 * Stuurt een pagina met versienummers achter de bestanden.
 * @param {object} res Het antwoord.
 * @param {string} file Pad van de pagina.
 * @param {string} version De appversie.
 * @param {string} [head] Extra regels direct na <head> (bijv. de startpagina, zie startPageOf).
 * @returns {void}
 */
function sendPage(res, file, version, head = '') {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    const out = versionAssets(html, version);
    res.type('html').send(head ? out.replace(/<head>/i, `<head>\n  ${head}`) : out);
  });
}

/**
 * Scripts en stylesheets met de huidige versie (`?v=<versie>`, zie
 * versionAssets) veranderen nooit meer: de browser mag ze bewaren zonder bij
 * elke paginawissel opnieuw te vragen of ze nog kloppen. Een nieuwe versie
 * heeft een ander adres. `private`: alleen de browser, geen proxy (Cloudflare),
 * want de bestanden vallen achter de login.
 * @param {string} version De appversie.
 * @returns {Function} setHeaders voor express.static (res, file).
 */
function staticHeaders(version) {
  const versionQuery = `v=${encodeURIComponent(version)}`;
  return (res, file) => {
    const query = res.req && res.req.originalUrl ? res.req.originalUrl.split('?')[1] : '';
    const fixed = query === versionQuery && /\.(css|js)$/.test(file);
    res.setHeader('Cache-Control', fixed ? 'private, max-age=31536000, immutable' : 'no-cache');
  };
}

/**
 * Bouwt de Express-app met alle routes en opslag.
 * @param {object} options accessCode, anthropicApiKey en aiDailyLimit (alleen startwaarden, net als env; de actuele waarden komen uit de instellingen), secret, analyzer, db, env, createAnalyzer, vault, setupCode, backupDir, mailerFor, shopFetch, vismaFetch en wanIp (tests vervangen hiermee de buitenwereld).
 * @returns {object} De app; app.locals bevat settings, onderhoud en synchronisatie.
 */
function createApp({ accessCode = '', secret, anthropicApiKey = '', aiDailyLimit, analyzer, db, env = {}, createAnalyzer = createPlanAnalyzer, vault = createVault(), setupCode, backupDir = null, mailerFor = (settings) => createMailer(settings), shopFetch, vismaFetch, wanIp = createWanIp() }) {
  const version = readVersion();
  const database = db || openDb();
  const store = createStore(database);
  // De hoofdtenant ('default') bestaat altijd: daar horen de hoofdbeheerders,
  // de toegangscode, gasten en het instelscherm bij. Andere tenants en de
  // testomgevingen maakt een hoofdbeheerder aan in de module Hoofdbeheer.
  const tenant = store.ensureTenant();
  const startEnv = { ...env };
  if (accessCode) startEnv.ACCESS_CODE = accessCode;
  if (anthropicApiKey) startEnv.ANTHROPIC_API_KEY = anthropicApiKey;
  if (aiDailyLimit !== undefined) startEnv.AI_DAILY_LIMIT = aiDailyLimit;
  // Instellingen per tenant (ook per testomgeving). De omgevingsvariabelen
  // gelden alleen als startwaarde voor de hoofdtenant en diens testomgevingen.
  const settingsCache = new Map();
  /**
   * De instellingen van een tenant (onthouden). De omgevingsvariabelen gelden
   * alleen als startwaarde voor de hoofdtenant en diens testomgevingen.
   * @param {string} tenantId Id van de tenant of omgeving.
   * @returns {object} De instellingen (settings.js).
   */
  function settingsFor(tenantId) {
    let tenantSettings = settingsCache.get(tenantId);
    if (!tenantSettings) {
      const tenantRow = store.getTenant(tenantId);
      const own = tenantId === tenant.id || (tenantRow && tenantRow.parent_id === tenant.id);
      tenantSettings = createSettings({ db: database, tenantId, env: own ? startEnv : {}, vault });
      settingsCache.set(tenantId, tenantSettings);
    }
    return tenantSettings;
  }
  const settings = settingsFor(tenant.id);
  /**
   * Kleurthema (shared/theme.js): het eigen thema van de live-tenant (ook voor
   * diens testomgevingen), anders het thema van de hoofdtenant voor iedereen.
   * @param {string} [tenantId] Id van de omgeving (leeg = hoofdtenant).
   * @returns {object} De kleuren.
   */
  function themeFor(tenantId) {
    const home = tenantId ? homeOf(tenantId) : tenant.id;
    const own = home !== tenant.id ? settingsFor(home).get('theme') : {};
    return Object.keys(own).length ? own : settings.get('theme');
  }
  // Inlog-, instel- en wachtwoordpagina: alles inline (geen toegang tot
  // bestanden), dus het thema als <style> in de kop.
  const authHtml = new Map();
  /**
   * Stuurt de inlog-, instel- of wachtwoordpagina: alles inline (geen toegang
   * tot bestanden), dus het thema als <style> in de kop.
   * @param {object} res Het antwoord.
   * @param {string} file Pad van de pagina.
   * @param {string} [tenantId] Omgeving voor het kleurthema.
   * @returns {void}
   */
  function sendAuthPage(res, file, tenantId) {
    if (!authHtml.has(file)) authHtml.set(file, fs.readFileSync(file, 'utf8'));
    const css = Theme.css(themeFor(tenantId));
    const html = authHtml.get(file);
    res.type('html').send(css ? html.replace('</head>', `  <style>${css}</style>\n</head>`) : html);
  }
  const installCode = setupCode || env.SETUP_CODE || newSetupCode();
  /**
   * De toegangscode van de hoofdtenant.
   * @returns {string} De code (leeg = geen).
   */
  const getAccessCode = () => settings.get('accessCode');
  /**
   * Gasten (zonder inloggen) alleen als dat aanstaat en er geen code is.
   * @returns {boolean} true als gasten mogen.
   */
  const guestsAllowed = () => !getAccessCode() && settings.get('guestAccess');
  // Nog geen beheerder met een eigen account: eerst het instelscherm.
  // Is er eenmaal een actieve beheerder, dan blijft dat zo (de laatste
  // beheerder is niet uit te schakelen of te verwijderen): daarna niet bij elk
  // verzoek opnieuw tellen.
  let hasAdmin = false;
  /**
   * Nog geen beheerder met een eigen account: eerst het instelscherm. Is er
   * eenmaal een actieve beheerder, dan blijft dat zo, dus daarna niet bij elk
   * verzoek opnieuw tellen.
   * @returns {boolean} true als het instelscherm nodig is.
   */
  const needsSetup = () => {
    if (!hasAdmin) hasAdmin = store.countAdmins(tenant.id) > 0;
    return !hasAdmin;
  };
  const auth = createAuth({ secret, store, tenantId: tenant.id, getAccessCode,
    // Sessieduur volgt de instellingen van de eigen tenant van het account.
    idleDays: (tenantId = tenant.id) => settingsFor(tenantId).get('sessionIdleDays'),
    maxDays: (tenantId = tenant.id) => settingsFor(tenantId).get('sessionMaxDays') });
  /**
   * Schrijft een regel in het auditlog, standaard van de actieve omgeving (zonder
   * inlog de hoofdtenant). Werkt een hoofdbeheerder als deze gebruiker
   * (impersonatie), dan staat diens gebruikersnaam erbij.
   * @param {object} req Het verzoek.
   * @param {string} action De actie.
   * @param {object} [detail] Details (nooit geheimen).
   * @param {string|null} [userId] Wie (standaard req.user).
   * @param {string} [tenantId] Omgeving (standaard req.tenantId).
   * @returns {void}
   */
  const audit = (req, action, detail = {}, userId, tenantId) => store.audit({ tenantId: tenantId || req.tenantId || tenant.id,
    userId: userId === undefined ? req.user?.id || null : userId, action,
    detail: req.user?.impersonator ? { ...detail, impersonatie: req.user.impersonator.username } : detail, ip: remoteIp(req) });
  const impersonation = createImpersonation({ store, imp: createImpersonationStore(database), auth, audit, mainTenantId: tenant.id });
  /**
   * Express 4 vangt geen afgewezen promises: doorgeven aan de foutafhandeling.
   * @param {Function} handler De async handler.
   * @returns {Function} Middleware.
   */
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // De AI-client volgt de API-sleutel en het model uit de instellingen van de
  // tenant (zonder herstart). Elke organisatie gebruikt haar eigen sleutel:
  // de sleutel uit de Docker-omgeving (ANTHROPIC_API_KEY) is alleen een
  // startwaarde voor de hoofdtenant en diens testomgevingen (settingsFor),
  // nooit voor een andere organisatie. Een testomgeving zonder eigen sleutel
  // gebruikt sleutel en model van haar live-tenant (zelfde organisatie).
  const analyzers = new Map();
  /**
   * De omgeving waarvan de AI-sleutel en het model gelden: de eigen als die
   * een sleutel heeft, anders (testomgeving) die van de live-tenant.
   * @param {string} [tenantId] Id van de omgeving.
   * @returns {string} Id van de omgeving met de AI-instellingen.
   */
  function aiTenantOf(tenantId = tenant.id) {
    if (settingsFor(tenantId).get('anthropicApiKey')) return tenantId;
    const tenantRow = store.getTenant(tenantId);
    return tenantRow && tenantRow.environment === 'test' && tenantRow.parent_id ? tenantRow.parent_id : tenantId;
  }
  /**
   * De AI-client voor een omgeving (per model en sleutel onthouden).
   * @param {string} [tenantId] Id van de omgeving.
   * @returns {object} De plananalyse (planAnalyzer.js).
   */
  function currentAnalyzer(tenantId = tenant.id) {
    if (analyzer) return analyzer;
    const aiSettings = settingsFor(aiTenantOf(tenantId));
    const key = aiSettings.get('anthropicApiKey');
    const model = aiSettings.get('aiModel');
    const cacheKey = `${model}|${key}`;
    let cached = analyzers.get(cacheKey);
    if (!cached) {
      cached = createAnalyzer({ apiKey: key, model });
      analyzers.set(cacheKey, cached);
    }
    return cached;
  }
  // Verbruik en kosten van elk AI-verzoek (Beheer > AI-kosten).
  const aiUsage = createAiUsageStore(database);
  // Vaste AI-uitkomst per tekening en geleerde kleuren (zie recognitions.js).
  const recognitions = createRecognitionStore(database);
  /**
   * Staat AI-herkenning aan en is er een sleutel?
   * @param {string} [tenantId] Id van de omgeving.
   * @returns {boolean} true als herkennen kan.
   */
  const aiAvailable = (tenantId = tenant.id) => settingsFor(tenantId).get('aiEnabled') && currentAnalyzer(tenantId).available;

  const app = express();

  app.disable('x-powered-by');
  // Per verzoek een eigen geheugen voor gegevens die binnen één verzoek
  // meermaals nodig zijn (zoals de tenant); zie withRequestCache in store.js.
  app.use((req, res, next) => withRequestCache(next));
  // Modules roepen de API relatief aan ('api/...'), dus vanuit beregening/
  // komt dat binnen als /beregening/api/...: zelfde API, prefix eraf.
  app.use((req, res, next) => {
    const match = /^\/([a-z0-9][a-z0-9-]*)(\/api\/.*)$/.exec(req.url);
    if (match && isModule(match[1])) req.url = match[2];
    next();
  });
  // Grote limiet alleen voor de plananalyse (afbeelding als base64).
  app.use('/api/plan/analyze', express.json({ limit: '12mb' }));
  // Kleurtellingen van een herkend plan (zie recognitions.js).
  app.use('/api/plan/learn', express.json({ limit: '256kb' }));
  // Een plan bevat de achtergrondafbeelding (base64).
  app.use('/api/plans', express.json({ limit: '12mb' }));
  // Een offerte met veel regels en lange teksten past niet in 16 kB.
  app.use('/api/quotes', express.json({ limit: '1mb' }));
  // Tekening indienen zonder inloggen (drawings.js): plan met achtergrond.
  app.use('/api/public/drawing', express.json({ limit: '8mb' }));
  // Akkoord via de openbare link: met handtekening (PNG).
  app.use('/api/public', express.json({ limit: '512kb' }));
  // Foto's bij een werkorder (base64, verkleind in de browser): vóór de 1 MB hieronder.
  app.use(/^\/api\/workorders\/[^/]+\/photos$/, express.json({ limit: '8mb' }));
  // Uren en materiaal boeken (worklog.js): kleine regels.
  app.use(/^\/api\/workorders\/[^/]+\/(hours|materials)(\/[^/]+)?$/, express.json({ limit: '32kb' }));
  app.use('/api/workorders', express.json({ limit: '1mb' }));
  // Meldingen van klanten: foto's (base64, verkleind in de browser) en de tekst.
  app.use(/^\/api\/portal\/requests\/[^/]+\/photos$/, express.json({ limit: '8mb' }));
  app.use(['/api/portal/requests', '/api/service-requests'], express.json({ limit: '64kb' }));
  app.use('/api/news', express.json({ limit: '64kb' }));
  // Sproeierbibliotheek uit Excel (sprinklers.js): max. 300 behuizingen en 1000 nozzles.
  app.use('/api/sprinkler-library', express.json({ limit: '2mb' }));
  app.use('/api/stock', express.json({ limit: '256kb' }));
  app.use('/api/invoices', express.json({ limit: '1mb' }));
  app.use('/api/debtors', express.json({ limit: '16kb' }));
  app.use(['/api/visma', '/api/platform/visma'], express.json({ limit: '32kb' }));
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    // Via https (de tunnel zet X-Forwarded-Proto): de browser onthoudt dat.
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // API-antwoorden bevatten persoonsgegevens: nooit in een (proxy)cache.
    if (req.url.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Wijzigingen via de API alleen vanaf de eigen site. SameSite=Lax houdt
  // andere sites buiten, maar niet andere subdomeinen van hetzelfde domein
  // (die tellen als "same-site"); de browser zegt in Sec-Fetch-Site waar een
  // verzoek vandaan komt. Zonder die kop (oudere browsers, scripts) geldt de
  // rest van de beveiliging gewoon.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return res.status(403).json({ error: 'cross_site', message: 'Verzoek van een andere site geweigerd.' });
    next();
  });

  // Offline wachtrij (frontend/sw.js, werkorders/worklog.js): een bewaarde
  // wijziging draagt X-Aquatech-Owner (`<gebruiker>@<omgeving>` van wie hem
  // maakte). Is er intussen iemand anders ingelogd in deze browser, dan wordt
  // hij niet onder diens naam uitgevoerd.
  app.use('/api', (req, res, next) => {
    const owner = req.headers['x-aquatech-owner'];
    if (owner === undefined || req.method === 'GET' || req.method === 'HEAD') return next();
    const user = identify(req);
    if (user && String(owner) === `${user.id}@${req.tenantId}`) return next();
    res.status(409).json({ error: 'owner_mismatch', message: 'Deze wijziging is gemaakt door een andere gebruiker of in een andere omgeving.' });
  });

  // Offline wachtrij (frontend/sw.js): een herhaald verzoek met dezelfde
  // Idempotency-Key wordt niet nog eens uitgevoerd (zie idempotency.js).
  const idempotency = createIdempotency();
  app.use('/api', idempotency.middleware((req) => {
    const user = identify(req);
    return user ? `${user.id}@${req.tenantId}` : null;
  }));

  // Moet de gebruiker eerst zelf een nieuw wachtwoord kiezen (nieuw account of
  // reset door een beheerder), dan is alleen de wachtwoordpagina bereikbaar:
  // elke pagina toont die, de API weigert alles behalve wat die pagina nodig heeft.
  const PASSWORD_OPEN = /^\/api\/(me|health|auth\/[a-z]+|account\/password)$/;
  app.use((req, res, next) => {
    // Scripts, stylesheets en afbeeldingen blijven bereikbaar (de
    // wachtwoordpagina gebruikt ze); daarvoor hoeft de sessie hier niet uit de database.
    const api = req.path.startsWith('/api/');
    const page = !/\.[a-z0-9]+$/i.test(req.path) || req.path.endsWith('.html');
    if (!api && (!page || (req.method !== 'GET' && req.method !== 'HEAD'))) return next();
    const session = auth.session(req);
    if (session?.via !== 'user' || !session.user.must_change_password || PASSWORD_OPEN.test(req.path)) return next();
    if (api) return res.status(403).json({ error: 'password_change_required', message: 'Kies eerst een nieuw wachtwoord.' });
    res.setHeader('Cache-Control', 'no-store');
    sendAuthPage(res, PASSWORD_PAGE, session.user.tenant_id);
  });

  // Inloggen: streng begrensd per IP (achter de tunnel is dat het
  // cloudflared-adres, dus effectief een globale grens -- prima voor een
  // handvol gebruikers, en precies wat raden van de code onmogelijk maakt).
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyFn: remoteIp });
  // Daarnaast per gebruikersnaam: na 10 mislukte pogingen in 15 minuten is dat
  // account 15 minuten geblokkeerd (ook als de pogingen van veel IP's komen).
  const failures = new Map();
  const LOCK_MS = 15 * 60 * 1000;
  /**
   * Is deze gebruikersnaam (tijdelijk) geblokkeerd na te veel mislukte pogingen?
   * @param {string} name Sleutel (bijv. de gebruikersnaam).
   * @param {number} [max] Aantal mislukte pogingen waarna de sleutel geblokkeerd is.
   * @returns {boolean} true als hij geblokkeerd is.
   */
  const lockedOut = (name, max = 10) => {
    const entry = failures.get(name);
    if (entry && entry.reset <= Date.now()) failures.delete(name);
    return (failures.get(name)?.count || 0) >= max;
  };
  // De toegangscode is één gedeeld geheim: naast de grens per IP ook een grens
  // voor alle pogingen samen (een IP-adres is achter een proxy te vervalsen).
  const CODE_KEY = 'toegangscode';
  const CODE_MAX_FAILURES = 30;
  /**
   * Telt een mislukte poging.
   * @param {string} name Sleutel (bijv. de gebruikersnaam).
   * @returns {void}
   */
  const failed = (name) => {
    const entry = failures.get(name);
    if (!entry || entry.reset <= Date.now()) failures.set(name, { count: 1, reset: Date.now() + LOCK_MS });
    else entry.count += 1;
  };

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version });
  });

  app.get('/api/auth/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: auth.isAuthenticated(req), configured: Boolean(getAccessCode()), loginRequired: !guestsAllowed(), setupRequired: needsSetup() });
  });

  app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase().slice(0, 60);
    if (username) {
      // De organisatiecode bepaalt de organisatie (leeg = hoofdtenant); dezelfde
      // gebruikersnaam kan in meer organisaties bestaan. Testaccounts van een
      // testomgeving loggen in met de code van de organisatie of van die omgeving.
      const orgCode = String(req.body?.tenant ?? '').trim().toLowerCase().slice(0, 60);
      let home = store.loginTenant(orgCode);
      const key = `${home?.id || orgCode}:${username}`;
      if (lockedOut(key)) {
        audit(req, 'inloggen_geblokkeerd', { username, organisatie: orgCode }, null, home?.id);
        return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen voor deze gebruiker. Probeer het over een kwartier opnieuw.' });
      }
      // Ook bij een onbekende code een wachtwoord controleren (gelijke looptijd).
      const password = String(req.body?.password ?? '').slice(0, 1024);
      let user = await store.authenticate(home?.id || null, username, password);
      // Hoofdbeheerders horen bij de hoofdtenant, maar loggen ook in als er
      // nog een andere organisatiecode in het veld staat (de browser onthoudt
      // de vorige) of als ze de naam van de hoofdtenant intypen.
      // Die poging telt mee voor de gebruikersnaam in de hoofdtenant, los van
      // de ingevulde code (anders geeft elke verzonnen code nieuwe pogingen).
      const mainKey = `${tenant.id}:${username}`;
      if (!user && home?.id !== tenant.id && !lockedOut(mainKey)) {
        const admin = await store.authenticate(tenant.id, username, password);
        if (admin?.platform_admin) { user = admin; home = tenant; failures.delete(mainKey); }
        else if (!admin) failed(mainKey);
      }
      if (!user) {
        failed(key);
        audit(req, 'inloggen_mislukt', { username, organisatie: orgCode }, null, home?.id);
        return res.status(401).json({ error: 'wrong_login', message: 'Onjuiste organisatiecode, gebruikersnaam of wachtwoord.' });
      }
      failures.delete(key);
      // Testaccounts horen bij een testomgeving van de organisatie.
      if ((home.disabled || !organizationActive(user.tenant_id)) && !user.platform_admin) {
        audit(req, 'inloggen_geweigerd', { username, reden: 'tenant_uitgeschakeld' }, user.id, user.tenant_id);
        return res.status(403).json({ error: 'tenant_disabled', message: 'Deze organisatie is uitgeschakeld. Neem contact op met de beheerder van het platform.' });
      }
      impersonation.stop(req, res, 'opnieuw_ingelogd');
      auth.setCookie(req, res, user.id);
      clearEnvironment(req, res);
      audit(req, 'ingelogd', { via: 'account' }, user.id, user.tenant_id);
      return res.json({ ok: true, tenant: home.slug === 'default' ? '' : home.slug });
    }
    if (!getAccessCode()) {
      return res.status(400).json({ error: 'username_required', message: 'Vul je gebruikersnaam en wachtwoord in.' });
    }
    if (lockedOut(CODE_KEY, CODE_MAX_FAILURES)) {
      audit(req, 'inloggen_geblokkeerd', { via: 'toegangscode' }, null);
      return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen met de toegangscode. Probeer het over een kwartier opnieuw.' });
    }
    if (!auth.checkCode(String(req.body?.code ?? req.body?.password ?? ''))) {
      failed(CODE_KEY);
      audit(req, 'inloggen_mislukt', { via: 'toegangscode' }, null);
      return res.status(401).json({ error: 'wrong_code', message: 'Onjuiste toegangscode.' });
    }
    impersonation.stop(req, res, 'opnieuw_ingelogd');
    auth.setCookie(req, res);
    clearEnvironment(req, res);
    audit(req, 'ingelogd', { via: 'toegangscode' }, null);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', (req, res) => {
    impersonation.stop(req, res, 'uitgelogd');
    const session = auth.session(req);
    if (session) audit(req, 'uitgelogd', {}, session.user?.id || session.row.user_id, session.row.tenant_id);
    auth.clearCookie(req, res);
    clearEnvironment(req, res);
    res.json({ ok: true });
  });

  // ---------- Eerste start: het eerste beheerdersaccount ----------
  // Zolang er geen beheerder met een eigen account is, krijgt elke bezoeker
  // die niet is ingelogd het instelscherm (setup.html). Met een ingestelde
  // toegangscode moet die code erbij, anders kan iedereen met de URL het
  // eerste account claimen.
  app.get('/api/setup', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ required: needsSetup(), codeRequired: true, codeKind: getAccessCode() ? 'toegangscode' : 'installatiecode' });
  });

  app.post('/api/setup', loginLimiter, wrap(async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required', message: 'Verwacht JSON.' });
    if (!needsSetup()) return res.status(409).json({ error: 'already_setup', message: 'Er is al een beheerder. Log in met je account.' });
    const code = String(req.body?.code ?? '');
    if (getAccessCode() ? !auth.checkCode(code) : !auth.safeEqual(normalizeCode(code), normalizeCode(installCode))) {
      audit(req, 'installatie_mislukt', {}, null);
      return res.status(401).json({ error: 'wrong_code', message: getAccessCode() ? 'Onjuiste toegangscode.' : 'Onjuiste installatiecode. Je vindt die in het serverlog (docker compose logs).' });
    }
    const { username, displayName, password } = req.body || {};
    // De eerste beheerder is ook hoofdbeheerder (alle tenants).
    const out = await store.createAccount(tenant.id, { username: String(username || '').trim().toLowerCase(), displayName, role: 'beheerder', password }, { platformAdmin: true });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    console.log(`Eerste beheerder aangemaakt: ${out.user.username}`);
    auth.setCookie(req, res, out.user.id);
    audit(req, 'eerste_beheerder', { username: out.user.username }, out.user.id);
    res.status(201).json({ ok: true, user: store.publicUser(out.user) });
  }));

  // ---------- Wie is er ingelogd? ----------
  // Toegangscode = beheerder; een account = die gebruiker; staan gasten aan
  // (Beheer > Instellingen) en is er geen code, dan is iedereen anders een gast
  // met een eigen (anonieme) gebruiker per browser. Een gast wordt pas
  // aangemaakt bij het eerste opslaan (ensureUser), niet bij elk bezoek.
  //
  // req.user is daarna de gebruiker zoals die in de gekozen omgeving werkt:
  // tenant_id = de actieve omgeving (live of test), home_tenant_id = de tenant
  // waar het account bij hoort. req.tenantId = de actieve omgeving (zonder
  // inlog de hoofdtenant). Alle gegevens (plannen, historie, instellingen)
  // gaan via req.tenantId; gebruikersbeheer via usersTenantOf(req).
  /**
   * Of de tenant van een account in gebruik is: bestaat, niet uitgeschakeld, en
   * bij een testomgeving ook de organisatie erboven niet uitgeschakeld.
   * @param {string} tenantId Id van de eigen tenant van het account.
   * @returns {boolean} true als het account mag werken.
   */
  function organizationActive(tenantId) {
    const home = store.getTenant(tenantId);
    if (!home || home.disabled) return false;
    if (!home.parent_id) return true;
    const parent = store.getTenant(home.parent_id);
    return Boolean(parent && !parent.disabled);
  }

  /**
   * Bepaalt wie het verzoek doet en zet req.user en req.tenantId.
   * @param {object} req Het verzoek.
   * @returns {object|null} De gebruiker, of null.
   */
  function identify(req) {
    if (req.user !== undefined) return req.user;
    const session = auth.session(req);
    let user = null;
    if (session?.via === 'code') user = store.systemUser(tenant.id, 'beheerder', 'Beheerder (toegangscode)');
    else if (session?.via === 'user') user = session.user;
    else if (guestsAllowed()) {
      const gid = auth.guestId(req);
      const guest = gid && store.getUser(gid);
      user = guest && guest.kind === 'gast' && guest.tenant_id === tenant.id && !guest.disabled ? guest : null;
    }
    if (user && !organizationActive(user.tenant_id) && !(user.platform_admin && store.getTenant(user.tenant_id))) user = null;
    if (user) {
      store.touchUser(user);
      // Een hoofdbeheerder kan tijdelijk als een andere gebruiker werken (zie impersonation.js).
      const as = session?.via === 'user' && user.platform_admin ? impersonation.resolve(req, user) : null;
      user = as || actingUser(req, user);
      user = withRights(user);
    }
    req.user = user;
    req.tenantId = user ? user.tenant_id : tenant.id;
    return user;
  }

  // ---------- Omgevingen: live en test, wisselen zonder opnieuw inloggen ----------
  // De keuze staat in een ondertekende cookie die aan de gebruiker vastzit
  // (`<user-id>:<tenant-id>`); bij elk verzoek wordt opnieuw gecontroleerd of
  // de gebruiker daar nog mag komen. De tweede cookie (leesbaar voor de
  // frontend, niet beveiligend) toont de testbalk en scheidt het lokale
  // concept van de planner per omgeving.
  const ENV_COOKIE = 'aquatech_env';
  const ENV_HINT = 'aquatech_env_hint';

  /**
   * Rechten van de eigen rol zoals de organisatie die heeft ingesteld (Beheer
   * > Rollen); roles.js valt terug op de standaard.
   * @param {object} user De gebruiker.
   * @returns {object} De gebruiker met rights.
   */
  function withRights(user) {
    if (user.platform_admin) return user;
    return { ...user, rights: store.roles.rightsFor(user.home_tenant_id || user.tenant_id, user.role) };
  }

  /**
   * De gebruiker zoals die in de gekozen omgeving werkt (cookie aquatech_env).
   * @param {object} req Het verzoek.
   * @param {object} user Het account.
   * @returns {object} De gebruiker met tenant_id = actieve omgeving en home_tenant_id = eigen tenant.
   */
  function actingUser(req, user) {
    const base = { ...user, home_tenant_id: user.tenant_id };
    const raw = auth.readSigned(req, ENV_COOKIE, 'env');
    if (!raw) return base;
    const [cookieUserId, cookieTenantId] = raw.split(':');
    if (cookieUserId !== user.id || !cookieTenantId || cookieTenantId === user.tenant_id) return base;
    if (!store.accessibleTenants(user).some((accessible) => accessible.id === cookieTenantId)) return base;
    return { ...base, tenant_id: cookieTenantId, role: user.platform_admin ? 'beheerder' : user.role };
  }

  /**
   * Toegankelijke omgevingen van een (werkende) gebruiker: op basis van het
   * account in de eigen tenant, niet van de omgeving waar die nu werkt.
   * @param {object} user De gebruiker.
   * @returns {object[]} De omgevingen.
   */
  const accessibleFor = (user) => store.accessibleTenants({ ...user, tenant_id: user.home_tenant_id || user.tenant_id });

  /**
   * Wist de omgevingscookies; alleen wat er is (de sessie-cookie blijft zo de eerste Set-Cookie).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  function clearEnvironment(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[ENV_COOKIE]) auth.clearNamed(res, ENV_COOKIE);
    if (cookies[ENV_HINT]) auth.clearNamed(res, ENV_HINT);
  }

  /**
   * Een omgeving voor de frontend, met de naam van de live-tenant.
   * @param {object|null} tenantRow De tenant.
   * @returns {object|null} De omgeving, of null.
   */
  function environmentInfo(tenantRow) {
    if (!tenantRow) return null;
    const parent = tenantRow.parent_id ? store.getTenant(tenantRow.parent_id) : null;
    return { ...store.tenantRow(tenantRow), parentName: parent ? parent.name : null };
  }


  const guestLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: remoteIp });
  /**
   * De gebruiker, of (met gasten aan) een nieuwe gast; begrensd per IP.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null|undefined} De gebruiker; null zonder; undefined als de limiet al heeft geantwoord.
   */
  function ensureUser(req, res) {
    const user = identify(req);
    if (user || !guestsAllowed()) return user;
    // De limiter roept next() direct aan, of beantwoordt zelf met 429.
    let allowed = false;
    guestLimiter(req, res, () => { allowed = true; });
    if (!allowed) return undefined;
    const guest = store.createGuest(tenant.id);
    auth.setGuestCookie(req, res, guest.id);
    req.user = withRights(guest);
    return req.user;
  }

  /**
   * Middleware: alleen met een gebruiker (of nieuwe gast).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const requireUser = (req, res, next) => {
    const user = ensureUser(req, res);
    if (user === undefined) return; // limiet al beantwoord
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    next();
  };
  // Rechten per rol staan in frontend/shared/roles.js; een hoofdbeheerder mag alles.
  const FORBIDDEN = {
    beheer: 'Alleen voor beheerders.',
    offertes: 'Alleen voor beheerders en installateurs.',
    'offertes.alle': 'Alleen voor beheerders en installateurs.',
    'plannen.alle': 'Alleen voor beheerders en installateurs.',
    werkorders: 'Alleen voor medewerkers met toegang tot werkorders.',
    planning: 'Alleen voor medewerkers met toegang tot de planning.',
    uitbesteden: 'Je rol heeft geen toegang tot uitbesteden.',
    nieuws: 'Je rol mag geen nieuwsberichten plaatsen.',
    voorraad: 'Je rol heeft geen toegang tot voorraadbeheer.',
    portaal: 'Het klantportaal is er voor klanten.',
    plannen: 'Je rol heeft geen toegang tot de beregeningsplanner.',
  };
  /**
   * Middleware die een recht eist (rechten per rol in frontend/shared/roles.js).
   * @param {string} right Het recht.
   * @returns {Function} Middleware.
   */
  const requireRight = (right) => (req, res, next) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!Roles.can(user, right)) return res.status(403).json({ error: 'forbidden', message: FORBIDDEN[right] || 'Geen toegang.' });
    next();
  };
  const requireAdmin = requireRight('beheer');
  /**
   * Middleware: een gebruiker (of nieuwe gast) met het recht plannen.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const requirePlans = (req, res, next) => requireUser(req, res, () => {
    if (!Roles.can(req.user, 'plannen')) return res.status(403).json({ error: 'forbidden', message: FORBIDDEN.plannen });
    next();
  });
  /**
   * Middleware: alleen voor hoofdbeheerders.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const requirePlatformAdmin = (req, res, next) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!user.platform_admin) return res.status(403).json({ error: 'forbidden', message: 'Alleen voor hoofdbeheerders.' });
    next();
  };
  /**
   * Middleware: schrijven alleen met JSON (geen cross-site formulieren).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const requireJson = (req, res, next) => {
    if (req.is('application/json')) return next();
    res.status(415).json({ error: 'json_required', message: 'Verwacht JSON.' });
  };
  /**
   * Het IP-adres van de bezoeker (CF-Connecting-IP achter de tunnel).
   * @param {object} req Het verzoek.
   * @returns {string} Het adres.
   */
  const ipOf = (req) => remoteIp(req);

  /**
   * De organisatiecode waarmee de gebruiker inlogt (leeg voor de hoofdtenant).
   * @param {object|null} user De gebruiker.
   * @returns {string} De code.
   */
  const loginCodeOf = (user) => {
    const tenantRow = user && store.getTenant(user.home_tenant_id || user.tenant_id);
    return !tenantRow || tenantRow.slug === 'default' ? '' : tenantRow.slug;
  };

  // ---------- Eigen wachtwoord wijzigen ----------
  // Met het huidige wachtwoord ter controle; daarna is de gebruiker op alle
  // andere toestellen uitgelogd en krijgt dit toestel een nieuwe sessie.
  app.post('/api/account/password', requireJson, wrap(async (req, res) => {
    const session = auth.session(req);
    if (session?.via !== 'user') return res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je wachtwoord te wijzigen.' });
    if (identify(req)?.impersonation) return res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' });
    const key = `wachtwoord:${session.user.id}`;
    if (lockedOut(key)) return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
    const out = await store.changeOwnPassword(session.user.id, String(req.body?.currentPassword ?? '').slice(0, 1024), String(req.body?.newPassword ?? '').slice(0, 1024));
    if (out.error) {
      if (out.wrong) failed(key);
      return res.status(out.status || 400).json({ error: out.wrong ? 'wrong_password' : 'invalid_password', message: out.error });
    }
    failures.delete(key);
    auth.setCookie(req, res, out.user.id);
    audit(req, 'wachtwoord_gewijzigd', { door: 'gebruiker' }, out.user.id, out.user.tenant_id);
    res.json({ ok: true, user: store.publicUser(out.user) });
  }));

  // ---------- Mijn profiel ----------
  // Naam, e-mail, telefoon en persoonlijke voorkeuren van het eigen account
  // (niet met de toegangscode, niet tijdens een impersonatie).
  /**
   * Het eigen account voor Mijn profiel; stuurt zelf een fout als dat er niet is.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De gebruiker, of null (antwoord al verstuurd).
   */
  function profileOwner(req, res) {
    const session = auth.session(req);
    if (session?.via !== 'user') { res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je profiel te bekijken.' }); return null; }
    if (identify(req)?.impersonation) { res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' }); return null; }
    return session.user;
  }
  /**
   * Het profiel voor de API.
   * @param {object} user De gebruiker.
   * @returns {{ user: object, preferences: object }} Gegevens en voorkeuren.
   */
  const profileOf = (user) => ({ user: store.publicUser(user), preferences: preferencesOf(user) });

  app.get('/api/account/profile', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const owner = profileOwner(req, res);
    // s.user is in dit verzoek net uit de database gelezen.
    if (owner) res.json(profileOf(owner));
  });

  app.put('/api/account/profile', requireJson, (req, res) => {
    const owner = profileOwner(req, res);
    if (!owner) return;
    const input = {};
    for (const field of ['displayName', 'email', 'phone', 'preferences']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    const out = store.updateProfile(owner.id, input);
    if (out.error) return res.status(400).json({ error: 'invalid_profile', field: out.field, message: out.error });
    // Welke velden, nooit de waarden (persoonsgegevens horen niet in het logboek).
    if (out.changed.length) audit(req, 'profiel_gewijzigd', { velden: out.changed }, owner.id, owner.tenant_id);
    res.json(profileOf(out.user));
  });

  app.get('/api/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    const via = auth.session(req)?.via || (user ? 'gast' : null);
    const active = environmentInfo(store.getTenant(req.tenantId));
    // De leesbare hint-cookie volgt de werkelijke omgeving (bijv. na het
    // verwijderen van een testomgeving valt de gebruiker terug op live).
    const hint = parseHint(req);
    const wanted = user && active && active.environment === 'test' ? `${active.slug}|${active.name}` : null;
    if (hint !== wanted) {
      if (wanted) auth.setPlain(req, res, ENV_HINT, wanted, { httpOnly: false });
      else auth.clearNamed(res, ENV_HINT);
    }
    impersonation.syncHint(req, res, user);
    const imp = user?.impersonation;
    res.json({
      user: user ? store.publicUser(user) : null,
      via,
      // Persoonlijke voorkeuren (Mijn profiel), alleen voor een eigen account.
      preferences: user?.kind === 'account' && !user.impersonation ? preferencesOf(user) : null,
      tenant: active,
      platformAdmin: Boolean(user?.platform_admin),
      // Organisatiecode waarmee de gebruikers van deze organisatie inloggen
      // (leeg voor de hoofdtenant).
      loginCode: loginCodeOf(user),
      // Wat deze gebruiker mag (zie roles.js); een nog niet bewaarde gast is een klant.
      rights: user ? Roles.rightsOf(user) : guestsAllowed() ? store.roles.rightsFor(tenant.id, 'klant') : [],
      // Tijdens een impersonatie wordt er niet gewisseld (eerst terug naar het eigen account).
      environments: user && !imp ? accessibleFor(user).length : 0,
      impersonation: imp ? { by: user.impersonator.display_name, expiresAt: imp.expiresAt, live: imp.live, environment: imp.tenantName } : null,
      // Aantal nieuwe berichten en versies sinds het vorige bezoek aan Nieuws
      // (alleen met een eigen account; uit het geheugen, zie news.js).
      news: user?.kind === 'account' && !imp
        ? unreadCount({ marks: newsStore.marks(req.tenantId), prefs: preferencesOf(user), user, rights: Roles.rightsOf(user), customer: isCustomer(req, user) })
        : 0,

      // Staan gasten aan, dan werkt iedereen zonder inloggen als (nieuwe) gast.
      guest: !user && guestsAllowed(),
      accessCodeConfigured: Boolean(getAccessCode()),
      setupRequired: needsSetup(),
    });
  });

  /**
   * De leesbare omgevingscookie (testlabel).
   * @param {object} req Het verzoek.
   * @returns {string|null} '<slug>|<naam>', of null.
   */
  function parseHint(req) {
    const raw = parseCookies(req.headers.cookie)[ENV_HINT];
    return typeof raw === 'string' && raw ? raw : null;
  }

  // Omgevingen waarin deze gebruiker mag werken, en wisselen.
  app.get('/api/environments', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.json({ current: req.tenantId, home: user.home_tenant_id, items: accessibleFor(user).map(environmentInfo) });
  });

  app.post('/api/environment', requireJson, (req, res) => {
    const user = identify(req);
    if (!user || user.kind === 'gast') return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (user.impersonator) return res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' });
    const requestedId = String(req.body?.tenantId || '');
    const target = accessibleFor(user).find((environment) => environment.id === requestedId);
    if (!target) return res.status(404).json({ error: 'not_found', message: 'Omgeving niet gevonden.' });
    clearEnvironment(req, res);
    if (target.id !== user.home_tenant_id) {
      auth.setSigned(req, res, ENV_COOKIE, `${user.id}:${target.id}`, 'env');
      if (target.environment === 'test') auth.setPlain(req, res, ENV_HINT, `${target.slug}|${target.name}`, { httpOnly: false });
    }
    console.log(`${user.display_name} werkt nu in ${target.name} (${target.environment})`);
    res.json({ ok: true, tenant: environmentInfo(target) });
  });


  // ---------- Plannen: alleen de eigen plannen ----------
  const planLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 900, keyFn: (req) => req.user?.id || remoteIp(req) });
  /**
   * Is dit een plan (object met areas)?
   * @param {*} data De invoer.
   * @returns {boolean} true als het een plan is.
   */
  const validPlan = (data) => data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.areas);

  // Eigen plannen; beheerders en installateurs met ?all=1 alle plannen van
  // de organisatie (zonder historie: die is alleen voor beheerders).
  app.get('/api/plans', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user || !Roles.can(user, 'plannen')) return res.json({ items: [] });
    const all = req.query.all === '1' && Roles.can(user, 'plannen.alle');
    res.json({ items: store.listPlans(req.tenantId, { ownerId: all ? null : user.id, reviewStatus: req.query.review || null }) });
  });

  app.get('/api/plans/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (user && !Roles.can(user, 'plannen')) return res.status(403).json({ error: 'forbidden', message: FORBIDDEN.plannen });
    // Alleen de eigenaar (of beheerder/installateur); anders 404, zodat niet te zien is
    // of een plan van iemand anders bestaat.
    const plan = user && store.getPlan(user, req.params.id);
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  app.post('/api/plans', requireJson, requirePlans, planLimiter, (req, res) => {
    const data = req.body?.data;
    if (!validPlan(data)) return res.status(400).json({ error: 'invalid_plan', message: 'Ongeldig plan.' });
    res.status(201).json(store.savePlan(req.user, null, data, ipOf(req)));
  });

  app.put('/api/plans/:id', requireJson, requirePlans, planLimiter, (req, res) => {
    const data = req.body?.data;
    if (!validPlan(data)) return res.status(400).json({ error: 'invalid_plan', message: 'Ongeldig plan.' });
    const plan = store.savePlan(req.user, req.params.id, data, ipOf(req));
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  app.delete('/api/plans/:id', (req, res) => {
    const user = identify(req);
    if (user && !Roles.can(user, 'plannen')) return res.status(403).json({ error: 'forbidden', message: FORBIDDEN.plannen });
    if (!user || !store.deletePlan(user, req.params.id, ipOf(req))) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json({ ok: true });
  });

  // ---------- Beheer: historie, alle plannen, gebruikers ----------
  app.use('/api/admin', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requireAdmin);

  app.get('/api/admin/history', (req, res) => {
    const { limit, offset, user, q: search, action } = req.query;
    res.json(store.listHistory(req.tenantId, { limit, offset, userId: user, search, action }));
  });

  app.get('/api/admin/history/:id', (req, res) => {
    const entry = store.getHistory(req.tenantId, req.params.id);
    if (!entry) return res.status(404).json({ error: 'not_found', message: 'Niet gevonden.' });
    res.json(entry);
  });

  app.get('/api/admin/plans', (req, res) => {
    res.json({ items: store.listPlans(req.tenantId, {
      ownerId: req.query.owner ? String(req.query.owner) : null,
      includeDeleted: req.query.deleted === '1',
      withHistory: true,
      reviewStatus: req.query.review || null,
    }) });
  });

  // Tijdlijn van één plan (ook als het plan verwijderd is).
  app.get('/api/admin/plans/:id/history', (req, res) => {
    res.json(store.listHistory(req.tenantId, { planId: req.params.id, limit: 500 }));
  });

  app.get('/api/admin/plans/:id', (req, res) => {
    const plan = store.getPlan(req.user, req.params.id);
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  /**
   * Waar de gebruikers staan: bij de live-tenant (ook in een testomgeving).
   * Testaccounts (zie test-data.js) horen bij de testomgeving zelf en beheren
   * alleen de gebruikers daarvan, nooit die van live.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de tenant met de gebruikers.
   */
  const usersTenantOf = (req) => (req.user && req.user.home_tenant_id === req.tenantId ? req.tenantId : homeOf(req.tenantId));

  /**
   * Een hoofdbeheerder kan alleen door een (andere) hoofdbeheerder worden
   * gewijzigd, uitgeschakeld of uitgelogd, niet door een beheerder van de tenant.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {string} userId Id van de gebruiker.
   * @returns {boolean} true als het geweigerd is (antwoord al verstuurd).
   */
  function guardPlatformAdmin(req, res, userId) {
    const target = store.getUser(userId);
    if (!target || !target.platform_admin || req.user.platform_admin) return false;
    res.status(403).json({ error: 'forbidden', message: 'Alleen een hoofdbeheerder kan een hoofdbeheerder wijzigen.' });
    return true;
  }

  app.get('/api/admin/users', (req, res) => {
    const home = usersTenantOf(req);
    res.json({ items: store.listUsers(home), roles: store.roles.list(home) });
  });

  // ---------- Rollen (Beheer > Rollen, zie roles.js) ----------
  // Rollen gelden voor de hele organisatie (live en testomgevingen). Een
  // testaccount (dat in een testomgeving woont) kan ze zien maar niet wijzigen.
  /**
   * Mag deze gebruiker de rollen wijzigen? Stuurt anders zelf 403.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {boolean} true als het mag.
   */
  function rolesEditable(req, res) {
    const home = store.getTenant(req.user.home_tenant_id || req.user.tenant_id);
    if (req.user.platform_admin || !home || home.environment !== 'test') return true;
    res.status(403).json({ error: 'forbidden', message: 'Rollen gelden voor de hele organisatie; wijzig ze met een account van live.' });
    return false;
  }
  /**
   * De rollen met het aantal gebruikers per rol.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De rollen.
   */
  const rolesView = (tenantId) => {
    const counts = store.roles.userCounts(tenantId);
    return store.roles.list(tenantId).map((role) => ({ ...role, userCount: counts[role.key] || 0 }));
  };
  /**
   * Stuurt een fout uit de rollenopslag terug.
   * @param {object} res Het antwoord.
   * @param {{ status?: number, code?: string, error: string, field?: string }} out De fout.
   * @returns {void}
   */
  const roleError = (res, out) => res.status(out.status || 400).json({ error: out.code || (out.status === 404 ? 'not_found' : 'invalid_role'), message: out.error, field: out.field || null });

  app.get('/api/admin/roles', (req, res) => {
    const home = store.getTenant(req.user.home_tenant_id || req.user.tenant_id);
    res.json({ items: rolesView(req.tenantId), editable: Boolean(req.user.platform_admin || !home || home.environment !== 'test') });
  });

  app.post('/api/admin/roles', requireJson, (req, res) => {
    if (!rolesEditable(req, res)) return;
    const { label, description, kind, rights, copyOf } = req.body || {};
    // Een nieuwe rol kan de rechten van een bestaande rol overnemen.
    const from = copyOf ? store.roles.get(req.tenantId, copyOf) : null;
    const out = store.roles.create(req.tenantId, { label, description, kind: kind ?? from?.kind, rights: rights ?? from?.rights ?? [] });
    if (out.error) return roleError(res, out);
    audit(req, 'rol_aangemaakt', { rol: out.role.key, naam: out.role.label, rechten: out.role.rights }, undefined, store.roles.rootOf(req.tenantId));
    res.status(201).json(out.role);
  });

  app.patch('/api/admin/roles/:key', requireJson, (req, res) => {
    if (!rolesEditable(req, res)) return;
    const input = {};
    for (const field of ['label', 'description', 'rights', 'kind']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    const out = store.roles.update(req.tenantId, req.params.key, input);
    if (out.error) return roleError(res, out);
    const added = out.role.rights.filter((right) => !out.before.rights.includes(right));
    const removed = out.before.rights.filter((right) => !out.role.rights.includes(right));
    audit(req, 'rol_gewijzigd', { rol: out.role.key, fields: Object.keys(input), ...(added.length ? { aan: added } : {}), ...(removed.length ? { uit: removed } : {}) },
      undefined, store.roles.rootOf(req.tenantId));
    res.json(out.role);
  });

  // Eigen rol verwijderen (zonder gebruikers) of een standaardrol terugzetten.
  app.delete('/api/admin/roles/:key', (req, res) => {
    if (!rolesEditable(req, res)) return;
    const out = store.roles.remove(req.tenantId, req.params.key);
    if (out.error) return roleError(res, out);
    audit(req, out.reset ? 'rol_teruggezet' : 'rol_verwijderd', { rol: out.role.key, naam: out.role.label }, undefined, store.roles.rootOf(req.tenantId));
    res.json({ ok: true, reset: out.reset, role: out.reset ? store.roles.get(req.tenantId, out.role.key) : null });
  });

  app.post('/api/admin/users', requireJson, wrap(async (req, res) => {
    const { username, displayName, role, password } = req.body || {};
    const home = usersTenantOf(req);
    const out = await store.createAccount(home, { username: String(username || '').trim().toLowerCase(), displayName, role, password },
      { mustChangePassword: req.body?.mustChangePassword !== false });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    audit(req, 'gebruiker_aangemaakt', { userId: out.user.id, username: out.user.username, role: out.user.role }, undefined, home);
    res.status(201).json(store.publicUser(out.user));
  }));

  app.patch('/api/admin/users/:id', requireJson, wrap(async (req, res) => {
    const input = {};
    for (const field of ['displayName', 'role', 'disabled', 'password', 'username']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    withMustChange(input, req.body);
    const home = usersTenantOf(req);
    if (guardPlatformAdmin(req, res, req.params.id)) return;
    const out = await store.updateAccount(home, req.params.id, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    auditUserChange(req, out.user, input, home);
    res.json(store.publicUser(out.user));
  }));

  /**
   * Wachtwoord wijzigen na de eerste aanmelding: aan/uit te zetten, en standaard
   * aan als een beheerder een nieuw wachtwoord instelt.
   * @param {object} input De wijzigingen (wordt aangevuld).
   * @param {object} body Het verzoek.
   * @returns {object} input.
   */
  function withMustChange(input, body) {
    if (body?.mustChangePassword !== undefined) input.mustChangePassword = Boolean(body.mustChangePassword);
    else if (input.password !== undefined) input.mustChangePassword = true;
    return input;
  }

  /**
   * Auditregel voor een gewijzigde gebruiker: welke velden, nooit de waarden van een wachtwoord.
   * @param {object} req Het verzoek.
   * @param {object} user De gewijzigde gebruiker.
   * @param {object} input De wijzigingen.
   * @param {string} tenantId Tenant van de gebruiker.
   * @returns {void}
   */
  function auditUserChange(req, user, input, tenantId) {
    audit(req, 'gebruiker_gewijzigd', { userId: user.id, username: user.username, fields: Object.keys(input),
      ...(input.role !== undefined ? { role: input.role } : {}), ...(input.disabled !== undefined ? { disabled: Boolean(input.disabled) } : {}),
      ...(input.platformAdmin !== undefined ? { hoofdbeheerder: Boolean(input.platformAdmin) } : {}),
      ...(input.mustChangePassword !== undefined ? { wachtwoordWijzigen: input.mustChangePassword } : {}) }, undefined, tenantId);
  }

  // Gebruiker op alle toestellen uitloggen.
  app.post('/api/admin/users/:id/logout', (req, res) => {
    const home = usersTenantOf(req);
    const target = store.getUser(req.params.id);
    if (!target || target.tenant_id !== home) return res.status(404).json({ error: 'not_found', message: 'Gebruiker niet gevonden.' });
    if (guardPlatformAdmin(req, res, target.id)) return;
    const revoked = store.revokeSessions(home, target.id);
    audit(req, 'sessies_ingetrokken', { userId: target.id, username: target.username, count: revoked }, undefined, home);
    res.json({ ok: true, revoked });
  });

  /**
   * Gebruiker definitief verwijderen. Niet jezelf (dan zit je zonder account),
   * en een hoofdbeheerder alleen door een andere hoofdbeheerder.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {string} tenantId Tenant van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @param {object} [extra] Extra details voor het auditlog.
   * @returns {void}
   */
  function deleteUser(req, res, tenantId, userId, extra = {}) {
    if (req.user && (req.user.id === userId || req.user.impersonator?.id === userId)) {
      return res.status(409).json({ error: 'invalid_user', message: 'Je kunt je eigen account niet verwijderen.' });
    }
    const out = store.deleteAccount(tenantId, userId);
    if (out.error) return res.status(out.status || 400).json({ error: out.status === 404 ? 'not_found' : 'invalid_user', message: out.error });
    audit(req, 'gebruiker_verwijderd', { userId: out.user.id, username: out.user.username, role: out.user.role, ...extra,
      ...(out.user.platform_admin ? { hoofdbeheerder: true } : {}), overgedragen: out.moved }, undefined, tenantId);
    res.json({ ok: true, moved: out.moved });
  }

  app.delete('/api/admin/users/:id', (req, res) => {
    if (guardPlatformAdmin(req, res, req.params.id)) return;
    deleteUser(req, res, usersTenantOf(req), req.params.id);
  });

  // Plan definitief wissen, inclusief de inhoud van de historie (AVG).
  app.delete('/api/admin/plans/:id', (req, res) => {
    const out = store.purgePlan(req.tenantId, req.params.id);
    if (out) recognitions.removePlan(req.tenantId, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    audit(req, 'plan_gewist', { planId: req.params.id, historyRows: out.history });
    res.json({ ok: true, ...out });
  });

  // ---------- Beheer: back-ups ----------
  // Alleen versleutelde bestanden; downloaden is dus veilig voor een kopie
  // elders (zonder de hoofdsleutel onleesbaar). Een back-up bevat de hele
  // database (alle tenants), dus alleen voor hoofdbeheerders.
  // (Ook met de toegangscode van de hoofdtenant, zoals op een installatie
  // met één organisatie.)
  app.use('/api/admin/backups', (req, res, next) => {
    const user = req.user;
    if (user.platform_admin || (user.kind === 'systeem' && req.tenantId === tenant.id)) return next();
    res.status(403).json({ error: 'forbidden', message: 'Alleen voor hoofdbeheerders.' });
  });
  let backupRunning = null;
  /**
   * Maakt een versleutelde back-up (één tegelijk) en ruimt oude op.
   * @param {object|null} [req] Het verzoek (null = automatisch).
   * @returns {Promise<object>} De back-up (name, size).
   */
  async function runBackup(req = null) {
    if (!backupDir) throw Object.assign(new Error('Back-ups zijn niet ingesteld.'), { status: 501 });
    if (backupRunning) return backupRunning;
    backupRunning = (async () => {
      try {
        const backup = await backups.createBackup({ db: database, dir: backupDir, vault });
        backups.pruneBackups(backupDir, Math.max(1, settings.get('backupKeepDays')));
        if (req) audit(req, 'backup_gemaakt', { name: backup.name, size: backup.size }, undefined, tenant.id);
        else store.audit({ tenantId: tenant.id, action: 'backup_gemaakt', detail: { name: backup.name, size: backup.size, automatisch: true } });
        return backup;
      } finally {
        backupRunning = null;
      }
    })();
    return backupRunning;
  }

  app.get('/api/admin/backups', (req, res) => {
    res.json({ enabled: Boolean(backupDir), keepDays: settings.get('backupKeepDays'), items: backupDir ? backups.listBackups(backupDir) : [] });
  });

  app.post('/api/admin/backups', wrap(async (req, res) => {
    if (!backupDir) return res.status(501).json({ error: 'not_supported', message: 'Back-ups zijn niet ingesteld.' });
    res.status(201).json(await runBackup(req));
  }));

  app.get('/api/admin/backups/:name', (req, res) => {
    const name = req.params.name;
    if (!backupDir || !backups.isBackupName(name) || !fs.existsSync(path.join(backupDir, name))) {
      return res.status(404).json({ error: 'not_found', message: 'Back-up niet gevonden.' });
    }
    audit(req, 'backup_gedownload', { name }, undefined, tenant.id);
    res.download(path.join(backupDir, name), name);
  });

  app.delete('/api/admin/backups/:name', (req, res) => {
    const name = req.params.name;
    if (!backupDir || !backups.isBackupName(name) || !fs.existsSync(path.join(backupDir, name))) {
      return res.status(404).json({ error: 'not_found', message: 'Back-up niet gevonden.' });
    }
    fs.rmSync(path.join(backupDir, name), { force: true });
    console.log(`Back-up ${name} verwijderd door ${req.user.display_name}`);
    audit(req, 'backup_verwijderd', { name }, undefined, tenant.id);
    res.json({ ok: true });
  });

  // Auditlog: beveiligingsgebeurtenissen.
  app.get('/api/admin/audit', (req, res) => {
    const { limit, offset, action } = req.query;
    res.json(store.listAudit(req.tenantId, { limit, offset, action }));
  });

  // ---------- Beheer: instellingen (van de actieve omgeving) ----------
  app.get('/api/admin/settings', (req, res) => {
    // aiFromLive: testomgeving zonder eigen sleutel gebruikt die van live.
    const aiFrom = aiTenantOf(req.tenantId);
    res.json({ settings: settingsFor(req.tenantId).view(), via: auth.session(req)?.via || null,
      aiFromLive: aiFrom !== req.tenantId && Boolean(settingsFor(aiFrom).get('anthropicApiKey')) });
  });

  app.put('/api/admin/settings', requireJson, (req, res) => {
    const settings = settingsFor(req.tenantId);
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    // De toegangscode geldt alleen voor de hoofdtenant.
    const via = req.tenantId === tenant.id ? auth.session(req)?.via : null;
    const oldCode = settings.get('accessCode');
    // Wie met de toegangscode is ingelogd, zou zichzelf buitensluiten door die
    // leeg te maken; met een beheerdersaccount kan het wel.
    const resets = Array.isArray(patch.reset) ? patch.reset : [];
    const platformField = [...Object.keys(patch), ...resets].find((key) => FIELDS[key]?.platform || FIELDS[key]?.internal);
    if (platformField) {
      return res.status(400).json({ error: 'invalid_setting', field: platformField,
        message: FIELDS[platformField].internal ? 'Deze instelling wijzig je in de module zelf.' : 'Deze instelling wijzig je in Hoofdbeheer.' });
    }
    const codeAfter = patch.accessCode !== undefined ? String(patch.accessCode).trim()
      : resets.includes('accessCode') ? settings.get('accessCode', true) : oldCode;
    if (via === 'code' && !codeAfter) {
      return res.status(400).json({ error: 'invalid_setting', field: 'accessCode', message: 'Je bent ingelogd met de toegangscode; leegmaken sluit je buiten. Maak eerst een beheerdersaccount aan (tabblad Gebruikers) en log daarmee in.' });
    }
    let changed;
    try {
      changed = settings.update(patch, req.user?.id);
    } catch (err) {
      if (err instanceof SettingsError) return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
      throw err;
    }
    // Nieuwe toegangscode: andere toestellen zijn uitgelogd, deze beheerder niet.
    if (via === 'code' && settings.get('accessCode') && settings.get('accessCode') !== oldCode) auth.setCookie(req, res);
    if (changed.length) {
      console.log(`Instellingen gewijzigd door ${req.user?.display_name || 'beheerder'}: ${changed.join(', ')}`);
      audit(req, 'instellingen_gewijzigd', { fields: changed });
    }
    res.json({ settings: settings.view(), changed });
  });

  // Sleutel testen zonder kosten: vraagt alleen het model op.
  app.post('/api/admin/settings/test-ai', async (req, res, next) => {
    const aiClient = currentAnalyzer(req.tenantId);
    if (!aiClient.check) return res.status(501).json({ error: 'not_supported', message: 'Testen is niet beschikbaar.' });
    try {
      res.json(await aiClient.check());
    } catch (err) {
      if (err instanceof AnalyzeError) return res.status(err.status === 502 ? 400 : err.status).json({ error: err.code, message: err.message });
      next(err);
    }
  });

  // ---------- Beheer: AI-kosten (zie ai-usage.js) ----------
  // Een beheerder ziet de actieve omgeving; een hoofdbeheerder kan ook alle
  // organisaties samen (?scope=all) of één andere omgeving (?tenant=id) zien.
  /**
   * De omgevingen waarvan de AI-kosten worden gevraagd; stuurt bij een fout zelf het antwoord.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {string[]|null|undefined} Ids, null = alle, undefined = antwoord al verstuurd.
   */
  function aiUsageScope(req, res) {
    const all = req.query.scope === 'all';
    const other = typeof req.query.tenant === 'string' && req.query.tenant && req.query.tenant !== req.tenantId;
    if (!all && !other) return [req.tenantId];
    if (!req.user?.platform_admin) {
      res.status(403).json({ error: 'forbidden', message: 'Alleen een hoofdbeheerder ziet de AI-kosten van andere organisaties.' });
      return undefined;
    }
    if (all) return null;
    if (!store.getTenant(req.query.tenant)) {
      res.status(404).json({ error: 'not_found', message: 'Organisatie niet gevonden.' });
      return undefined;
    }
    return [req.query.tenant];
  }

  app.get('/api/admin/ai-usage', (req, res) => {
    const scope = aiUsageScope(req, res);
    if (scope === undefined) return;
    const aiSettings = settingsFor(aiTenantOf(req.tenantId));
    res.json({ ...aiUsage.summary(scope, req.query), scope: scope ? 'tenant' : 'all', platformAdmin: Boolean(req.user?.platform_admin),
      model: aiSettings.get('aiModel'), eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), retentionDays: settingsFor(req.tenantId).get('auditRetentionDays') });
  });

  app.get('/api/admin/ai-usage/requests', (req, res) => {
    const scope = aiUsageScope(req, res);
    if (scope === undefined) return;
    res.json(aiUsage.list(scope, req.query, { limit: req.query.limit, offset: req.query.offset }));
  });

  // WAN-IP van de server, voor een Exchange Online-connector op IP-basis
  // (Instellingen > E-mail). Voor alle tenants gelijk; een uur onthouden.
  app.get('/api/admin/wan-ip', async (req, res) => {
    try {
      res.json(await wanIp.get({ refresh: req.query.refresh === '1' }));
    } catch (err) {
      res.status(502).json({ error: 'unavailable', message: 'Het WAN-IP kon niet worden bepaald. Controleer of de server naar buiten kan, of zet WAN_IP in de Docker-omgeving.' });
    }
  });

  // Automatisch herkennen van een plan. De URL is (zonder toegangscode)
  // openbaar, dus elke aanroep kost tegoed: per IP begrensd plus een
  // dagelijks maximum voor de hele app (beide in Beheer > Instellingen).
  // Limieten en dagteller per tenant (omgeving).
  const analyzeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: (req) => settingsFor(req.tenantId || tenant.id).get('aiHourlyPerIp'), keyFn: (req) => `${req.tenantId || tenant.id}|${remoteIp(req)}` });
  const dailyCounts = new Map();
  /**
   * De datum van vandaag (UTC).
   * @returns {string} Datum als JJJJ-MM-DD.
   */
  const today = () => new Date().toISOString().slice(0, 10);
  /**
   * De teller van AI-herkenningen van vandaag voor een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ day: string, count: number }} De teller.
   */
  function dailyFor(tenantId) {
    let counter = dailyCounts.get(tenantId);
    if (!counter || counter.day !== today()) {
      counter = { day: today(), count: 0 };
      dailyCounts.set(tenantId, counter);
    }
    return counter;
  }
  /**
   * Middleware: ingelogd, of gasten staan aan.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const requireAppAccess = (req, res, next) => {
    if (identify(req)) return next();
    // Een sessie die identify() afwijst (uitgeschakelde organisatie) is geen gast.
    if (guestsAllowed() && !auth.session(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
  };

  app.get('/api/plan/status', requireAppAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const settings = settingsFor(req.tenantId);
    res.json({ available: Boolean(aiAvailable(req.tenantId)), remainingToday: Math.max(0, settings.get('aiDailyLimit') - dailyFor(req.tenantId).count) });
  });

  app.post('/api/plan/analyze', requireAppAccess, analyzeLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const { image, width, height } = req.body || {};
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    const imageWidth = Number(width), imageHeight = Number(height);
    if (!match || !(imageWidth > 0 && imageHeight > 0 && imageWidth <= 8000 && imageHeight <= 8000)) {
      return res.status(400).json({ error: 'invalid_image', message: 'Ongeldige afbeelding.' });
    }
    const settings = settingsFor(req.tenantId);
    if (!settings.get('aiEnabled')) {
      return res.status(409).json({ error: 'disabled', message: 'Automatisch herkennen met AI staat uit (Beheer > Instellingen). De lokale herkenning en tekenen werken wel.' });
    }
    const planAnalyzer = currentAnalyzer(req.tenantId);
    if (!planAnalyzer.available) {
      return res.status(409).json({ error: 'not_configured', message: 'Automatisch herkennen is niet ingesteld: een beheerder kan de API-sleutel invullen bij Beheer > Instellingen.' });
    }
    // Dezelfde tekening (zelfde afbeelding, model en opdracht) geeft altijd
    // hetzelfde resultaat: de eerder bewaarde herkenning, zonder AI-kosten.
    // Met fresh: true herkent de AI opnieuw; die uitkomst geldt daarna.
    const hash = imageHash(match[1], match[2]);
    const aiModel = planAnalyzer.model || settingsFor(aiTenantOf(req.tenantId)).get('aiModel');
    if (req.body.fresh !== true) {
      const known = recognitions.findAi(req.tenantId, hash, aiModel, PROMPT_VERSION);
      if (known) return res.json({ ...known.result, recognition: { id: known.id, cached: true, learned: known.learned } });
    }
    const daily = dailyFor(req.tenantId);
    if (daily.count >= settings.get('aiDailyLimit')) {
      return res.status(429).json({ error: 'daily_limit', message: 'Het dagelijkse maximum voor automatisch herkennen is bereikt. Probeer het morgen opnieuw of teken het plan zelf.' });
    }
    daily.count += 1;
    const started = Date.now();
    /**
     * Elk verzoek dat de AI-dienst bereikt komt in het kostenoverzicht, ook
     * als het mislukt (een weigering of te lang antwoord kost ook tokens).
     * @param {object|null} user Wie het vroeg.
     * @param {{ model?: string, usage?: object, status?: string, detail?: object }} result Model, verbruik, status en details.
     * @returns {void}
     */
    const logUsage = (user, { model, usage, status = 'ok', detail = {} }) => {
      try {
        aiUsage.record({ tenantId: req.tenantId || tenant.id, userId: user ? user.id : null, feature: 'plan_analyse',
          model: model || planAnalyzer.model || settingsFor(aiTenantOf(req.tenantId)).get('aiModel'), status, usage: usage || {}, durationMs: Date.now() - started,
          eurCentsPerUsd: settingsFor(aiTenantOf(req.tenantId)).get('aiEurCentsPerUsd'), detail: { width: imageWidth, height: imageHeight, ...detail } });
      } catch (err) {
        console.warn(`AI-verbruik niet vastgelegd: ${err.message}`);
      }
    };
    try {
      const result = await planAnalyzer.analyze({ mediaType: match[1], data: match[2], width: imageWidth, height: imageHeight });
      console.log(`Plan geanalyseerd: ${result.areas.length} vlakken, schaal ${result.scale.method || '-'} (${result.scale.confidence || '-'})`);
      const user = identify(req) || (guestsAllowed() ? ensureUser(req, res) : null);
      logUsage(user, { model: result.model, usage: result.usage,
        detail: { areas: result.areas.length, elements: (result.elements || []).length, scale: result.scale.method || null } });
      if (res.headersSent) return;
      if (user) {
        store.record({ tenantId: req.tenantId, userId: user.id, action: 'analyse', title: 'Plan herkend',
          summary: { areas: result.areas.length, elements: (result.elements || []).length, scale: result.scale.method || null, confidence: result.scale.confidence || null }, ip: ipOf(req) });
      }
      // usage/model horen bij de kosten, niet bij de bewaarde herkenning
      const { usage, ...kept } = result;
      let recognition = null;
      try {
        recognition = { id: recognitions.saveAi({ tenantId: req.tenantId || tenant.id, userId: user ? user.id : null, hash, model: aiModel, version: PROMPT_VERSION, result: kept }), cached: false, learned: false };
      } catch (err) {
        console.warn(`Herkenning niet bewaard: ${err.message}`);
      }
      res.json({ ...result, recognition });
    } catch (err) {
      if (err instanceof AnalyzeError) {
        if (err.code !== 'not_configured') logUsage(identify(req), { model: err.model, usage: err.usage, status: err.code });
        console.warn(`Plananalyse mislukt: ${err.code} – ${err.message}`);
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      logUsage(identify(req), { status: 'error' });
      next(err);
    }
  });

  // Leren van herkende plannen (zie recognitions.js en localrecog.js). De
  // planner haalt de geleerde kleuren op voor de lokale herkenning, en stuurt
  // na een AI-herkenning of een goedkeuring alleen kleurtellingen (geen beeld).
  const learnLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `${req.tenantId || tenant.id}|${remoteIp(req)}` });
  app.get('/api/plan/learned', requireAppAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(recognitions.learned(req.tenantId || tenant.id));
  });
  app.post('/api/plan/learn', requireAppAccess, learnLimiter, (req, res) => {
    const samples = sanitizeSamples(req.body && req.body.samples);
    if (!samples) return res.status(400).json({ error: 'invalid_samples', message: 'Ongeldige gegevens.' });
    const tid = req.tenantId || tenant.id;
    const user = identify(req);
    if (req.body.recognitionId) {
      // alleen bij een AI-herkenning van deze omgeving, en maar één keer
      if (!recognitions.addSamples(tid, req.body.recognitionId, samples)) return res.status(404).json({ error: 'not_found', message: 'Herkenning niet gevonden.' });
      return res.json({ ok: true });
    }
    if (req.body.planId) {
      // een goedgekeurd plan: alleen wie plannen mag goedkeuren
      if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
      if (!Roles.can(user, 'plannen.goedkeuren')) return res.status(403).json({ error: 'forbidden', message: 'Geen toegang.' });
      if (store.planReviewStatus(tid, req.body.planId) !== 'goedgekeurd') return res.status(404).json({ error: 'not_found', message: 'Geen goedgekeurd plan gevonden.' });
      recognitions.savePlanSamples({ tenantId: tid, userId: user.id, planId: String(req.body.planId), samples });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'invalid_samples', message: 'Ongeldige gegevens.' });
  });

  // Opslag van offertes, werkorders en webshop (ook gebruikt door de testdata).
  const quoteStore = createQuoteStore(database, { vault });
  const workOrderStore = createWorkOrderStore(database, { vault, staffRoles: (tid) => store.roles.keysWith(tid, 'uitvoerder') });
  const shopStore = createShopStore(database);
  const photoStore = createPhotoStore(database, { vault });
  // Uren en materiaalverbruik op werkorders; voorraadbeheer haakt in via workLogStore.hook().
  const workLogStore = createWorkLogStore(database);
  const dossierStore = createDossierStore(database, { photos: photoStore });
  const outsourcingStore = createOutsourcingStore(database, { workorders: workOrderStore });
  const newsStore = createNewsStore(database);
  const sprinklerStore = createSprinklerStore(database);
  const stockStore = createStockStore(database);
  // Prijs en voorraad in twee richtingen met de webshop (shop-sync.js); na een
  // wijziging gaan de gewijzigde artikelen enkele seconden later mee.
  const shopSync = createShopSync({ db: database, shop: shopStore, stock: stockStore, settingsFor: (id) => settingsFor(id), fetchImpl: shopFetch });
  stockStore.onDirty((tid) => shopSync.schedule(tid));
  const debtorStore = createDebtorStore(database);
  const invoiceStore = createInvoiceStore(database, { stock: stockStore, debtors: debtorStore });
  // Facturen per e-mail met PDF (invoice-mail.js) en webshopbestellingen als factuur (shop-orders.js).
  const invoiceSender = createInvoiceSender({
    invoices: invoiceStore, settingsFor: (id) => settingsFor(id), mailerFor, mailBody,
    colorsOf: (id) => {
      const cssVars = Theme.vars(themeFor(id));
      return { navy: cssVars['--at-navy'], green: cssVars['--at-green'], greenSoft: cssVars['--at-green-soft'], teal: cssVars['--at-teal'] };
    },
  });
  const shopOrders = createShopOrders({
    db: database, invoices: invoiceStore, debtors: debtorStore, stock: stockStore, sender: invoiceSender,
    settingsFor: (id) => settingsFor(id), fetchImpl: shopFetch,
  });
  // Definitieve facturen als verkoopfactuur naar Visma eAccounting (visma.js).
  const visma = createVisma({
    db: database, settingsFor: (id) => settingsFor(id), mainTenantId: tenant.id,
    debtors: debtorStore, invoices: invoiceStore, ...(vismaFetch ? { fetchImpl: vismaFetch } : {}),
  });
  invoiceStore.onFinalized((tid) => visma.schedule(tid));
  // Materiaalverbruik op de werkorder boekt de voorraad af, in dezelfde
  // transactie als de verbruiksregel (zie stock.syncUsage).
  workLogStore.hook((tid, row, user) => stockStore.syncUsage(tid, {
    usageId: row.id, workOrderId: row.work_order_id, code: row.code, qty: row.deleted ? 0 : row.qty, user,
  }, { nested: true }));
  const serviceRequestStore = createServiceRequestStore(database, { vault, workorders: workOrderStore, photos: photoStore });
  /**
   * Klant (of gast): ziet alleen berichten voor iedereen.
   * @param {object} req Het verzoek.
   * @param {object|null} user De gebruiker.
   * @returns {boolean} true voor een klant of gast.
   */
  const isCustomer = (req, user) => !user || user.kind === 'gast' || (!user.platform_admin && store.roles.get(req.tenantId || user.tenant_id, user.role)?.kind === 'klant');

  /**
   * Openbare links (offerte, afspraak): zonder inlog, dus de tenant volgt uit
   * de offerte of werkorder, en een uitgeschakelde tenant geeft niets prijs.
   * @param {string} id Id van de omgeving.
   * @returns {boolean} true als de omgeving en haar live-tenant aan staan.
   */
  const tenantActive = (id) => {
    const tenantRow = store.getTenant(id);
    const live = tenantRow && tenantRow.parent_id ? store.getTenant(tenantRow.parent_id) : tenantRow;
    return Boolean(tenantRow && !tenantRow.disabled && live && !live.disabled);
  };
  const publicLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 300, keyFn: remoteIp });

  // ---------- Tekening indienen zonder inloggen, plan ter controle, goedkeuren.
  registerDrawingRoutes(app, {
    store, identify, requireUser, requirePlans, requireRight, requireJson, audit, remoteIp, tenantActive, publicLimiter, planLimiter, mailerFor,
    settingsFor: (id) => settingsFor(id), canApprove: (user) => Roles.can(user, 'plannen.goedkeuren'),
  });

  // ---------- Offertes (module Offertes, zie quotes.js) ----------
  registerQuoteRoutes(app, {
    quotes: quoteStore, identify, requireUser, requireAdmin, requireRight, requireJson, audit,
    // Een offerte uit een plan alleen als dat plan is goedgekeurd.
    planReviewOf: (tenantId, planId) => store.planReviewStatus(tenantId, planId),
    tenantOf: (req) => req.tenantId || tenant.id, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    settingsForTenant: (id) => settingsFor(id), remoteIp, mailerFor, tenantActive, publicLimiter,
    themeOf: (id) => Theme.vars(themeFor(id)),
    // Klantaccounts horen bij de live-tenant (ook als er in test gewerkt
    // wordt); in een testomgeving komen de testklanten daarvan erbij.
    customersOf: (req) => {
      const tid = req.tenantId || tenant.id;
      const home = homeOf(tid);
      return store.listCustomers(home === tid ? [tid] : [home, tid]);
    },
  });

  // ---------- Werkorders (module Werkorders, zie workorders.js) ----------
  registerWorkOrderRoutes(app, {
    workorders: workOrderStore, requireRight, requireAdmin, requireJson, audit,
    settingsOf: (req) => settingsFor(req.tenantId || tenant.id), settingsForTenant: (id) => settingsFor(id),
    remoteIp, mailerFor, tenantActive, publicLimiter,
    themeOf: (id) => Theme.vars(themeFor(id)),
    photoCounts: (tid, ids) => photoStore.counts(tid, ids),
    loggedOf: (tid, ids) => workLogStore.counts(tid, ids),
    outsourcingOf: (tid) => outsourcingStore.marks(tid),
    // Voorraad: reserveren na elke wijziging, afboeken bij Gereed (zie stock.js).
    onChange: (tid, id, user) => stockStore.onWorkOrderChange(tid, id, user),
    // Medewerkers horen bij de live-tenant; in een testomgeving komen de
    // testaccounts daarvan erbij (net als bij de klantaccounts hierboven).
    staffTenantsOf: (req) => {
      const tid = req.tenantId || tenant.id;
      return [homeOf(tid), tid];
    },
  });

  // ---------- Voorraadbeheer: reserveren en afboeken op werkorders (zie stock.js) ----------
  registerStockRoutes(app, { stock: stockStore, requireRight, requireJson, audit, shopProductsOf: (tid) => shopStore.products(tid) });

  // ---------- Facturen en export naar de boekhouding (zie invoices.js) ----------
  registerInvoiceRoutes(app, {
    invoices: invoiceStore, requireRight, requireJson, audit,
    settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    loggedOf: (tid, woId) => workLogStore.list(tid, woId),
    articlesOf: (tid) => stockStore.saleInfo(tid),
    catalog: () => loadArticles(),
    sender: invoiceSender, shopOrders,
    mailConfigured: (req) => mailerFor(settingsFor(req.tenantId || tenant.id)).configured(),
    shopOf: (req) => settingsFor(req.tenantId || tenant.id).get('shopSource'),
    syncLimiter: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => req.tenantId || tenant.id }),
  });
  registerDebtorRoutes(app, { debtors: debtorStore, requireRight, requireJson, audit });

  // ---------- Opdrachten uitbesteden aan andere organisaties (zie outsourcing.js) ----------
  registerOutsourcingRoutes(app, {
    outsourcing: outsourcingStore, store, requireRight, requireJson, audit, mailerFor, tenantActive,
    settingsForTenant: (id) => settingsFor(id),
  });

  // ---------- Nieuws: berichten van de organisatie en wat is nieuw (zie news.js) ----------
  registerNewsRoutes(app, {
    news: newsStore, store, requireUser, requireRight, requireJson, audit, isCustomer, mailerFor,
    settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    staffTenantsOf: (req) => { const tid = req.tenantId || tenant.id; return [homeOf(tid), tid]; },
  });

  // ---------- Sproeierbibliotheek: eigen behuizingen en nozzles (zie sprinklers.js) ----------
  registerSprinklerRoutes(app, { sprinklers: sprinklerStore, requireUser, requireRight, requireJson, audit });

  // ---------- Uren en materiaalverbruik op werkorders (zie worklog.js) ----------
  registerWorkLogRoutes(app, {
    worklog: workLogStore, requireRight, requireJson, audit,
    canManage: (user) => Roles.can(user, 'planning'),
    staffOf: (req) => { const tid = req.tenantId || tenant.id; return workOrderStore.staff([homeOf(tid), tid]); },
  });

  // ---------- Foto's bij werkorders en klantdossiers (zie photos.js) ----------
  registerPhotoRoutes(app, { photos: photoStore, dossiers: dossierStore, requireRight, requireUser, requireJson, identify, audit });

  // ---------- Installatiedossier per locatie (zie locations.js) ----------
  registerLocationRoutes(app, { locations: createLocationStore(database, { photos: photoStore }), requireRight });

  // ---------- Klantportaal (module Portaal, zie portal.js) ----------
  const portalStore = createPortalStore(database);
  registerPortalRoutes(app, {
    portal: portalStore, store, quotes: quoteStore, workorders: workOrderStore, photos: photoStore, requests: serviceRequestStore,
    requireRight, requireJson, audit, remoteIp, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
  });

  // ---------- Meldingen: storing of onderhoud via het portaal (zie service-requests.js) ----------
  registerServiceRequestRoutes(app, {
    requests: serviceRequestStore, portal: portalStore, workorders: workOrderStore, requireRight, requireJson, audit,
    remoteIp, createRateLimiter, mailerFor, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    staffTenantsOf: (req) => { const tid = req.tenantId || tenant.id; return [homeOf(tid), tid]; },
  });

  // ---------- Webshopkoppeling (zie shop.js) ----------
  registerShopRoutes(app, {
    shop: shopStore, requireUser, requireJson, audit, fetchImpl: shopFetch,
    sync: (tid, user) => shopSync.run(tid, { full: true, user }),
    salePrices: (tid) => stockStore.saleInfo(tid),
    libraryCodes: (tid) => { const own = sprinklerStore.get(tid).own; return own ? [...own.bodies, ...own.nozzles].map((x) => x.code).filter(Boolean) : []; },
    tenantOf: (req) => req.tenantId || tenant.id, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    syncLimiter: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => req.tenantId || tenant.id }),
  });

  // Openbare vlaggen voor het dashboard en de modules (geen geheimen).
  app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    identify(req);
    res.json({ modules: settingsFor(req.tenantId).get('modules'), ai: Boolean(aiAvailable(req.tenantId)) });
  });

  // ---------- Hoofdbeheer: alle tenants en hun testomgevingen ----------
  /**
   * De live-tenant van een (test)omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {string} Id van de live-tenant.
   */
  function homeOf(tenantId) {
    const tenantRow = store.getTenant(tenantId);
    return tenantRow && tenantRow.environment === 'test' && tenantRow.parent_id ? tenantRow.parent_id : tenantId;
  }

  app.use('/api/platform', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requirePlatformAdmin);

  /**
   * Stuurt een fout uit het tenantbeheer terug.
   * @param {object} res Het antwoord.
   * @param {{ status?: number, error: string }} out De fout.
   * @returns {void}
   */
  const platformError = (res, out) => res.status(out.status || 400).json({ error: 'invalid_tenant', message: out.error });

  app.get('/api/platform/tenants', (req, res) => {
    res.json({ items: store.listTenants(), mainTenantId: tenant.id, current: req.tenantId });
  });

  // Nieuwe tenant, met optioneel meteen de eerste beheerder. Het account wordt
  // vooraf gecontroleerd; lukt het daarna toch niet, dan gaat de tenant weer weg.
  app.post('/api/platform/tenants', requireJson, wrap(async (req, res) => {
    const { name, slug, admin } = req.body || {};
    const withAdmin = Boolean(admin && (admin.username || admin.password));
    const account = withAdmin ? { username: String(admin.username || '').trim().toLowerCase(), displayName: admin.displayName, role: 'beheerder', password: admin.password } : null;
    if (account) {
      const problem = store.accountProblem(null, account);
      if (problem) return platformError(res, { error: `Eerste beheerder: ${problem}` });
    }
    const out = store.createTenant({ name, slug: String(slug || '').trim().toLowerCase() });
    if (out.error) return platformError(res, out);
    let user = null;
    if (account) {
      const acc = await store.createAccount(out.tenant.id, account, { mustChangePassword: admin.mustChangePassword !== false });
      if (acc.error) {
        store.dropEmptyTenant(out.tenant.id);
        return platformError(res, { error: `Eerste beheerder: ${acc.error}` });
      }
      user = acc.user;
    }
    console.log(`Tenant aangemaakt door ${req.user.display_name}: ${out.tenant.name} (${out.tenant.slug})`);
    audit(req, 'tenant_aangemaakt', { tenantId: out.tenant.id, slug: out.tenant.slug, admin: user ? user.username : null }, undefined, tenant.id);
    res.status(201).json({ tenant: store.tenantRow(out.tenant), admin: user ? store.publicUser(user) : null });
  }));

  app.patch('/api/platform/tenants/:id', requireJson, (req, res) => {
    const input = {};
    if (req.body?.name !== undefined) input.name = req.body.name;
    if (req.body?.disabled !== undefined) input.disabled = Boolean(req.body.disabled);
    const out = store.updateTenant(req.params.id, input);
    if (out.error) return platformError(res, out);
    if (input.disabled !== undefined) console.log(`Tenant ${out.tenant.name} ${input.disabled ? 'uitgeschakeld' : 'ingeschakeld'} door ${req.user.display_name}`);
    audit(req, 'tenant_gewijzigd', { tenantId: out.tenant.id, fields: Object.keys(input), ...(input.disabled !== undefined ? { disabled: input.disabled } : {}) }, undefined, tenant.id);
    res.json({ tenant: store.tenantRow(out.tenant) });
  });

  app.post('/api/platform/tenants/:id/environments', requireJson, (req, res) => {
    // Geheimen zijn versleuteld per tenant: die niet als ruwe rij kopiëren,
    // maar opnieuw opslaan via de instellingen van de nieuwe omgeving.
    const secrets = Object.keys(FIELDS).filter((key) => FIELDS[key].type === 'secret');
    const out = store.createEnvironment(req.params.id, { name: req.body?.name, copyPlans: Boolean(req.body?.copyPlans), skipSettings: secrets });
    if (out.error) return platformError(res, out);
    const from = settingsFor(req.params.id);
    const view = from.view();
    const patch = {};
    for (const key of secrets) if (view[key].source === 'instellingen' && from.get(key)) patch[key] = from.get(key);
    if (Object.keys(patch).length) settingsFor(out.tenant.id).update(patch, req.user.id);
    audit(req, 'testomgeving_aangemaakt', { tenantId: out.tenant.id, parentId: req.params.id, slug: out.tenant.slug, copied: out.copied }, undefined, tenant.id);
    console.log(`Testomgeving ${out.tenant.name} (${out.tenant.slug}) aangemaakt door ${req.user.display_name}, ${out.copied} plannen gekopieerd`);
    res.status(201).json({ tenant: store.tenantRow(out.tenant), copied: out.copied });
  });

  app.post('/api/platform/tenants/:id/reset', requireJson, (req, res) => {
    const out = store.resetEnvironment(req.params.id);
    if (out.error) return platformError(res, out);
    console.log(`Testomgeving ${out.tenant.name} leeggemaakt door ${req.user.display_name}`);
    audit(req, 'testomgeving_leeggemaakt', { tenantId: out.tenant.id }, undefined, tenant.id);
    res.json({ ok: true });
  });

  // Testomgeving of live-tenant verwijderen. Een live-tenant gaat weg met al
  // zijn gegevens, gebruikers en testomgevingen; ter bevestiging moet de
  // tenantcode (slug) worden meegestuurd als { confirm }.
  app.delete('/api/platform/tenants/:id', (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    if (tenantRow && tenantRow.environment === 'live') {
      if (tenantRow.id !== tenant.id && String(req.body?.confirm ?? req.query.confirm ?? '').trim().toLowerCase() !== tenantRow.slug) {
        return res.status(400).json({ error: 'confirm_required', message: `Typ ter bevestiging de tenantcode "${tenantRow.slug}" over.` });
      }
      const out = store.deleteTenant(tenantRow.id, tenant.id);
      if (out.error) return platformError(res, out);
      for (const id of out.ids) { settingsCache.delete(id); dailyCounts.delete(id); }
      console.log(`Tenant ${tenantRow.name} (${tenantRow.slug}) verwijderd door ${req.user.display_name}, met ${out.ids.length - 1} testomgeving(en)`);
      audit(req, 'tenant_verwijderd', { tenantId: tenantRow.id, slug: tenantRow.slug, name: tenantRow.name, environments: out.ids.length - 1, rows: out.counts }, undefined, tenant.id);
      return res.json({ ok: true, environments: out.ids.length - 1 });
    }
    const out = store.deleteEnvironment(req.params.id);
    if (out.error) return platformError(res, out);
    settingsCache.delete(req.params.id);
    dailyCounts.delete(req.params.id);
    console.log(`Testomgeving verwijderd door ${req.user.display_name}`);
    audit(req, 'testomgeving_verwijderd', { tenantId: req.params.id }, undefined, tenant.id);
    res.json({ ok: true });
  });

  // Kleurthema: standaard voor alle organisaties (hoofdtenant) en optioneel een
  // eigen thema per live-tenant. Leeg = huisstijl van AquaTech Service.
  app.get('/api/platform/theme', (req, res) => {
    const tenants = store.listTenants().filter((candidate) => candidate.id !== tenant.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name, slug: candidate.slug, theme: settingsFor(candidate.id).get('theme') }));
    res.json({ defaults: Theme.DEFAULTS, global: settings.get('theme'), mainTenantId: tenant.id, tenants });
  });

  app.put('/api/platform/theme', requireJson, (req, res) => {
    const targetId = req.body?.tenantId || tenant.id;
    const tenantRow = store.getTenant(targetId);
    if (!tenantRow || tenantRow.environment !== 'live') return res.status(404).json({ error: 'not_found', message: 'Organisatie niet gevonden (een testomgeving volgt het thema van zijn tenant).' });
    const raw = req.body?.colors;
    const target = settingsFor(targetId);
    if (raw == null || (typeof raw === 'object' && !Object.keys(raw).length)) {
      target.update({ reset: ['theme'] }, req.user.id);
    } else {
      if (typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'invalid_theme', message: 'Ongeldige kleuren.' });
      for (const [field, color] of Object.entries(raw)) {
        if (!Theme.FIELDS[field]) return res.status(400).json({ error: 'invalid_theme', field, message: `Onbekende kleur: ${field}` });
        if (!Theme.hex(color)) return res.status(400).json({ error: 'invalid_theme', field, message: `${Theme.FIELDS[field].label}: geef een kleur als #rrggbb.` });
      }
      const problem = Theme.problems(raw)[0];
      if (problem) return res.status(400).json({ error: 'invalid_theme', field: problem.field, message: problem.message });
      const colors = Theme.resolve(raw);
      if (targetId === tenant.id && Theme.isDefault(colors)) target.update({ reset: ['theme'] }, req.user.id);
      else target.update({ theme: colors }, req.user.id);
    }
    const theme = target.get('theme');
    console.log(`Kleurthema van ${tenantRow.name} gewijzigd door ${req.user.display_name}: ${Object.keys(theme).length ? Object.values(theme).join(' ') : 'standaard'}`);
    audit(req, 'thema_gewijzigd', { tenantId: targetId, theme }, undefined, tenant.id);
    res.json({ tenantId: targetId, theme });
  });

  // ---------- Visma eAccounting: koppeling per omgeving, app-registratie in Hoofdbeheer ----------
  // Na de /api/platform-controle, zodat /api/platform/visma alleen voor hoofdbeheerders is.
  registerVismaRoutes(app, {
    visma, requireRight, requireJson, audit, settingsFor: (id) => settingsFor(id), mainTenantId: tenant.id,
    syncLimiter: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => req.tenantId || tenant.id }),
  });

  // Testomgeving vullen met testdata: testaccounts per rol (één gedeeld,
  // willekeurig wachtwoord dat alleen in dit antwoord staat), nepklanten,
  // plannen en offertes. Wat er al in de testomgeving stond, gaat weg.
  app.post('/api/platform/tenants/:id/testdata', requireJson, wrap(async (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    if (!tenantRow) return platformError(res, { error: 'Omgeving niet gevonden.', status: 404 });
    if (tenantRow.environment !== 'test') return platformError(res, { error: 'Testdata kan alleen in een testomgeving.', status: 409 });
    const profile = settingsFor(tenantRow.id).get('quoteProfile');
    const testSet = testdata.buildTestData({ slug: tenantRow.slug, profile });
    let password = testdata.newPassword();
    while (testSet.accounts.some((account) => passwordProblem(password, account.username))) password = testdata.newPassword();
    const out = store.seedEnvironment(tenantRow.id, testSet, { passwordHash: await hashPassword(password), numberPrefix: profile.numberPrefix || 'OF-' });
    if (out.error) return platformError(res, out);
    // Klantlinks, reacties, werkorders en webshop via de echte opslaglogica.
    // De klantlink heeft het adres van de openbare pagina nodig; dat kent
    // alleen de browser (padprefix achter een proxy).
    const extra = testdata.seedFeatures(
      { db: database, quotes: quoteStore, workorders: workOrderStore, shop: shopStore, photos: photoStore, worklog: workLogStore, outsourcing: outsourcingStore, news: newsStore, aiUsage, recognitions, stock: stockStore, requests: serviceRequestStore, invoices: invoiceStore, sprinklers: sprinklerStore, settings: settingsFor(tenantRow.id) },
      testSet, { users: out.byKey, quoteIds: out.quoteIds, tenantId: tenantRow.id },
      { shareBase: validShareBase(req.body?.shareBase) },
    );
    const counts = { ...out.counts, ...extra };
    console.log(`Testomgeving ${tenantRow.name} gevuld met testdata door ${req.user.display_name}`);
    audit(req, 'testomgeving_gevuld', { tenantId: tenantRow.id, ...counts }, undefined, tenant.id);
    res.status(201).json({ accounts: out.users.map(store.publicUser), password, counts });
  }));

  /**
   * De tenant uit de URL voor gebruikersbeheer (accounts, zonder gasten; in een
   * testomgeving de testaccounts van die omgeving). Stuurt zelf 404.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De tenant, of null.
   */
  const userTenant = (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    if (!tenantRow) { res.status(404).json({ error: 'not_found', message: 'Tenant niet gevonden.' }); return null; }
    return tenantRow;
  };

  // Hoofdbeheerders wonen in de hoofdtenant: ze loggen in zonder organisatiecode.
  const HOOFD_ONLY = 'Hoofdbeheerders horen bij de hoofdtenant. Maak ze aan bij de gebruikers van de hoofdtenant.';

  app.get('/api/platform/tenants/:id/users', (req, res) => {
    const tenantRow = userTenant(req, res);
    // Met de supporttoestemming erbij (nodig om in live als de gebruiker te werken).
    if (!tenantRow) return;
    const users = store.listUsers(tenantRow.id, { includeGuests: false });
    const grants = impersonation.activeGrants(users.map((user) => user.id));
    res.json({ items: users.map((user) => ({ ...user, support: grants[user.id] || null })), roles: store.roles.list(tenantRow.id) });
  });

  app.post('/api/platform/tenants/:id/users', requireJson, wrap(async (req, res) => {
    const tenantRow = userTenant(req, res);
    if (!tenantRow) return;
    const { username, displayName, password } = req.body || {};
    const platformAdmin = Boolean(req.body?.platformAdmin);
    if (platformAdmin && tenantRow.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    const role = platformAdmin ? 'beheerder' : req.body?.role;
    const out = await store.createAccount(tenantRow.id, { username: String(username || '').trim().toLowerCase(), displayName, role, password },
      { platformAdmin, mustChangePassword: req.body?.mustChangePassword !== false });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    audit(req, 'gebruiker_aangemaakt', { userId: out.user.id, username: out.user.username, role: out.user.role, door: 'hoofdbeheer',
      ...(platformAdmin ? { hoofdbeheerder: true } : {}) }, undefined, tenantRow.id);
    res.status(201).json(store.publicUser(out.user));
  }));

  app.patch('/api/platform/tenants/:id/users/:uid', requireJson, wrap(async (req, res) => {
    const tenantRow = userTenant(req, res);
    if (!tenantRow) return;
    const input = {};
    for (const field of ['displayName', 'role', 'disabled', 'password']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    withMustChange(input, req.body);
    if (req.body?.platformAdmin !== undefined) {
      input.platformAdmin = Boolean(req.body.platformAdmin);
      if (input.platformAdmin && tenantRow.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    }
    const out = await store.updateAccount(tenantRow.id, req.params.uid, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    auditUserChange(req, out.user, input, tenantRow.id);
    res.json(store.publicUser(out.user));
  }));

  app.delete('/api/platform/tenants/:id/users/:uid', (req, res) => {
    const tenantRow = userTenant(req, res);
    if (tenantRow) deleteUser(req, res, tenantRow.id, req.params.uid, { door: 'hoofdbeheer' });
  });

  impersonation.register(app, { identify, requireJson, clearEnvironment, wrap });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  /**
   * Niet ingelogd: eerst het instelscherm zolang er geen beheerder is, anders
   * de inlogpagina (op elk pad, zodat een herlaad na het inloggen meteen de
   * gevraagde pagina toont). Alleen met gasten aan is de app zonder inloggen
   * bereikbaar.
   * @param {object} req Het verzoek.
   * @returns {string} Pad van de pagina.
   */
  const authPage = (req) => (!auth.isAuthenticated(req) && needsSetup() ? SETUP_PAGE : LOGIN_PAGE);

  app.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendAuthPage(res, authPage(req));
  });

  // Scripts, stylesheets, lettertypen en afbeeldingen (geen HTML, geen API).
  const STATIC_ASSET = /\.(js|css|png|jpe?g|svg|webp|gif|ico|woff2?|map|json|traineddata(\.gz)?|wasm)$/i;
  app.use((req, res, next) => {
    const asset = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/') && STATIC_ASSET.test(req.path);
    const authenticated = asset ? auth.isAuthenticatedForAsset(req) : auth.isAuthenticated(req);
    if (authenticated || (guestsAllowed() && !needsSetup()) || isPublicAsset(req) || isPublicPlanner(req)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).end();
    res.status(401);
    res.setHeader('Cache-Control', 'no-store');
    sendAuthPage(res, needsSetup() ? SETUP_PAGE : LOGIN_PAGE);
  });

  // Het actieve kleurthema als stylesheet (na brand.css op elke pagina). Ook
  // zonder inloggen bereikbaar: dan het thema van de hoofdtenant.
  app.get('/shared/theme.css', (req, res) => {
    identify(req);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('css').send(`/* Kleurthema (Hoofdbeheer > Kleuren). */\n${Theme.css(themeFor(req.tenantId))}`);
  });

  /**
   * Startpagina uit Mijn profiel (voorkeur startPage) als module-URL
   * ('planning/'), alleen als die module er voor deze gebruiker is. Het
   * dashboard krijgt hem mee in de pagina; shared/common.js gaat er de eerste
   * keer in een tabblad meteen heen, zonder het overzicht eerst op te bouwen.
   * @param {object} req Het verzoek.
   * @returns {string|null} De module-URL, of null.
   */
  function startPageOf(req) {
    const user = identify(req);
    if (!user || user.kind !== 'account' || user.impersonation) return null;
    const id = preferencesOf(user).startPage;
    const startModule = id && MODULES.find((candidate) => candidate.id === id && candidate.status === 'actief' && candidate.href);
    if (!startModule || !/^[a-z0-9-]+\/$/.test(startModule.href)) return null;
    const rights = Roles.rightsOf(user);
    if (startModule.right && ![].concat(startModule.right).some((right) => rights.includes(right))) return null;
    const off = settingsFor(req.tenantId).get('modules') || {};
    if (startModule.id !== 'beheer' && startModule.id !== 'hoofdbeheer' && off[startModule.id] === false) return null;
    return startModule.href;
  }

  // Eigen wachtwoord wijzigen (ingelogd met een account).
  app.get('/wachtwoord', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    identify(req);
    sendAuthPage(res, PASSWORD_PAGE, req.tenantId);
  });

  // no-cache: de browser controleert bij elke start of er een nieuwe versie is
  // (na een update meteen de nieuwe planner, zonder harde refresh).
  // redirect: false -- express zou `/beregening` absoluut doorsturen naar
  // `/beregening/`, wat achter een proxy met een padprefix buiten de app
  // uitkomt; dat doen we hieronder zelf, relatief.
  // Pagina's zelf (map met index.html of een .html-bestand) met geversioneerde
  // verwijzingen naar CSS en JS; overige bestanden via express.static.
  app.get(/(\/|\.html)$/, (req, res, next) => {
    const rel = req.path.endsWith('/') ? `${req.path}index.html` : req.path;
    const file = path.join(FRONTEND_DIR, rel);
    if (!file.startsWith(FRONTEND_DIR + path.sep)) return next();
    const start = rel === '/index.html' ? startPageOf(req) : null;
    const head = start ? `<meta name="aquatech-start" content="${start}">` : '';
    fs.stat(file, (err, st) => (err || !st.isFile() ? next() : sendPage(res, file, version, head)));
  });
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', redirect: false, setHeaders: staticHeaders(version) }));

  // Elke map in de frontend met een eigen index.html is een module van het
  // dashboard (zie frontend/dashboard/modules.js). De doorverwijzing naar de
  // module-URL met slash is relatief ("beregening/", niet "/beregening/"), zodat
  // de app ook onder een padprefix achter een reverse proxy werkt.
  app.get('*', (req, res) => {
    const segs = req.path.split('/').filter(Boolean);
    const mod = segs.length && isModule(segs[0]) ? segs[0] : null;
    if (mod && segs.length === 1 && !req.path.endsWith('/')) {
      const qs = req.originalUrl.slice(req.path.length);
      return res.redirect(302, `${mod}/${qs}`);
    }
    // Elk ander pad dat geen bestand is: de module zelf, of anders het dashboard.
    sendPage(res, path.join(FRONTEND_DIR, mod || '', 'index.html'), version);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Ongeldige JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Bestand te groot.' });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Interne fout' });
  });

  app.locals.settings = settings;
  /**
   * Is er al een beheerder met een eigen account?
   * @returns {boolean} true als het instelscherm niet meer nodig is.
   */
  app.locals.hasAdminAccount = () => !needsSetup();
  app.locals.setupCode = installCode;
  /**
   * Alle omgevingen: elke live-tenant met zijn testomgevingen.
   * @returns {object[]} De tenants.
   */
  const allEnvironments = () => store.listTenants().flatMap((live) => [live, ...live.environments]);
  /**
   * De ids van alle omgevingen.
   * @returns {string[]} De ids.
   */
  const allEnvironmentIds = () => allEnvironments().map((environment) => environment.id);
  /**
   * Onderhoud (elk uur vanuit main): bewaartermijnen toepassen, per tenant en
   * testomgeving met de eigen bewaartermijnen.
   * @returns {Object<string, number>} Aantal opgeruimde regels per soort.
   */
  app.locals.maintenance = () => {
    const total = {};
    for (const environment of allEnvironments()) {
      const environmentSettings = settingsFor(environment.id);
      const removed = store.applyRetention(environment.id, { ipDays: environmentSettings.get('ipRetentionDays'), auditDays: environmentSettings.get('auditRetentionDays') });
      removed.aiUsage = aiUsage.prune(environment.id, environmentSettings.get('auditRetentionDays'));
      for (const [kind, count] of Object.entries(removed)) total[kind] = (total[kind] || 0) + count;
    }
    return total;
  };
  /**
   * Webshop: alle omgevingen met terugschrijven aan (elke 10 minuten vanuit main).
   * @returns {Promise<*>} Uitkomst per omgeving.
   */
  app.locals.shopSyncAll = () => shopSync.runAll(allEnvironmentIds());
  app.locals.shopSync = shopSync;
  /**
   * Webshopbestellingen als factuur: alle omgevingen waar dat aan staat.
   * @returns {Promise<*>} Uitkomst per omgeving.
   */
  app.locals.shopOrdersAll = () => shopOrders.runAll(allEnvironmentIds());
  app.locals.shopOrders = shopOrders;
  /**
   * Visma: omgevingen met automatisch doorsturen aan (vangnet naast het doorsturen direct na definitief).
   * @returns {Promise<*>} Uitkomst per omgeving.
   */
  app.locals.vismaAll = () => visma.runAll(allEnvironmentIds());
  app.locals.visma = visma;
  /**
   * Automatische back-up als de nieuwste ouder is dan een dag.
   * @returns {Promise<object|null>} De back-up, of null als het niet nodig was.
   */
  app.locals.backupIfDue = async () => {
    if (!backupDir || settings.get('backupKeepDays') === 0) return null;
    const newest = backups.listBackups(backupDir)[0];
    if (newest && Date.now() - Date.parse(newest.createdAt) < 23 * 3600 * 1000) return null;
    return runBackup();
  };
  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dropPrivileges(dataDir);
  const secret = loadOrCreateSecret(dataDir);
  const master = loadOrCreateMasterKey(dataDir);
  console.log(`Hoofdsleutel voor versleuteling: ${master.source}`);
  const port = Number(process.env.PORT) || 3300;
  const db = openDatabase(dataDir);
  console.log(isPg(db) ? `Database: PostgreSQL (schema ${db.schema})` : 'Database: SQLite (aquatech.db in de datamap)');
  const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
  const app = createApp({ secret, db, env: process.env, vault: createVault(master.key), backupDir });
  const { settings } = app.locals;

  if (!app.locals.hasAdminAccount()) {
    console.log('Nog geen beheerder: open de app in de browser en maak het eerste beheerdersaccount aan.');
    if (!settings.get('accessCode')) console.log(`Installatiecode voor het eerste beheerdersaccount: ${app.locals.setupCode}`);
  }
  /**
   * Bewaartermijnen toepassen en zo nodig een back-up maken (elk uur).
   * @returns {void}
   */
  const runMaintenance = () => {
    try {
      const removed = app.locals.maintenance();
      const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
      if (total) console.log(`Bewaartermijnen toegepast: ${JSON.stringify(removed)}`);
    } catch (err) {
      console.error('Onderhoud mislukt:', err);
    }
    app.locals.backupIfDue()
      .then((backup) => { if (backup) console.log(`Versleutelde back-up gemaakt: ${backup.name} (${backup.size} bytes) in ${backupDir}`); })
      .catch((err) => console.error('Back-up mislukt:', err.message));
  };
  runMaintenance();
  setInterval(runMaintenance, 60 * 60 * 1000).unref();
  // Eerst prijs en voorraad, daarna de bestellingen (dan is de verkoop al afgeboekt).
  setInterval(() => app.locals.shopSyncAll()
    .catch((err) => console.error('Webshopsynchronisatie mislukt:', err.message))
    .then(() => app.locals.shopOrdersAll())
    .catch((err) => console.error('Webshopbestellingen ophalen mislukt:', err.message))
    .then(() => app.locals.vismaAll())
    .catch((err) => console.error('Doorsturen naar Visma mislukt:', err.message)), 10 * 60 * 1000).unref();
  if (!settings.get('anthropicApiKey')) console.log('Geen API-sleutel ingesteld: automatisch herkennen met AI staat uit (tekenen, lokale herkenning en de toverstaf werken wel).');

  const server = app.listen(port, () => {
    console.log(`Aquatech ${readVersion()} luistert op poort ${port}`);
  });
  // Netjes stoppen bij `docker stop` (SIGTERM) in plaats van na 10 s geforceerd.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close(() => {
        try { db.close(); } catch { /* al dicht */ }
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

/**
 * Draait de container als root, dan krijgt de gewone gebruiker `node` de
 * datamap en gaat het proces als die gebruiker verder: een lek in de app
 * geeft dan geen rootrechten in de container. RUN_AS_ROOT=1 slaat dit over.
 * @param {string} dataDir De datamap.
 * @returns {void}
 */
function dropPrivileges(dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.env.RUN_AS_ROOT === '1') return;
  const uid = Number(process.env.APP_UID) || 1000;
  const gid = Number(process.env.APP_GID) || 1000;
  try {
    /**
     * Geeft een bestand of map (met alles erin) aan de gewone gebruiker.
     * @param {string} target Pad van het bestand of de map.
     * @returns {void}
     */
    const walk = (target) => {
      fs.lchownSync(target, uid, gid);
      if (fs.lstatSync(target).isDirectory()) for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
    };
    walk(dataDir);
    fs.chmodSync(dataDir, 0o700);
    process.setgid(gid);
    process.setuid(uid);
    console.log(`Draait als gebruiker ${uid} (geen root).`);
  } catch (err) {
    console.warn(`Kon niet overschakelen naar een gewone gebruiker (${err.code || err.message}); draait als root.`);
  }
}

module.exports = { versionAssets, createApp, FRONTEND_DIR };
