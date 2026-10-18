const path = require('path');
const fs = require('fs');
const express = require('express');

const { createAuth, remoteIp } = require('./auth');
const { createRateLimiter } = require('./rateLimit');
const { loadOptions, loadOrCreateSecret } = require('./options');
const { createPlanAnalyzer, AnalyzeError } = require('./planAnalyzer');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const PKG = require('../package.json');

// Versie uit config.yaml van de add-on (als die meegeleverd is), anders uit package.json.
function readVersion() {
  try {
    const cfg = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
    const m = cfg.match(/^version:\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch (err) {
    // niet aanwezig in de image: valt terug op package.json
  }
  return process.env.BUILD_VERSION || PKG.version;
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

function createApp({ accessCode = '', secret, anthropicApiKey = '', aiDailyLimit = 30, analyzer }) {
  const version = readVersion();
  const auth = createAuth({ secret, getAccessCode: () => accessCode });
  const planAnalyzer = analyzer || createPlanAnalyzer({ apiKey: anthropicApiKey });
  const app = express();

  app.disable('x-powered-by');
  // Grote limiet alleen voor de plananalyse (afbeelding als base64).
  app.use('/api/plan/analyze', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Inloggen: streng begrensd per IP (achter de tunnel is dat het
  // cloudflared-adres, dus effectief een globale grens -- prima voor een
  // handvol gebruikers, en precies wat raden van de code onmogelijk maakt).
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyFn: remoteIp });

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version });
  });

  app.get('/api/auth/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: auth.isAuthenticated(req), configured: Boolean(accessCode) });
  });

  app.post('/api/auth/login', loginLimiter, (req, res) => {
    if (!accessCode) {
      return res.status(409).json({ error: 'not_configured', message: 'Er is nog geen toegangscode ingesteld. Stel die in via de app-configuratie in Home Assistant.' });
    }
    if (!auth.checkCode(String(req.body?.code ?? ''))) {
      return res.status(401).json({ error: 'wrong_code', message: 'Onjuiste toegangscode.' });
    }
    auth.setCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // Automatisch herkennen van een plan. De URL is (zonder toegangscode)
  // openbaar, dus elke aanroep kost tegoed: per IP begrensd plus een
  // dagelijks maximum voor de hele app (ai_daily_limit).
  const analyzeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: remoteIp });
  const daily = { day: '', count: 0 };
  const today = () => new Date().toISOString().slice(0, 10);
  const requireAppAccess = (req, res, next) => {
    if (!accessCode || auth.isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in met de toegangscode.' });
  };

  app.get('/api/plan/status', requireAppAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (daily.day !== today()) Object.assign(daily, { day: today(), count: 0 });
    res.json({ available: planAnalyzer.available, remainingToday: Math.max(0, aiDailyLimit - daily.count) });
  });

  app.post('/api/plan/analyze', requireAppAccess, analyzeLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const { image, width, height } = req.body || {};
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    const w = Number(width), h = Number(height);
    if (!m || !(w > 0 && h > 0 && w <= 8000 && h <= 8000)) {
      return res.status(400).json({ error: 'invalid_image', message: 'Ongeldige afbeelding.' });
    }
    if (!planAnalyzer.available) {
      return res.status(409).json({ error: 'not_configured', message: 'Automatisch herkennen is niet ingesteld: vul anthropic_api_key in bij de app-configuratie.' });
    }
    if (daily.day !== today()) Object.assign(daily, { day: today(), count: 0 });
    if (daily.count >= aiDailyLimit) {
      return res.status(429).json({ error: 'daily_limit', message: 'Het dagelijkse maximum voor automatisch herkennen is bereikt. Probeer het morgen opnieuw of teken het plan zelf.' });
    }
    daily.count += 1;
    try {
      const result = await planAnalyzer.analyze({ mediaType: m[1], data: m[2], width: w, height: h });
      console.log(`Plan geanalyseerd: ${result.areas.length} vlakken, schaal ${result.scale.method || '-'} (${result.scale.confidence || '-'})`);
      res.json(result);
    } catch (err) {
      if (err instanceof AnalyzeError) {
        console.warn(`Plananalyse mislukt: ${err.code} – ${err.message}`);
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // Zonder ingestelde toegangscode is de planner openbaar (er staat geen
  // gevoelige data op de server). Met code: alleen via HA-ingress of met een
  // geldige sessie-cookie, anders de inlogpagina op elk pad, zodat een herlaad
  // na het inloggen meteen de planner toont.
  app.use((req, res, next) => {
    if (!accessCode || auth.isAuthenticated(req)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).end();
    res.status(401);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(LOGIN_PAGE);
  });

  // no-cache: de browser controleert bij elke start of er een nieuwe versie is
  // (na een update meteen de nieuwe planner, zonder harde refresh).
  // redirect: false -- express zou `/beregening` absoluut doorsturen naar
  // `/beregening/`, wat onder ingress buiten de app uitkomt; dat doen we
  // hieronder zelf, relatief.
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', redirect: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // Elke map in de frontend met een eigen index.html is een module van het
  // dashboard (zie frontend/dashboard/modules.js). Onder ingress komt de app
  // binnen op /api/hassio_ingress/<token>/, dus de doorverwijzing naar de
  // module-URL met slash moet relatief zijn ("beregening/", niet "/beregening/").
  app.get('*', (req, res) => {
    const segs = req.path.split('/').filter(Boolean);
    const mod = segs.length && isModule(segs[0]) ? segs[0] : null;
    if (mod && segs.length === 1 && !req.path.endsWith('/')) {
      const qs = req.originalUrl.slice(req.path.length);
      return res.redirect(302, `${mod}/${qs}`);
    }
    // Elk ander pad dat geen bestand is: de module zelf, of anders het dashboard.
    res.sendFile(path.join(FRONTEND_DIR, mod || '', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Ongeldige JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Bestand te groot.' });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Interne fout' });
  });

  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const { accessCode, anthropicApiKey, aiDailyLimit } = loadOptions(dataDir);
  const secret = loadOrCreateSecret(dataDir);
  const port = Number(process.env.PORT) || 3300;
  if (!accessCode) {
    console.log('Geen toegangscode ingesteld: de planner is zonder inloggen bereikbaar. Vul access_code in om inloggen verplicht te maken.');
  }
  if (!anthropicApiKey) console.log('Geen anthropic_api_key ingesteld: automatisch herkennen van plannen staat uit (tekenen en de toverstaf werken wel).');
  createApp({ accessCode, secret, anthropicApiKey, aiDailyLimit }).listen(port, () => {
    console.log(`Beregeningsplanner luistert op poort ${port}`);
  });
}

module.exports = { createApp, FRONTEND_DIR };
