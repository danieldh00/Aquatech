const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Als Home Assistant-add-on schrijft Supervisor de ingevulde opties naar
// /data/options.json. Die dienen alleen nog als startwaarden voor de
// instellingen (zie settings.js); buiten HA bestaat het bestand niet.
function readHaOptions(dataDir) {
  const optionsPath = process.env.OPTIONS_PATH || path.join(dataDir, 'options.json');
  try {
    const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    return options && typeof options === 'object' ? options : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Kon ${optionsPath} niet lezen: ${err.message}`);
    return {};
  }
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

module.exports = { readHaOptions, loadOrCreateSecret };
