const { transaction } = require('./db');
const { createVault } = require('./vault');
const { sanitizeProfile } = require('./quotes');
const { sanitizeMail } = require('./mailer');
const { sanitizeShop } = require('./woocommerce');
const { sanitizeOutsourcing } = require('./outsourcing');
const { sanitizeInvoicing } = require('./invoices');
const { sanitizeVisma, sanitizeVismaApp } = require('./visma');
const path = require('path');
const Theme = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'theme.js'));
const AiModels = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'ai-models.js'));

// App-instellingen, te beheren door beheerders via Beheer > Instellingen. Ze
// staan per tenant in de database (tabel settings) en werken zonder herstart.
//
// Volgorde per instelling: database -> omgevingsvariabele -> standaardwaarde.
// De omgeving (docker-compose/.env) is dus alleen een startwaarde: wat in het
// instellingenscherm is opgeslagen gaat voor.
// Geheimen (API-sleutel, toegangscode) gaan nooit volledig terug naar de browser
// en staan versleuteld in de database (AES-256-GCM, zie vault.js).

const FIELDS = {
  accessCode: { type: 'secret', env: 'ACCESS_CODE', default: '', min: 4 },
  // Zonder toegangscode mogen bezoekers zonder inloggen als gast werken.
  guestAccess: { type: 'bool', env: 'GUEST_ACCESS', default: false },
  // Bezoekers zonder account mogen een tekening maken en ter controle
  // indienen (knop op de inlogpagina, zie drawings.js).
  drawingRequests: { type: 'bool', default: true },
  anthropicApiKey: { type: 'secret', env: 'ANTHROPIC_API_KEY', default: '', min: 20, hint: true },
  aiEnabled: { type: 'bool', default: true },
  aiDailyLimit: { type: 'int', env: 'AI_DAILY_LIMIT', default: 30, min: 0, max: 500 },
  aiHourlyPerIp: { type: 'int', default: 10, min: 1, max: 100 },
  // Model voor AI-verzoeken (prijzen in shared/ai-models.js) en de koers
  // waarmee Beheer > AI-kosten de dollarprijzen in euro's omrekent
  // (eurocent per dollar).
  aiModel: { type: 'enum', values: AiModels.SELECTABLE, default: AiModels.DEFAULT },
  aiEurCentsPerUsd: { type: 'int', default: 86, min: 50, max: 200 },
  modules: { type: 'flags', default: {} },
  // Sessies: uitgelogd na zoveel dagen zonder gebruik, en hoe dan ook na de
  // maximale duur (opnieuw inloggen).
  sessionIdleDays: { type: 'int', default: 14, min: 1, max: 90 },
  sessionMaxDays: { type: 'int', default: 30, min: 1, max: 365 },
  // Bewaartermijnen (AVG): IP-adressen in historie en auditlog worden na
  // zoveel dagen gewist; regels in het auditlog na zoveel dagen verwijderd.
  ipRetentionDays: { type: 'int', default: 90, min: 1, max: 3650 },
  auditRetentionDays: { type: 'int', default: 365, min: 30, max: 3650 },
  // Versleutelde back-ups van de database: dagelijks, zoveel dagen bewaren
  // (0 = geen automatische back-ups).
  backupKeepDays: { type: 'int', env: 'BACKUP_KEEP_DAYS', default: 14, min: 0, max: 365 },
  // Bedrijfsgegevens, uurtarief en standaardteksten voor offertes (quotes.js).
  quoteProfile: { type: 'object', default: {}, sanitize: sanitizeProfile },
  // Eigen SMTP-server voor offertes en bevestigingen (mailer.js); het
  // wachtwoord staat apart en versleuteld.
  mailServer: { type: 'object', default: {}, sanitize: sanitizeMail },
  mailPassword: { type: 'secret', default: '', min: 1 },
  // Webshopkoppeling (shop.js): webadres, ophaalwijze, btw en handmatige
  // koppeling; de sleutels van de WooCommerce REST API staan apart en versleuteld.
  shopSource: { type: 'object', default: {}, sanitize: sanitizeShop },
  shopConsumerKey: { type: 'secret', default: '', min: 10, hint: true },
  shopConsumerSecret: { type: 'secret', default: '', min: 10 },
  // Opdrachten uitbesteden aan andere organisaties op het platform
  // (outsourcing.js): versturen en ontvangen staan standaard uit en zet de
  // beheerder zelf aan; region = werkgebied dat andere organisaties zien.
  outsourcing: { type: 'object', default: {}, sanitize: sanitizeOutsourcing },
  // Facturen (invoices.js): nummering, betaaltermijn en -tekst, en de
  // omzetcategorieën per omzetgroep en btw-tarief met grootboekrekening
  // voor de export naar de boekhouding.
  invoicing: { type: 'object', default: {}, sanitize: sanitizeInvoicing },
  // Kleurthema (shared/theme.js): alleen door een hoofdbeheerder te kiezen via
  // Hoofdbeheer (platform: niet via Beheer > Instellingen). In de hoofdtenant
  // geldt het voor alle organisaties, in een live-tenant als eigen thema.
  theme: { type: 'object', default: {}, sanitize: Theme.sanitize, platform: true },
  // Visma eAccounting (visma.js). De app-registratie (client ID, sandbox of
  // productie, redirect URI) en het secret gelden voor het hele platform en
  // staan in de hoofdtenant (Hoofdbeheer). Per omgeving: de keuzes in
  // Facturen → Visma en het refresh token van de verbonden administratie;
  // internal = alleen via /api/visma, niet via Beheer > Instellingen.
  vismaApp: { type: 'object', default: {}, sanitize: sanitizeVismaApp, platform: true },
  vismaClientSecret: { type: 'secret', default: '', min: 8, platform: true },
  visma: { type: 'object', default: {}, sanitize: sanitizeVisma, internal: true },
  vismaRefreshToken: { type: 'secret', default: '', min: 1, max: 4000, internal: true },
};

class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function coerce(def, raw) {
  if (def.type === 'secret') return String(raw ?? '').trim();
  if (def.type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (def.type === 'int') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, Math.floor(n))) : def.default;
  }
  if (def.type === 'flags') {
    const out = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (/^[a-z0-9-]{1,40}$/.test(k)) out[k] = Boolean(v);
    return out;
  }
  if (def.type === 'object') return def.sanitize(raw);
  if (def.type === 'enum') return def.values.includes(raw) ? raw : def.default;
  return raw;
}

/**
 * @param db        database uit db.js
 * @param tenantId  tenant waarvan de instellingen zijn
 * @param env       omgevingsvariabelen als startwaarden
 */
function createSettings({ db, tenantId, env = {}, vault = createVault() }) {
  // Geheimen staan als { enc: 'v1:…' } in de database; de tenant en de
  // veldnaam wegen mee, zodat een versleutelde waarde niet naar een ander veld
  // of een andere tenant te kopiëren is.
  const ctx = (key) => `${tenantId}:${key}`;
  const encode = (key, value) => JSON.stringify(FIELDS[key].type === 'secret' ? { enc: vault.seal(value, ctx(key)) } : value);

  // Eén proces per database: de waarden staan ook in het geheugen.
  let stored = {};
  const legacy = [];
  for (const row of db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tenantId)) {
    const def = FIELDS[row.key];
    if (!def) continue;
    try {
      const v = JSON.parse(row.value);
      if (def.type !== 'secret') stored[row.key] = v;
      else if (v && typeof v === 'object' && typeof v.enc === 'string') stored[row.key] = vault.open(v.enc, ctx(row.key));
      else {
        // Van voor de versleuteling: meteen versleuteld opnieuw opslaan.
        stored[row.key] = String(v ?? '');
        legacy.push(row.key);
      }
    } catch {
      console.warn(`Instelling ${row.key} is onleesbaar (of versleuteld met een andere hoofdsleutel) en wordt genegeerd.`);
    }
  }

  function source(key, ignoreStored = false) {
    const def = FIELDS[key];
    if (!ignoreStored && Object.prototype.hasOwnProperty.call(stored, key)) return 'instellingen';
    const ev = def.env && env[def.env];
    if (ev !== undefined && ev !== '') return 'omgeving';
    return 'standaard';
  }

  // initial = de startwaarde (omgeving of standaard), zonder wat in
  // de database staat: daar gaat een veld naartoe bij 'terugzetten'.
  function get(key, initial = false) {
    const def = FIELDS[key];
    if (!def) throw new Error(`Onbekende instelling ${key}`);
    switch (source(key, initial)) {
      case 'instellingen': return coerce(def, stored[key]);
      case 'omgeving': return coerce(def, env[def.env]);
      default: return def.type === 'flags' ? {} : def.type === 'object' ? coerce(def, def.default) : def.default;
    }
  }

  function save(next, changed, userId) {
    const del = db.prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?');
    const put = db.prepare(`INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    const at = new Date().toISOString();
    transaction(db, () => {
      for (const key of changed) {
        if (Object.prototype.hasOwnProperty.call(next, key)) put.run(tenantId, key, encode(key, next[key]), at, userId || null);
        else del.run(tenantId, key);
      }
    });
  }

  if (legacy.length) {
    const upd = db.prepare('UPDATE settings SET value = ? WHERE tenant_id = ? AND key = ?');
    transaction(db, () => { for (const key of legacy) upd.run(encode(key, stored[key]), tenantId, key); });
    console.log(`Geheimen versleuteld opgeslagen: ${legacy.join(', ')}`);
  }

  /**
   * Wijzigingen uit het instellingenscherm. Geheimen: weglaten = ongewijzigd,
   * tekst = nieuwe waarde, '' = leegmaken. `reset: ['veld']` zet een veld terug
   * naar de startwaarde (omgeving of standaard).
   * @param userId  wie de wijziging doet (voor updated_by)
   * @returns lijst van gewijzigde velden
   */
  function update(patch = {}, userId = null) {
    const next = { ...stored };
    const changed = [];
    for (const key of Array.isArray(patch.reset) ? patch.reset : []) {
      if (FIELDS[key] && Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
        changed.push(key);
      }
    }
    for (const [key, raw] of Object.entries(patch)) {
      if (key === 'reset' || raw === undefined) continue;
      const def = FIELDS[key];
      if (!def) throw new SettingsError(key, `Onbekende instelling: ${key}`);
      if (def.type === 'secret') {
        if (typeof raw !== 'string') throw new SettingsError(key, 'Ongeldige waarde.');
        const v = raw.trim();
        if (v.length > (def.max || 500)) throw new SettingsError(key, 'Waarde is te lang.');
        if (v && v.length < def.min) throw new SettingsError(key, `Minimaal ${def.min} tekens.`);
        next[key] = v;
      } else if (def.type === 'int') {
        const n = raw;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < def.min || n > def.max) throw new SettingsError(key, `Kies een geheel getal van ${def.min} tot ${def.max}.`);
        next[key] = n;
      } else if (def.type === 'enum') {
        if (!def.values.includes(raw)) throw new SettingsError(key, 'Kies een van de mogelijkheden.');
        next[key] = raw;
      } else if (def.type === 'bool') {
        if (typeof raw !== 'boolean') throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = raw;
      } else if (def.type === 'flags') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = { ...get(key), ...coerce(def, raw) };
      } else if (def.type === 'object') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = coerce(def, raw);
      }
      changed.push(key);
    }
    const unique = [...new Set(changed)];
    save(next, unique, userId);
    stored = next;
    return unique;
  }

  /** Overzicht voor het instellingenscherm. Geheimen gaan nooit volledig terug. */
  function view() {
    const out = {};
    for (const [key, def] of Object.entries(FIELDS)) {
      const value = get(key);
      if (def.type === 'secret') {
        out[key] = { set: Boolean(value), source: source(key) };
        if (def.hint && value.length >= 12) out[key].hint = `…${value.slice(-4)}`;
      } else {
        out[key] = { value, source: source(key) };
      }
    }
    return out;
  }

  return { get, update, view, FIELDS };
}

module.exports = { createSettings, SettingsError, FIELDS };
