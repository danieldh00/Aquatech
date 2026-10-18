const path = require('path');
const fs = require('fs');
const express = require('express');

const { createAuth, remoteIp } = require('./auth');
const { createRateLimiter } = require('./rateLimit');
const { loadOrCreateSecret } = require('./options');
const { createPlanAnalyzer, AnalyzeError } = require('./planAnalyzer');
const { openDb } = require('./db');
const { createStore } = require('./store');
const { createSettings, SettingsError } = require('./settings');
const { createVault, loadOrCreateMasterKey } = require('./vault');
const backups = require('./backup');
const { createQuoteStore, registerQuoteRoutes } = require('./quotes');
const crypto = require('crypto');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const SETUP_PAGE = path.join(__dirname, 'setup.html');
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
  `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes([LOGIN_PAGE, SETUP_PAGE]).join(' ')}`,
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
function createApp({ accessCode = '', secret, anthropicApiKey = '', aiDailyLimit, analyzer, db, env = {}, createAnalyzer = createPlanAnalyzer, vault = createVault(), setupCode, backupDir = null }) {
  const version = readVersion();
  const database = db || openDb();
  const store = createStore(database);
  // Voorlopig één tenant; zie db.js voor de opzet richting multitenant.
  const tenant = store.ensureTenant();
  const startEnv = { ...env };
  if (accessCode) startEnv.ACCESS_CODE = accessCode;
  if (anthropicApiKey) startEnv.ANTHROPIC_API_KEY = anthropicApiKey;
  if (aiDailyLimit !== undefined) startEnv.AI_DAILY_LIMIT = aiDailyLimit;
  const settings = createSettings({ db: database, tenantId: tenant.id, env: startEnv, vault });
  const installCode = setupCode || env.SETUP_CODE || newSetupCode();
  const getAccessCode = () => settings.get('accessCode');
  // Gasten (zonder inloggen) alleen als dat aanstaat en er geen code is.
  const guestsAllowed = () => !getAccessCode() && settings.get('guestAccess');
  // Nog geen beheerder met een eigen account: eerst het instelscherm.
  const needsSetup = () => store.countAdmins(tenant.id) === 0;
  const auth = createAuth({ secret, store, tenantId: tenant.id, getAccessCode,
    idleDays: () => settings.get('sessionIdleDays'), maxDays: () => settings.get('sessionMaxDays') });
  const audit = (req, action, detail = {}, userId) => store.audit({ tenantId: tenant.id, userId: userId === undefined ? req.user?.id || null : userId, action, detail, ip: remoteIp(req) });
  // Express 4 vangt geen afgewezen promises: doorgeven aan de foutafhandeling.
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // De AI-client volgt de API-sleutel uit de instellingen (zonder herstart).
  let cachedAnalyzer = { key: null, analyzer: null };
  function currentAnalyzer() {
    if (analyzer) return analyzer;
    const key = settings.get('anthropicApiKey');
    if (cachedAnalyzer.key !== key) cachedAnalyzer = { key, analyzer: createAnalyzer({ apiKey: key }) };
    return cachedAnalyzer.analyzer;
  }
  const aiAvailable = () => settings.get('aiEnabled') && currentAnalyzer().available;
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
      if (lockedOut(username)) {
        audit(req, 'inloggen_geblokkeerd', { username }, null);
        return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen voor deze gebruiker. Probeer het over een kwartier opnieuw.' });
      }
      const user = await store.authenticate(tenant.id, username, String(req.body?.password ?? '').slice(0, 1024));
      if (!user) {
        failed(username);
        audit(req, 'inloggen_mislukt', { username }, null);
        return res.status(401).json({ error: 'wrong_login', message: 'Onjuiste gebruikersnaam of wachtwoord.' });
      }
      failures.delete(username);
      auth.setCookie(req, res, user.id);
      audit(req, 'ingelogd', { via: 'account' }, user.id);
      return res.json({ ok: true });
    }
    if (!getAccessCode()) {
      return res.status(400).json({ error: 'username_required', message: 'Vul je gebruikersnaam en wachtwoord in.' });
    }
    if (!auth.checkCode(String(req.body?.code ?? req.body?.password ?? ''))) {
      audit(req, 'inloggen_mislukt', { via: 'toegangscode' }, null);
      return res.status(401).json({ error: 'wrong_code', message: 'Onjuiste toegangscode.' });
    }
    auth.setCookie(req, res);
    audit(req, 'ingelogd', { via: 'toegangscode' }, null);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', (req, res) => {
    const s = auth.session(req);
    if (s) audit(req, 'uitgelogd', {}, s.user?.id || s.row.user_id);
    auth.clearCookie(req, res);
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
    const out = await store.createAccount(tenant.id, { username: String(username || '').trim().toLowerCase(), displayName, role: 'beheerder', password });
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
    if (user) store.touchUser(user.id);
    req.user = user;
    return user;
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
  const requireAdmin = (req, res, next) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (user.role !== 'beheerder') return res.status(403).json({ error: 'forbidden', message: 'Alleen voor beheerders.' });
    next();
  };
  // Schrijven alleen met JSON (geen cross-site formulieren).
  const requireJson = (req, res, next) => {
    if (req.is('application/json')) return next();
    res.status(415).json({ error: 'json_required', message: 'Verwacht JSON.' });
  };
  const ipOf = (req) => remoteIp(req);

  app.get('/api/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    const via = auth.session(req)?.via || (user ? 'gast' : null);
    res.json({
      user: user ? store.publicUser(user) : null,
      via,
      // Staan gasten aan, dan werkt iedereen zonder inloggen als (nieuwe) gast.
      guest: !user && guestsAllowed(),
      accessCodeConfigured: Boolean(getAccessCode()),
      setupRequired: needsSetup(),
    });
  });

  // ---------- Plannen: alleen de eigen plannen ----------
  const planLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 900, keyFn: (req) => req.user?.id || remoteIp(req) });
  const validPlan = (data) => data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.areas);

  app.get('/api/plans', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.json({ items: [] });
    res.json({ items: store.listPlans(tenant.id, { ownerId: user.id }) });
  });

  app.get('/api/plans/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    // Alleen de eigenaar (of een beheerder); anders 404, zodat niet te zien is
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
    res.json(store.listHistory(tenant.id, { limit, offset, userId: user, search: q, action }));
  });

  app.get('/api/admin/history/:id', (req, res) => {
    const h = store.getHistory(tenant.id, req.params.id);
    if (!h) return res.status(404).json({ error: 'not_found', message: 'Niet gevonden.' });
    res.json(h);
  });

  app.get('/api/admin/plans', (req, res) => {
    res.json({ items: store.listPlans(tenant.id, {
      ownerId: req.query.owner ? String(req.query.owner) : null,
      includeDeleted: req.query.deleted === '1',
      withHistory: true,
    }) });
  });

  // Tijdlijn van één plan (ook als het plan verwijderd is).
  app.get('/api/admin/plans/:id/history', (req, res) => {
    res.json(store.listHistory(tenant.id, { planId: req.params.id, limit: 500 }));
  });

  app.get('/api/admin/plans/:id', (req, res) => {
    const plan = store.getPlan(req.user, req.params.id);
    if (!plan) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    res.json(plan);
  });

  app.get('/api/admin/users', (req, res) => {
    res.json({ items: store.listUsers(tenant.id) });
  });

  app.post('/api/admin/users', requireJson, wrap(async (req, res) => {
    const { username, displayName, role, password } = req.body || {};
    const out = await store.createAccount(tenant.id, { username: String(username || '').trim().toLowerCase(), displayName, role, password });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    audit(req, 'gebruiker_aangemaakt', { userId: out.user.id, username: out.user.username, role: out.user.role });
    res.status(201).json(store.publicUser(out.user));
  }));

  app.patch('/api/admin/users/:id', requireJson, wrap(async (req, res) => {
    const input = {};
    for (const k of ['displayName', 'role', 'disabled', 'password', 'username']) if (req.body?.[k] !== undefined) input[k] = req.body[k];
    const out = await store.updateAccount(tenant.id, req.params.id, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    // Welke velden, nooit de waarden van een wachtwoord.
    audit(req, 'gebruiker_gewijzigd', { userId: out.user.id, username: out.user.username, fields: Object.keys(input),
      ...(input.role !== undefined ? { role: input.role } : {}), ...(input.disabled !== undefined ? { disabled: Boolean(input.disabled) } : {}) });
    res.json(store.publicUser(out.user));
  }));

  // Gebruiker op alle toestellen uitloggen.
  app.post('/api/admin/users/:id/logout', (req, res) => {
    const u = store.getUser(req.params.id);
    if (!u || u.tenant_id !== tenant.id) return res.status(404).json({ error: 'not_found', message: 'Gebruiker niet gevonden.' });
    const n = store.revokeSessions(tenant.id, u.id);
    audit(req, 'sessies_ingetrokken', { userId: u.id, username: u.username, count: n });
    res.json({ ok: true, revoked: n });
  });

  // Plan definitief wissen, inclusief de inhoud van de historie (AVG).
  app.delete('/api/admin/plans/:id', (req, res) => {
    const out = store.purgePlan(tenant.id, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });
    audit(req, 'plan_gewist', { planId: req.params.id, historyRows: out.history });
    res.json({ ok: true, ...out });
  });

  // ---------- Beheer: back-ups ----------
  // Alleen versleutelde bestanden; downloaden is dus veilig voor een kopie
  // elders (zonder de hoofdsleutel onleesbaar).
  let backupRunning = null;
  async function runBackup(req = null) {
    if (!backupDir) throw Object.assign(new Error('Back-ups zijn niet ingesteld.'), { status: 501 });
    if (backupRunning) return backupRunning;
    backupRunning = (async () => {
      try {
        const b = await backups.createBackup({ db: database, dir: backupDir, vault });
        backups.pruneBackups(backupDir, Math.max(1, settings.get('backupKeepDays')));
        if (req) audit(req, 'backup_gemaakt', { name: b.name, size: b.size });
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
    audit(req, 'backup_gedownload', { name });
    res.download(path.join(backupDir, name), name);
  });

  // Auditlog: beveiligingsgebeurtenissen.
  app.get('/api/admin/audit', (req, res) => {
    const { limit, offset, action } = req.query;
    res.json(store.listAudit(tenant.id, { limit, offset, action }));
  });

  // ---------- Beheer: instellingen ----------
  app.get('/api/admin/settings', (req, res) => {
    res.json({ settings: settings.view(), via: auth.session(req)?.via || null });
  });

  app.put('/api/admin/settings', requireJson, (req, res) => {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const via = auth.session(req)?.via;
    const oldCode = getAccessCode();
    // Wie met de toegangscode is ingelogd, zou zichzelf buitensluiten door die
    // leeg te maken; met een beheerdersaccount kan het wel.
    const resets = Array.isArray(patch.reset) ? patch.reset : [];
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
    if (via === 'code' && getAccessCode() && getAccessCode() !== oldCode) auth.setCookie(req, res);
    if (changed.length) {
      console.log(`Instellingen gewijzigd door ${req.user?.display_name || 'beheerder'}: ${changed.join(', ')}`);
      audit(req, 'instellingen_gewijzigd', { fields: changed });
    }
    res.json({ settings: settings.view(), changed });
  });

  // Sleutel testen zonder kosten: vraagt alleen het model op.
  app.post('/api/admin/settings/test-ai', async (req, res, next) => {
    const a = currentAnalyzer();
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
  const analyzeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: () => settings.get('aiHourlyPerIp'), keyFn: remoteIp });
  const daily = { day: '', count: 0 };
  const today = () => new Date().toISOString().slice(0, 10);
  const requireAppAccess = (req, res, next) => {
    if (guestsAllowed() || auth.isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
  };

  app.get('/api/plan/status', requireAppAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (daily.day !== today()) Object.assign(daily, { day: today(), count: 0 });
    res.json({ available: Boolean(aiAvailable()), remainingToday: Math.max(0, settings.get('aiDailyLimit') - daily.count) });
  });

  app.post('/api/plan/analyze', requireAppAccess, analyzeLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const { image, width, height } = req.body || {};
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    const w = Number(width), h = Number(height);
    if (!m || !(w > 0 && h > 0 && w <= 8000 && h <= 8000)) {
      return res.status(400).json({ error: 'invalid_image', message: 'Ongeldige afbeelding.' });
    }
    if (!settings.get('aiEnabled')) {
      return res.status(409).json({ error: 'disabled', message: 'Automatisch herkennen met AI staat uit (Beheer > Instellingen). De lokale herkenning en tekenen werken wel.' });
    }
    const planAnalyzer = currentAnalyzer();
    if (!planAnalyzer.available) {
      return res.status(409).json({ error: 'not_configured', message: 'Automatisch herkennen is niet ingesteld: een beheerder kan de API-sleutel invullen bij Beheer > Instellingen.' });
    }
    if (daily.day !== today()) Object.assign(daily, { day: today(), count: 0 });
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
        store.record({ tenantId: tenant.id, userId: user.id, action: 'analyse', title: 'Plan herkend',
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

  // ---------- Offertes (module Offertes, zie quotes.js) ----------
  registerQuoteRoutes(app, {
    quotes: createQuoteStore(database), identify, requireUser, requireAdmin, requireJson, audit,
    tenantOf: () => tenant.id, settingsOf: () => settings,
  });

  // Openbare vlaggen voor het dashboard en de modules (geen geheimen).
  app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ modules: settings.get('modules'), ai: Boolean(aiAvailable()) });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // Niet ingelogd: eerst het instelscherm zolang er geen beheerder is, anders
  // de inlogpagina (op elk pad, zodat een herlaad na het inloggen meteen de
  // gevraagde pagina toont). Alleen met gasten aan is de app zonder inloggen
  // bereikbaar.
  const authPage = (req) => (!auth.isAuthenticated(req) && needsSetup() ? SETUP_PAGE : LOGIN_PAGE);

  app.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(authPage(req));
  });

  app.use((req, res, next) => {
    const authenticated = auth.isAuthenticated(req);
    if (authenticated || (guestsAllowed() && !needsSetup())) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).end();
    res.status(401);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(needsSetup() ? SETUP_PAGE : LOGIN_PAGE);
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
  app.locals.maintenance = () => store.applyRetention(tenant.id, { ipDays: settings.get('ipRetentionDays'), auditDays: settings.get('auditRetentionDays') });
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
  const db = openDb(path.join(dataDir, 'aquatech.db'));
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
