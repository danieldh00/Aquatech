const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Als Home Assistant-add-on schrijft Supervisor de ingevulde opties
// (Instellingen > Apps > Beregeningsplanner > Configuratie) naar /data/options.json.
// Buiten HA (lokaal, plain Docker) bestaat dat bestand niet en komt alles uit
// de omgeving.
function loadOptions(dataDir) {
  const optionsPath = process.env.OPTIONS_PATH || path.join(dataDir, 'options.json');
  let options = {};
  try {
    options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Kon ${optionsPath} niet lezen: ${err.message}`);
  }
  const accessCode = String(options.access_code || process.env.ACCESS_CODE || '').trim();
  return { accessCode };
}

// Sleutel voor de sessie-cookies: één keer willekeurig aangemaakt en in /data
// bewaard, zodat gekoppelde toestellen een herstart overleven zonder dat de
// gebruiker nog een extra geheim hoeft in te vullen.
function loadOrCreateSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = { loadOptions, loadOrCreateSecret };
