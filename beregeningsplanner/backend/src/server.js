const path = require('path');
const fs = require('fs');
const express = require('express');

const { createAuth, remoteIp, parseCookies } = require('./auth');
const { createRateLimiter } = require('./rateLimit');
const { loadOrCreateSecret } = require('./options');
const { createPlanAnalyzer, AnalyzeError } = require('./planAnalyzer');
const { openDb, openDatabase, isPg } = require('./db');
const { createStore, hashPassword, passwordProblem, preferencesOf } = require('./store');
const testdata = require('./testdata');
const { createSettings, SettingsError, FIELDS } = require('./settings');
const { createVault, loadOrCreateMasterKey } = require('./vault');
const backups = require('./backup');
const { createQuoteStore, registerQuoteRoutes, validShareBase } = require('./quotes');
const { createMailer } = require('./mailer');
const { createWorkOrderStore, registerWorkOrderRoutes } = require('./workorders');
const { createPhotoStore, createDossierStore, registerPhotoRoutes } = require('./photos');
const { createImpersonationStore, createImpersonation } = require('./impersonation');
const { createShopStore, registerShopRoutes } = require('./shop');
const { createPortalStore, registerPortalRoutes } = require('./portal');
const crypto = require('crypto');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const SETUP_PAGE = path.join(__dirname, 'setup.html');
const PASSWORD_PAGE = path.join(__dirname, 'password.html');
const PKG = require('../package.json');

// De versie van de app staat in package.json.
const readVersion = () => PKG.version;

// Content-Security-Policy: alleen eigen scripts (plus de inline scripts van de
// inlog- en instelpagina, op hash), geen frames, geen plug-ins. WebAssembly
// (OCR) en workers/blobs (pdf.js, Tesseract, Excel-export) zijn nodig.
function inlineScriptHashes(files) {
  const out = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      out.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
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

// Eenmalige installatiecode voor het eerste beheerdersaccount (zonder
// toegangscode): staat alleen in het serverlog, zodat niet iedereen die als
// eerste de publieke URL opent het beheer kan overnemen.
function newSetupCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Zonder inloggen bereikbaar: de openbare offertepagina (klant via een link
// met token) en precies de bestanden die die pagina nodig heeft. Geen
// ../-trucs: het pad moet na decoderen en normaliseren hetzelfde blijven.
const PUBLIC_FILES = new Set([
  '/openbaar/offerte.html', '/openbaar/offerte.js', '/openbaar/offerte.css',
  '/openbaar/afspraak.html', '/openbaar/afspraak.js', '/openbaar/afspraak.css', '/werkorders/workorder-core.js',
  '/shared/brand.css', '/shared/theme.css', '/shared/theme.js', '/shared/logo-white.png',
  '/offertes/quote-core.js', '/offertes/quote-view.js', '/offertes/quote-view.css',
]);
function isPublicAsset(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p;
  try { p = decodeURIComponent(req.path); } catch { return false; }
  if (p !== path.posix.normalize(p) || p.includes('\\')) return false;
  return PUBLIC_FILES.has(p) || /^\/shared\/fonts\/montserrat-latin-\d{3}-normal\.woff2$/.test(p);
}

// Een module is een map direct onder frontend/ met een eigen index.html.
function isModule(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  try {
    return fs.statSync(path.join(FRONTEND_DIR, name, 'index.html')).isFile();
  } catch (err) {
    return false;
  }
}

// Pagina's krijgen de appversie achter elke lokale stylesheet en elk script
// (`css/app.css?v=<versie>`). Zo laadt een telefoon na een update gegarandeerd
// de nieuwe bestanden, ook als de browser of een proxy (Cloudflare) een oude
// versie in de cache heeft; zonder dit kreeg iOS de nieuwe HTML met oude CSS.
function versionAssets(html, version) {
  const v = encodeURIComponent(version);
  return html.replace(/(<(?:link|script)\b[^>]*?\b(?:href|src)=")([^"?#:]+\.(?:css|js))(")/g, `$1$2?v=${v}$3`);
}

function sendPage(res, file, version) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(versionAssets(html, version));
  });
}

// accessCode, anthropicApiKey en aiDailyLimit zijn alleen startwaarden (net als
// env); de actuele waarden komen uit de instellingen.
function createApp({ accessCode = '', secret, anthropicApiKey = '', aiDailyLimit, analyzer, db, env = {}, createAnalyzer = createPlanAnalyzer, vault = createVault(), setupCode, backupDir = null, mailerFor = (settings) => createMailer(settings), shopFetch }) {
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
  function settingsFor(tenantId) {
    let s = settingsCache.get(tenantId);
    if (!s) {
      const t = store.getTenant(tenantId);
      const own = tenantId === tenant.id || (t && t.parent_id === tenant.id);
      s = createSettings({ db: database, tenantId, env: own ? startEnv : {}, vault });
      settingsCache.set(tenantId, s);
    }
    return s;
  }
  const settings = settingsFor(tenant.id);
  // Kleurthema (shared/theme.js): het eigen thema van de live-tenant (ook voor
  // diens testomgevingen), anders het thema van de hoofdtenant voor iedereen.
  function themeFor(tenantId) {
    const home = tenantId ? homeOf(tenantId) : tenant.id;
    const own = home !== tenant.id ? settingsFor(home).get('theme') : {};
    return Object.keys(own).length ? own : settings.get('theme');
  }
  // Inlog-, instel- en wachtwoordpagina: alles inline (geen toegang tot
  // bestanden), dus het thema als <style> in de kop.
  const authHtml = new Map();
  function sendAuthPage(res, file, tenantId) {
    if (!authHtml.has(file)) authHtml.set(file, fs.readFileSync(file, 'utf8'));
    const css = Theme.css(themeFor(tenantId));
    const html = authHtml.get(file);
    res.type('html').send(css ? html.replace('</head>', `  <style>${css}</style>\n</head>`) : html);
  }
  const installCode = setupCode || env.SETUP_CODE || newSetupCode();
  const getAccessCode = () => settings.get('accessCode');
  // Gasten (zonder inloggen) alleen als dat aanstaat en er geen code is.
  const guestsAllowed = () => !getAccessCode() && settings.get('guestAccess');
  // Nog geen beheerder met een eigen account: eerst het instelscherm.
  const needsSetup = () => store.countAdmins(tenant.id) === 0;
  const auth = createAuth({ secret, store, tenantId: tenant.id, getAccessCode,
    idleDays: () => settings.get('sessionIdleDays'), maxDays: () => settings.get('sessionMaxDays') });
  // Standaard in het auditlog van de actieve omgeving (zonder inlog de hoofdtenant).
  // Werkt een hoofdbeheerder als deze gebruiker (impersonatie), dan staat diens
  // gebruikersnaam erbij.
  const audit = (req, action, detail = {}, userId, tenantId) => store.audit({ tenantId: tenantId || req.tenantId || tenant.id,
    userId: userId === undefined ? req.user?.id || null : userId, action,
    detail: req.user?.impersonator ? { ...detail, impersonatie: req.user.impersonator.username } : detail, ip: remoteIp(req) });
  const impersonation = createImpersonation({ store, imp: createImpersonationStore(database), auth, audit, mainTenantId: tenant.id });
  // Express 4 vangt geen afgewezen promises: doorgeven aan de foutafhandeling.
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // De AI-client volgt de API-sleutel uit de instellingen van de tenant (zonder herstart).
  const analyzers = new Map();
  function currentAnalyzer(tenantId = tenant.id) {
    if (analyzer) return analyzer;
    const key = settingsFor(tenantId).get('anthropicApiKey');
    let cached = analyzers.get(key);
    if (!cached) {
      cached = createAnalyzer({ apiKey: key });
      analyzers.set(key, cached);
    }
    return cached;
  }
  const aiAvailable = (tenantId = tenant.id) => settingsFor(tenantId).get('aiEnabled') && currentAnalyzer(tenantId).available;

  const app = express();

  app.disable('x-powered-by');
  // Modules roepen de API relatief aan ('api/...'), dus vanuit beregening/
  // komt dat binnen als /beregening/api/...: zelfde API, prefix eraf.
  app.use((req, res, next) => {
    const m = /^\/([a-z0-9][a-z0-9-]*)(\/api\/.*)$/.exec(req.url);
    if (m && isModule(m[1])) req.url = m[2];
    next();
  });
  // Grote limiet alleen voor de plananalyse (afbeelding als base64).
  app.use('/api/plan/analyze', express.json({ limit: '12mb' }));
  // Een plan bevat de achtergrondafbeelding (base64).
  app.use('/api/plans', express.json({ limit: '12mb' }));
  // Een offerte met veel regels en lange teksten past niet in 16 kB.
  app.use('/api/quotes', express.json({ limit: '1mb' }));
  // Akkoord via de openbare link: met handtekening (PNG).
  app.use('/api/public', express.json({ limit: '512kb' }));
  // Foto's bij een werkorder (base64, verkleind in de browser): vóór de 1 MB hieronder.
  app.use(/^\/api\/workorders\/[^/]+\/photos$/, express.json({ limit: '8mb' }));
  app.use('/api/workorders', express.json({ limit: '1mb' }));
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

  // Moet de gebruiker eerst zelf een nieuw wachtwoord kiezen (nieuw account of
  // reset door een beheerder), dan is alleen de wachtwoordpagina bereikbaar:
  // elke pagina toont die, de API weigert alles behalve wat die pagina nodig heeft.
  const PASSWORD_OPEN = /^\/api\/(me|health|auth\/[a-z]+|account\/password)$/;
  app.use((req, res, next) => {
    const s = auth.session(req);
    if (s?.via !== 'user' || !s.user.must_change_password || PASSWORD_OPEN.test(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'password_change_required', message: 'Kies eerst een nieuw wachtwoord.' });
    const page = !/\.[a-z0-9]+$/i.test(req.path) || req.path.endsWith('.html');
    if (!page || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    res.setHeader('Cache-Control', 'no-store');
    sendAuthPage(res, PASSWORD_PAGE, s.user.tenant_id);
  });

  // Inloggen: streng begrensd per IP (achter de tunnel is dat het
  // cloudflared-adres, dus effectief een globale grens -- prima voor een
  // handvol gebruikers, en precies wat raden van de code onmogelijk maakt).
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyFn: remoteIp });
  // Daarnaast per gebruikersnaam: na 10 mislukte pogingen in 15 minuten is dat
  // account 15 minuten geblokkeerd (ook als de pogingen van veel IP's komen).
  const failures = new Map();
  const LOCK_MS = 15 * 60 * 1000;
  const lockedOut = (name) => {
    const f = failures.get(name);
    if (f && f.reset <= Date.now()) failures.delete(name);
    return (failures.get(name)?.count || 0) >= 10;
  };
  const failed = (name) => {
    const f = failures.get(name);
    if (!f || f.reset <= Date.now()) failures.set(name, { count: 1, reset: Date.now() + LOCK_MS });
    else f.count += 1;
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
      if (!user && home?.id !== tenant.id) {
        const admin = await store.authenticate(tenant.id, username, password);
        if (admin?.platform_admin) { user = admin; home = tenant; }
      }
      if (!user) {
        failed(key);
        audit(req, 'inloggen_mislukt', { username, organisatie: orgCode }, null, home?.id);
        return res.status(401).json({ error: 'wrong_login', message: 'Onjuiste organisatiecode, gebruikersnaam of wachtwoord.' });
      }
      failures.delete(key);
      // Testaccounts horen bij een testomgeving van de organisatie.
      const own = store.getTenant(user.tenant_id);
      if ((home.disabled || own?.disabled) && !user.platform_admin) {
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
    if (!auth.checkCode(String(req.body?.code ?? req.body?.password ?? ''))) {
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
    const s = auth.session(req);
    if (s) audit(req, 'uitgelogd', {}, s.user?.id || s.row.user_id, s.row.tenant_id);
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
    if (getAccessCode() ? !auth.checkCode(code) : !auth.safeEqual(normCode(code), normCode(installCode))) {
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
  function identify(req) {
    if (req.user !== undefined) return req.user;
    const s = auth.session(req);
    let user = null;
    if (s?.via === 'code') user = store.systemUser(tenant.id, 'beheerder', 'Beheerder (toegangscode)');
    else if (s?.via === 'user') user = s.user;
    else if (guestsAllowed()) {
      const gid = auth.guestId(req);
      const g = gid && store.getUser(gid);
      user = g && g.kind === 'gast' && g.tenant_id === tenant.id && !g.disabled ? g : null;
    }
    if (user) {
      const home = store.getTenant(user.tenant_id);
      if (!home || (home.disabled && !user.platform_admin)) user = null;
    }
    if (user) {
      store.touchUser(user.id);
      // Een hoofdbeheerder kan tijdelijk als een andere gebruiker werken (zie impersonation.js).
      const as = s?.via === 'user' && user.platform_admin ? impersonation.resolve(req, user) : null;
      user = as || actingUser(req, user);
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

  function actingUser(req, user) {
    const base = { ...user, home_tenant_id: user.tenant_id };
    const raw = auth.readSigned(req, ENV_COOKIE, 'env');
    if (!raw) return base;
    const [uid, tid] = raw.split(':');
    if (uid !== user.id || !tid || tid === user.tenant_id) return base;
    if (!store.accessibleTenants(user).some((t) => t.id === tid)) return base;
    return { ...base, tenant_id: tid, role: user.platform_admin ? 'beheerder' : user.role };
  }

  // Alleen wissen wat er is (de sessie-cookie blijft zo de eerste Set-Cookie).
  // Toegankelijke omgevingen van een (werkende) gebruiker: op basis van het
  // account in de eigen tenant, niet van de omgeving waar die nu werkt.
  const accessibleFor = (user) => store.accessibleTenants({ ...user, tenant_id: user.home_tenant_id || user.tenant_id });

  function clearEnvironment(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[ENV_COOKIE]) auth.clearNamed(res, ENV_COOKIE);
    if (cookies[ENV_HINT]) auth.clearNamed(res, ENV_HINT);
  }

  function environmentInfo(t) {
    if (!t) return null;
    const parent = t.parent_id ? store.getTenant(t.parent_id) : null;
    return { ...store.tenantRow(t), parentName: parent ? parent.name : null };
  }


  const guestLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: remoteIp });
  function ensureUser(req, res) {
    const user = identify(req);
    if (user || !guestsAllowed()) return user;
    // De limiter roept next() direct aan, of beantwoordt zelf met 429.
    let allowed = false;
    guestLimiter(req, res, () => { allowed = true; });
    if (!allowed) return undefined;
    const guest = store.createGuest(tenant.id);
    auth.setGuestCookie(req, res, guest.id);
    req.user = guest;
    return guest;
  }

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
    werkorders: 'Alleen voor beheerders en installateurs.',
    portaal: 'Het klantportaal is er voor klanten.',
  };
  const requireRight = (right) => (req, res, next) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!Roles.can(user, right)) return res.status(403).json({ error: 'forbidden', message: FORBIDDEN[right] || 'Geen toegang.' });
    next();
  };
  const requireAdmin = requireRight('beheer');
  const requirePlatformAdmin = (req, res, next) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!user.platform_admin) return res.status(403).json({ error: 'forbidden', message: 'Alleen voor hoofdbeheerders.' });
    next();
  };
  // Schrijven alleen met JSON (geen cross-site formulieren).
  const requireJson = (req, res, next) => {
    if (req.is('application/json')) return next();
    res.status(415).json({ error: 'json_required', message: 'Verwacht JSON.' });
  };
  const ipOf = (req) => remoteIp(req);

  const loginCodeOf = (user) => {
    const t = user && store.getTenant(user.home_tenant_id || user.tenant_id);
    return !t || t.slug === 'default' ? '' : t.slug;
  };

  // ---------- Eigen wachtwoord wijzigen ----------
  // Met het huidige wachtwoord ter controle; daarna is de gebruiker op alle
  // andere toestellen uitgelogd en krijgt dit toestel een nieuwe sessie.
  app.post('/api/account/password', requireJson, wrap(async (req, res) => {
    const s = auth.session(req);
    if (s?.via !== 'user') return res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je wachtwoord te wijzigen.' });
    if (identify(req)?.impersonation) return res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' });
    const key = `wachtwoord:${s.user.id}`;
    if (lockedOut(key)) return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
    const out = await store.changeOwnPassword(s.user.id, String(req.body?.currentPassword ?? '').slice(0, 1024), String(req.body?.newPassword ?? '').slice(0, 1024));
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
  function profileOwner(req, res) {
    const s = auth.session(req);
    if (s?.via !== 'user') { res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je profiel te bekijken.' }); return null; }
    if (identify(req)?.impersonation) { res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' }); return null; }
    return s.user;
  }
  const profileOf = (u) => ({ user: store.publicUser(u), preferences: preferencesOf(u) });

  app.get('/api/account/profile', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const u = profileOwner(req, res);
    if (u) res.json(profileOf(store.getUser(u.id)));
  });

  app.put('/api/account/profile', requireJson, (req, res) => {
    const u = profileOwner(req, res);
    if (!u) return;
    const input = {};
    for (const k of ['displayName', 'email', 'phone', 'preferences']) if (req.body?.[k] !== undefined) input[k] = req.body[k];
    const out = store.updateProfile(u.id, input);
    if (out.error) return res.status(400).json({ error: 'invalid_profile', field: out.field, message: out.error });
    // Welke velden, nooit de waarden (persoonsgegevens horen niet in het logboek).
    audit(req, 'profiel_gewijzigd', { velden: Object.keys(input) }, u.id, u.tenant_id);
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
      rights: user ? Roles.rightsOf(user) : guestsAllowed() ? Roles.rightsOf({ role: 'klant' }) : [],
      // Tijdens een impersonatie wordt er niet gewisseld (eerst terug naar het eigen account).
      environments: user && !imp ? accessibleFor(user).length : 0,
      impersonation: imp ? { by: user.impersonator.display_name, expiresAt: imp.expiresAt, live: imp.live, environment: imp.tenantName } : null,

      // Staan gasten aan, dan werkt iedereen zonder inloggen als (nieuwe) gast.
      guest: !user && guestsAllowed(),
      accessCodeConfigured: Boolean(getAccessCode()),
      setupRequired: needsSetup(),
    });
  });

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
    const tid = String(req.body?.tenantId || '');
    const target = accessibleFor(user).find((t) => t.id === tid);
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
  const validPlan = (data) => data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.areas);

  // Eigen plannen; beheerders en installateurs met ?all=1 alle plannen van
  // de organisatie (zonder historie: die is alleen voor beheerders).
  app.get('/api/plans', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.json({ items: [] });
    const all = req.query.all === '1' && Roles.can(user, 'plannen.alle');
    res.json({ items: store.listPlans(req.tenantId, { ownerId: all ? null : user.id }) });
  });

  app.get('/api/plans/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    // Alleen de eigenaar (of beheerder/installateur); anders 404, zodat niet te zien is
    // of een plan van iemand anders bestaat.
    const plan = user && store.getPlan(user, req.params.id);
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  app.post('/api/plans', requireJson, requireUser, planLimiter, (req, res) => {
    const data = req.body?.data;
    if (!validPlan(data)) return res.status(400).json({ error: 'invalid_plan', message: 'Ongeldig plan.' });
    res.status(201).json(store.savePlan(req.user, null, data, ipOf(req)));
  });

  app.put('/api/plans/:id', requireJson, requireUser, planLimiter, (req, res) => {
    const data = req.body?.data;
    if (!validPlan(data)) return res.status(400).json({ error: 'invalid_plan', message: 'Ongeldig plan.' });
    const plan = store.savePlan(req.user, req.params.id, data, ipOf(req));
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  app.delete('/api/plans/:id', (req, res) => {
    const user = identify(req);
    if (!user || !store.deletePlan(user, req.params.id, ipOf(req))) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json({ ok: true });
  });

  // ---------- Beheer: historie, alle plannen, gebruikers ----------
  app.use('/api/admin', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requireAdmin);

  app.get('/api/admin/history', (req, res) => {
    const { limit, offset, user, q, action } = req.query;
    res.json(store.listHistory(req.tenantId, { limit, offset, userId: user, search: q, action }));
  });

  app.get('/api/admin/history/:id', (req, res) => {
    const h = store.getHistory(req.tenantId, req.params.id);
    if (!h) return res.status(404).json({ error: 'not_found', message: 'Niet gevonden.' });
    res.json(h);
  });

  app.get('/api/admin/plans', (req, res) => {
    res.json({ items: store.listPlans(req.tenantId, {
      ownerId: req.query.owner ? String(req.query.owner) : null,
      includeDeleted: req.query.deleted === '1',
      withHistory: true,
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

  // Gebruikers horen bij de live-tenant; in een testomgeving dezelfde lijst.
  // Testaccounts (zie testdata.js) horen bij de testomgeving zelf en beheren
  // alleen de gebruikers daarvan, nooit die van live.
  const usersTenantOf = (req) => (req.user && req.user.home_tenant_id === req.tenantId ? req.tenantId : homeOf(req.tenantId));

  // Een hoofdbeheerder kan alleen door een (andere) hoofdbeheerder worden
  // gewijzigd, uitgeschakeld of uitgelogd, niet door een beheerder van de tenant.
  function guardPlatformAdmin(req, res, userId) {
    const target = store.getUser(userId);
    if (!target || !target.platform_admin || req.user.platform_admin) return false;
    res.status(403).json({ error: 'forbidden', message: 'Alleen een hoofdbeheerder kan een hoofdbeheerder wijzigen.' });
    return true;
  }

  app.get('/api/admin/users', (req, res) => {
    res.json({ items: store.listUsers(usersTenantOf(req)) });
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
    for (const k of ['displayName', 'role', 'disabled', 'password', 'username']) if (req.body?.[k] !== undefined) input[k] = req.body[k];
    withMustChange(input, req.body);
    const home = usersTenantOf(req);
    if (guardPlatformAdmin(req, res, req.params.id)) return;
    const out = await store.updateAccount(home, req.params.id, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    auditUserChange(req, out.user, input, home);
    res.json(store.publicUser(out.user));
  }));

  // Wachtwoord wijzigen na de eerste aanmelding: aan/uit te zetten, en standaard
  // aan als een beheerder een nieuw wachtwoord instelt.
  function withMustChange(input, body) {
    if (body?.mustChangePassword !== undefined) input.mustChangePassword = Boolean(body.mustChangePassword);
    else if (input.password !== undefined) input.mustChangePassword = true;
    return input;
  }

  // Welke velden, nooit de waarden van een wachtwoord.
  function auditUserChange(req, user, input, tenantId) {
    audit(req, 'gebruiker_gewijzigd', { userId: user.id, username: user.username, fields: Object.keys(input),
      ...(input.role !== undefined ? { role: input.role } : {}), ...(input.disabled !== undefined ? { disabled: Boolean(input.disabled) } : {}),
      ...(input.platformAdmin !== undefined ? { hoofdbeheerder: Boolean(input.platformAdmin) } : {}),
      ...(input.mustChangePassword !== undefined ? { wachtwoordWijzigen: input.mustChangePassword } : {}) }, undefined, tenantId);
  }

  // Gebruiker op alle toestellen uitloggen.
  app.post('/api/admin/users/:id/logout', (req, res) => {
    const home = usersTenantOf(req);
    const u = store.getUser(req.params.id);
    if (!u || u.tenant_id !== home) return res.status(404).json({ error: 'not_found', message: 'Gebruiker niet gevonden.' });
    if (guardPlatformAdmin(req, res, u.id)) return;
    const n = store.revokeSessions(home, u.id);
    audit(req, 'sessies_ingetrokken', { userId: u.id, username: u.username, count: n }, undefined, home);
    res.json({ ok: true, revoked: n });
  });

  // Gebruiker definitief verwijderen. Niet jezelf (dan zit je zonder account),
  // en een hoofdbeheerder alleen door een andere hoofdbeheerder.
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
    const u = req.user;
    if (u.platform_admin || (u.kind === 'systeem' && req.tenantId === tenant.id)) return next();
    res.status(403).json({ error: 'forbidden', message: 'Alleen voor hoofdbeheerders.' });
  });
  let backupRunning = null;
  async function runBackup(req = null) {
    if (!backupDir) throw Object.assign(new Error('Back-ups zijn niet ingesteld.'), { status: 501 });
    if (backupRunning) return backupRunning;
    backupRunning = (async () => {
      try {
        const b = await backups.createBackup({ db: database, dir: backupDir, vault });
        backups.pruneBackups(backupDir, Math.max(1, settings.get('backupKeepDays')));
        if (req) audit(req, 'backup_gemaakt', { name: b.name, size: b.size }, undefined, tenant.id);
        else store.audit({ tenantId: tenant.id, action: 'backup_gemaakt', detail: { name: b.name, size: b.size, automatisch: true } });
        return b;
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
    res.json({ settings: settingsFor(req.tenantId).view(), via: auth.session(req)?.via || null });
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
    const platformField = [...Object.keys(patch), ...resets].find((k) => FIELDS[k]?.platform);
    if (platformField) return res.status(400).json({ error: 'invalid_setting', field: platformField, message: 'Deze instelling wijzig je in Hoofdbeheer.' });
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
    const a = currentAnalyzer(req.tenantId);
    if (!a.check) return res.status(501).json({ error: 'not_supported', message: 'Testen is niet beschikbaar.' });
    try {
      res.json(await a.check());
    } catch (err) {
      if (err instanceof AnalyzeError) return res.status(err.status === 502 ? 400 : err.status).json({ error: err.code, message: err.message });
      next(err);
    }
  });

  // Automatisch herkennen van een plan. De URL is (zonder toegangscode)
  // openbaar, dus elke aanroep kost tegoed: per IP begrensd plus een
  // dagelijks maximum voor de hele app (beide in Beheer > Instellingen).
  // Limieten en dagteller per tenant (omgeving).
  const analyzeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: (req) => settingsFor(req.tenantId || tenant.id).get('aiHourlyPerIp'), keyFn: (req) => `${req.tenantId || tenant.id}|${remoteIp(req)}` });
  const dailyCounts = new Map();
  const today = () => new Date().toISOString().slice(0, 10);
  function dailyFor(tenantId) {
    let d = dailyCounts.get(tenantId);
    if (!d || d.day !== today()) {
      d = { day: today(), count: 0 };
      dailyCounts.set(tenantId, d);
    }
    return d;
  }
  const requireAppAccess = (req, res, next) => {
    identify(req);
    if (guestsAllowed() || auth.isAuthenticated(req)) return next();
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
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    const w = Number(width), h = Number(height);
    if (!m || !(w > 0 && h > 0 && w <= 8000 && h <= 8000)) {
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
    const daily = dailyFor(req.tenantId);
    if (daily.count >= settings.get('aiDailyLimit')) {
      return res.status(429).json({ error: 'daily_limit', message: 'Het dagelijkse maximum voor automatisch herkennen is bereikt. Probeer het morgen opnieuw of teken het plan zelf.' });
    }
    daily.count += 1;
    try {
      const result = await planAnalyzer.analyze({ mediaType: m[1], data: m[2], width: w, height: h });
      console.log(`Plan geanalyseerd: ${result.areas.length} vlakken, schaal ${result.scale.method || '-'} (${result.scale.confidence || '-'})`);
      const user = identify(req) || (guestsAllowed() ? ensureUser(req, res) : null);
      if (res.headersSent) return;
      if (user) {
        store.record({ tenantId: req.tenantId, userId: user.id, action: 'analyse', title: 'Plan herkend',
          summary: { areas: result.areas.length, elements: (result.elements || []).length, scale: result.scale.method || null, confidence: result.scale.confidence || null }, ip: ipOf(req) });
      }
      res.json(result);
    } catch (err) {
      if (err instanceof AnalyzeError) {
        console.warn(`Plananalyse mislukt: ${err.code} – ${err.message}`);
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  });

  // Opslag van offertes, werkorders en webshop (ook gebruikt door de testdata).
  const quoteStore = createQuoteStore(database, { vault });
  const workOrderStore = createWorkOrderStore(database, { vault });
  const shopStore = createShopStore(database);
  const photoStore = createPhotoStore(database, { vault });
  const dossierStore = createDossierStore(database, { photos: photoStore });

  // Openbare links (offerte, afspraak): zonder inlog, dus de tenant volgt uit
  // de offerte of werkorder, en een uitgeschakelde tenant geeft niets prijs.
  const tenantActive = (id) => {
    const t = store.getTenant(id);
    const live = t && t.parent_id ? store.getTenant(t.parent_id) : t;
    return Boolean(t && !t.disabled && live && !live.disabled);
  };
  const publicLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 300, keyFn: remoteIp });

  // ---------- Offertes (module Offertes, zie quotes.js) ----------
  registerQuoteRoutes(app, {
    quotes: quoteStore, identify, requireUser, requireAdmin, requireRight, requireJson, audit,
    tenantOf: (req) => req.tenantId || tenant.id, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
    settingsForTenant: (id) => settingsFor(id), remoteIp, mailerFor, tenantActive, publicLimiter,
    themeOf: (id) => Theme.vars(themeFor(id)),
    // Klantaccounts horen bij de live-tenant (ook als er in test gewerkt
    // wordt); in een testomgeving komen de testklanten daarvan erbij.
    customersOf: (req) => {
      const tid = req.tenantId || tenant.id;
      const home = homeOf(tid);
      return home === tid ? store.listCustomers(tid) : [...store.listCustomers(home), ...store.listCustomers(tid)];
    },
  });

  // ---------- Werkorders (module Werkorders, zie workorders.js) ----------
  registerWorkOrderRoutes(app, {
    workorders: workOrderStore, requireRight, requireAdmin, requireJson, audit,
    settingsOf: (req) => settingsFor(req.tenantId || tenant.id), settingsForTenant: (id) => settingsFor(id),
    remoteIp, mailerFor, tenantActive, publicLimiter,
    themeOf: (id) => Theme.vars(themeFor(id)),
    photoCounts: (tid) => photoStore.counts(tid),
    // Medewerkers horen bij de live-tenant; in een testomgeving komen de
    // testaccounts daarvan erbij (net als bij de klantaccounts hierboven).
    staffTenantsOf: (req) => {
      const tid = req.tenantId || tenant.id;
      return [homeOf(tid), tid];
    },
  });

  // ---------- Foto's bij werkorders en klantdossiers (zie photos.js) ----------
  registerPhotoRoutes(app, { photos: photoStore, dossiers: dossierStore, requireRight, requireUser, requireJson, identify, audit });

  // ---------- Klantportaal (module Portaal, zie portal.js) ----------
  registerPortalRoutes(app, {
    portal: createPortalStore(database), store, quotes: quoteStore, workorders: workOrderStore, photos: photoStore,
    requireRight, requireJson, audit, remoteIp, settingsOf: (req) => settingsFor(req.tenantId || tenant.id),
  });

  // ---------- Webshopkoppeling (zie shop.js) ----------
  registerShopRoutes(app, {
    shop: shopStore, requireUser, requireJson, audit, fetchImpl: shopFetch,
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
  // De live-tenant van een (test)omgeving.
  function homeOf(tenantId) {
    const t = store.getTenant(tenantId);
    return t && t.environment === 'test' && t.parent_id ? t.parent_id : tenantId;
  }

  app.use('/api/platform', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requirePlatformAdmin);

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
    const secrets = Object.keys(FIELDS).filter((k) => FIELDS[k].type === 'secret');
    const out = store.createEnvironment(req.params.id, { name: req.body?.name, copyPlans: Boolean(req.body?.copyPlans), skipSettings: secrets });
    if (out.error) return platformError(res, out);
    const from = settingsFor(req.params.id);
    const view = from.view();
    const patch = {};
    for (const k of secrets) if (view[k].source === 'instellingen' && from.get(k)) patch[k] = from.get(k);
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
    const t = store.getTenant(req.params.id);
    if (t && t.environment === 'live') {
      if (t.id !== tenant.id && String(req.body?.confirm ?? req.query.confirm ?? '').trim().toLowerCase() !== t.slug) {
        return res.status(400).json({ error: 'confirm_required', message: `Typ ter bevestiging de tenantcode "${t.slug}" over.` });
      }
      const out = store.deleteTenant(t.id, tenant.id);
      if (out.error) return platformError(res, out);
      for (const id of out.ids) { settingsCache.delete(id); dailyCounts.delete(id); }
      console.log(`Tenant ${t.name} (${t.slug}) verwijderd door ${req.user.display_name}, met ${out.ids.length - 1} testomgeving(en)`);
      audit(req, 'tenant_verwijderd', { tenantId: t.id, slug: t.slug, name: t.name, environments: out.ids.length - 1, rows: out.counts }, undefined, tenant.id);
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

  // Testomgeving vullen met testdata: testaccounts per rol (één gedeeld,
  // willekeurig wachtwoord dat alleen in dit antwoord staat), nepklanten,
  // plannen en offertes. Wat er al in de testomgeving stond, gaat weg.
  // Kleurthema: standaard voor alle organisaties (hoofdtenant) en optioneel een
  // eigen thema per live-tenant. Leeg = huisstijl van AquaTech Service.
  app.get('/api/platform/theme', (req, res) => {
    const tenants = store.listTenants().filter((t) => t.id !== tenant.id)
      .map((t) => ({ id: t.id, name: t.name, slug: t.slug, theme: settingsFor(t.id).get('theme') }));
    res.json({ defaults: Theme.DEFAULTS, global: settings.get('theme'), mainTenantId: tenant.id, tenants });
  });

  app.put('/api/platform/theme', requireJson, (req, res) => {
    const tid = req.body?.tenantId || tenant.id;
    const t = store.getTenant(tid);
    if (!t || t.environment !== 'live') return res.status(404).json({ error: 'not_found', message: 'Organisatie niet gevonden (een testomgeving volgt het thema van zijn tenant).' });
    const raw = req.body?.colors;
    const target = settingsFor(tid);
    if (raw == null || (typeof raw === 'object' && !Object.keys(raw).length)) {
      target.update({ reset: ['theme'] }, req.user.id);
    } else {
      if (typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'invalid_theme', message: 'Ongeldige kleuren.' });
      for (const [k, v] of Object.entries(raw)) {
        if (!Theme.FIELDS[k]) return res.status(400).json({ error: 'invalid_theme', field: k, message: `Onbekende kleur: ${k}` });
        if (!Theme.hex(v)) return res.status(400).json({ error: 'invalid_theme', field: k, message: `${Theme.FIELDS[k].label}: geef een kleur als #rrggbb.` });
      }
      const problem = Theme.problems(raw)[0];
      if (problem) return res.status(400).json({ error: 'invalid_theme', field: problem.field, message: problem.message });
      const colors = Theme.resolve(raw);
      if (tid === tenant.id && Theme.isDefault(colors)) target.update({ reset: ['theme'] }, req.user.id);
      else target.update({ theme: colors }, req.user.id);
    }
    const theme = target.get('theme');
    console.log(`Kleurthema van ${t.name} gewijzigd door ${req.user.display_name}: ${Object.keys(theme).length ? Object.values(theme).join(' ') : 'standaard'}`);
    audit(req, 'thema_gewijzigd', { tenantId: tid, theme }, undefined, tenant.id);
    res.json({ tenantId: tid, theme });
  });

  app.post('/api/platform/tenants/:id/testdata', requireJson, wrap(async (req, res) => {
    const t = store.getTenant(req.params.id);
    if (!t) return platformError(res, { error: 'Omgeving niet gevonden.', status: 404 });
    if (t.environment !== 'test') return platformError(res, { error: 'Testdata kan alleen in een testomgeving.', status: 409 });
    const profile = settingsFor(t.id).get('quoteProfile');
    const set = testdata.buildTestData({ slug: t.slug, profile });
    let password = testdata.newPassword();
    while (set.accounts.some((a) => passwordProblem(password, a.username))) password = testdata.newPassword();
    const out = store.seedEnvironment(t.id, set, { passwordHash: await hashPassword(password), numberPrefix: profile.numberPrefix || 'OF-' });
    if (out.error) return platformError(res, out);
    // Klantlinks, reacties, werkorders en webshop via de echte opslaglogica.
    // De klantlink heeft het adres van de openbare pagina nodig; dat kent
    // alleen de browser (padprefix achter een proxy).
    const extra = testdata.seedFeatures(
      { db: database, quotes: quoteStore, workorders: workOrderStore, shop: shopStore, photos: photoStore, settings: settingsFor(t.id) },
      set, { users: out.byKey, quoteIds: out.quoteIds, tenantId: t.id },
      { shareBase: validShareBase(req.body?.shareBase) },
    );
    const counts = { ...out.counts, ...extra };
    console.log(`Testomgeving ${t.name} gevuld met testdata door ${req.user.display_name}`);
    audit(req, 'testomgeving_gevuld', { tenantId: t.id, ...counts }, undefined, tenant.id);
    res.status(201).json({ accounts: out.users.map(store.publicUser), password, counts });
  }));

  // Gebruikers van een tenant (accounts, zonder gasten) beheren. In een
  // testomgeving zijn dat de testaccounts van die omgeving.
  const userTenant = (req, res) => {
    const t = store.getTenant(req.params.id);
    if (!t) { res.status(404).json({ error: 'not_found', message: 'Tenant niet gevonden.' }); return null; }
    return t;
  };

  // Hoofdbeheerders wonen in de hoofdtenant: ze loggen in zonder organisatiecode.
  const HOOFD_ONLY = 'Hoofdbeheerders horen bij de hoofdtenant. Maak ze aan bij de gebruikers van de hoofdtenant.';

  app.get('/api/platform/tenants/:id/users', (req, res) => {
    const t = userTenant(req, res);
    // Met de supporttoestemming erbij (nodig om in live als de gebruiker te werken).
    if (t) res.json({ items: store.listUsers(t.id, { includeGuests: false }).map((u) => ({ ...u, support: impersonation.activeGrant(u.id) })) });
  });

  app.post('/api/platform/tenants/:id/users', requireJson, wrap(async (req, res) => {
    const t = userTenant(req, res);
    if (!t) return;
    const { username, displayName, password } = req.body || {};
    const platformAdmin = Boolean(req.body?.platformAdmin);
    if (platformAdmin && t.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    const role = platformAdmin ? 'beheerder' : req.body?.role;
    const out = await store.createAccount(t.id, { username: String(username || '').trim().toLowerCase(), displayName, role, password },
      { platformAdmin, mustChangePassword: req.body?.mustChangePassword !== false });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    audit(req, 'gebruiker_aangemaakt', { userId: out.user.id, username: out.user.username, role: out.user.role, door: 'hoofdbeheer',
      ...(platformAdmin ? { hoofdbeheerder: true } : {}) }, undefined, t.id);
    res.status(201).json(store.publicUser(out.user));
  }));

  app.patch('/api/platform/tenants/:id/users/:uid', requireJson, wrap(async (req, res) => {
    const t = userTenant(req, res);
    if (!t) return;
    const input = {};
    for (const k of ['displayName', 'role', 'disabled', 'password']) if (req.body?.[k] !== undefined) input[k] = req.body[k];
    withMustChange(input, req.body);
    if (req.body?.platformAdmin !== undefined) {
      input.platformAdmin = Boolean(req.body.platformAdmin);
      if (input.platformAdmin && t.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    }
    const out = await store.updateAccount(t.id, req.params.uid, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    auditUserChange(req, out.user, input, t.id);
    res.json(store.publicUser(out.user));
  }));

  app.delete('/api/platform/tenants/:id/users/:uid', (req, res) => {
    const t = userTenant(req, res);
    if (t) deleteUser(req, res, t.id, req.params.uid, { door: 'hoofdbeheer' });
  });

  impersonation.register(app, { identify, requireJson, clearEnvironment, wrap });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // Niet ingelogd: eerst het instelscherm zolang er geen beheerder is, anders
  // de inlogpagina (op elk pad, zodat een herlaad na het inloggen meteen de
  // gevraagde pagina toont). Alleen met gasten aan is de app zonder inloggen
  // bereikbaar.
  const authPage = (req) => (!auth.isAuthenticated(req) && needsSetup() ? SETUP_PAGE : LOGIN_PAGE);

  app.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendAuthPage(res, authPage(req));
  });

  app.use((req, res, next) => {
    const authenticated = auth.isAuthenticated(req);
    if (authenticated || (guestsAllowed() && !needsSetup()) || isPublicAsset(req)) return next();
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
    fs.stat(file, (err, st) => (err || !st.isFile() ? next() : sendPage(res, file, version)));
  });
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', redirect: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

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
  app.locals.hasAdminAccount = () => !needsSetup();
  app.locals.setupCode = installCode;
  // Onderhoud (elk uur vanuit main): bewaartermijnen toepassen.
  // Per tenant en testomgeving, met de eigen bewaartermijnen.
  app.locals.maintenance = () => {
    const total = {};
    for (const t of store.listTenants().flatMap((l) => [l, ...l.environments])) {
      const s = settingsFor(t.id);
      const r = store.applyRetention(t.id, { ipDays: s.get('ipRetentionDays'), auditDays: s.get('auditRetentionDays') });
      for (const [k, v] of Object.entries(r)) total[k] = (total[k] || 0) + v;
    }
    return total;
  };
  // Automatische back-up als de nieuwste ouder is dan een dag.
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
  const runMaintenance = () => {
    try {
      const r = app.locals.maintenance();
      const n = Object.values(r).reduce((a, b) => a + b, 0);
      if (n) console.log(`Bewaartermijnen toegepast: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('Onderhoud mislukt:', err);
    }
    app.locals.backupIfDue()
      .then((b) => { if (b) console.log(`Versleutelde back-up gemaakt: ${b.name} (${b.size} bytes) in ${backupDir}`); })
      .catch((err) => console.error('Back-up mislukt:', err.message));
  };
  runMaintenance();
  setInterval(runMaintenance, 60 * 60 * 1000).unref();
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

// Draait de container als root, dan krijgt de gewone gebruiker `node` de
// datamap en gaat het proces als die gebruiker verder: een lek in de app
// geeft dan geen rootrechten in de container. RUN_AS_ROOT=1 slaat dit over.
function dropPrivileges(dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.env.RUN_AS_ROOT === '1') return;
  const uid = Number(process.env.APP_UID) || 1000;
  const gid = Number(process.env.APP_GID) || 1000;
  try {
    const walk = (p) => {
      fs.lchownSync(p, uid, gid);
      if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
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
