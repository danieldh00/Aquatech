const path = require('path');
const fs = require('fs');
const express = require('express');

const { createAuth, remoteIp } = require('./auth');
const { createRateLimiter } = require('./rateLimit');
const { loadOptions, loadOrCreateSecret } = require('./options');

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

function createApp({ accessCode = '', secret }) {
  const version = readVersion();
  const auth = createAuth({ secret, getAccessCode: () => accessCode });
  const app = express();

  app.disable('x-powered-by');
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

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // Alles hieronder (de planner zelf) alleen via HA-ingress of met een geldige
  // sessie-cookie. Anders de inlogpagina, op elk pad, zodat een herlaad na het
  // inloggen meteen de planner toont.
  app.use((req, res, next) => {
    if (auth.isAuthenticated(req)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).end();
    res.status(401);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(LOGIN_PAGE);
  });

  // no-cache: de browser controleert bij elke start of er een nieuwe versie is
  // (na een update meteen de nieuwe planner, zonder harde refresh).
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // Onder ingress komt de app binnen op /api/hassio_ingress/<token>/; elk ander
  // pad dat geen bestand is, is gewoon de app.
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Ongeldige JSON' });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Interne fout' });
  });

  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const { accessCode } = loadOptions(dataDir);
  const secret = loadOrCreateSecret(dataDir);
  const port = Number(process.env.PORT) || 3300;
  if (!accessCode) {
    console.warn('Geen toegangscode ingesteld: de planner werkt alleen via het Home Assistant-zijpaneel (ingress) tot je access_code invult.');
  }
  createApp({ accessCode, secret }).listen(port, () => {
    console.log(`Beregeningsplanner luistert op poort ${port}`);
  });
}

module.exports = { createApp, FRONTEND_DIR };
