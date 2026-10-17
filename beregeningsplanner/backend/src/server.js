const path = require('path');
const fs = require('fs');
const express = require('express');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
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

function createApp() {
  const version = readVersion();
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // no-cache: de browser controleert bij elke start of er een nieuwe versie is
  // (na een add-on-update meteen de nieuwe planner, zonder harde refresh).
  app.use(express.static(FRONTEND_DIR, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // Onder ingress komt de app binnen op /api/hassio_ingress/<token>/; elk ander
  // pad dat geen bestand is, is gewoon de app.
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Interne fout' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3300;
  createApp().listen(port, () => {
    console.log(`Beregeningsplanner luistert op poort ${port}`);
  });
}

module.exports = { createApp, FRONTEND_DIR };
