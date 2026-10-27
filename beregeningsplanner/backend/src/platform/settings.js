const { transaction } = require('../database/db');
const { createVault } = require('../beveiliging/vault');
const { sanitizeProfile } = require('../verkoop/quotes');
const { sanitizeMail } = require('./mailer');
const { sanitizeShop } = require('../webshop/woocommerce');
const { sanitizeOutsourcing } = require('../uitvoering/outsourcing');
const { sanitizeInvoicing } = require('../verkoop/invoices');
const { sanitizeSeasonReminders } = require('../uitvoering/season-reminders');
const { sanitizeVisma, sanitizeVismaApp } = require('../verkoop/visma');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));
const AiModels = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));

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
  // Seizoensherinneringen voor klanten (season-reminders.js): aan/uit, adres
  // van het klantportaal voor de knop in de mail, en de herinneringen.
  seasonReminders: { type: 'object', default: {}, sanitize: sanitizeSeasonReminders },
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
  /**
   * Fout in een instelling, met het veld waar het om gaat (voor het formulier).
   * @param {string} field Naam van de instelling.
   * @param {string} message De foutmelding.
   */
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

/**
 * Zet een opgeslagen of ingevoerde waarde om naar het type van de instelling
 * (geheim, ja/nee, geheel getal binnen min/max, vlaggen, object via de eigen
 * sanitize, keuzelijst).
 * @param {object} definition Beschrijving van de instelling uit FIELDS.
 * @param {*} raw De ruwe waarde.
 * @returns {*} De waarde in het juiste type.
 */
function coerce(definition, raw) {
  if (definition.type === 'secret') return String(raw ?? '').trim();
  if (definition.type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (definition.type === 'int') {
    const number = Number(raw);
    return Number.isFinite(number) ? Math.min(definition.max, Math.max(definition.min, Math.floor(number))) : definition.default;
  }
  if (definition.type === 'flags') {
    const out = {};
    if (raw && typeof raw === 'object') for (const [flag, enabled] of Object.entries(raw)) if (/^[a-z0-9-]{1,40}$/.test(flag)) out[flag] = Boolean(enabled);
    return out;
  }
  if (definition.type === 'object') return definition.sanitize(raw);
  if (definition.type === 'enum') return definition.values.includes(raw) ? raw : definition.default;
  return raw;
}

/**
 * Maakt de instellingen van één tenant: leest ze uit de database (geheimen
 * ontsleuteld) en houdt ze in het geheugen (één proces per database).
 * @param {{ db: object, tenantId: string, env?: object, vault?: object }} options Database, tenant waarvan de instellingen zijn, omgevingsvariabelen als startwaarden en de kluis voor geheimen.
 * @returns {{ get: Function, update: Function, view: Function, FIELDS: object }} De instellingenfuncties.
 */
function createSettings({ db, tenantId, env = {}, vault = createVault() }) {
  /**
   * Context voor de versleuteling van een geheim: tenant en veldnaam wegen mee,
   * zodat een versleutelde waarde niet naar een ander veld of een andere tenant
   * te kopiëren is.
   * @param {string} key Naam van de instelling.
   * @returns {string} '<tenant>:<veld>'.
   */
  const secretContext = (key) => `${tenantId}:${key}`;
  /**
   * Zet een waarde om naar de tekst voor de database; een geheim als { enc: 'v1:…' }.
   * @param {string} key Naam van de instelling.
   * @param {*} value De waarde.
   * @returns {string} JSON-tekst.
   */
  const encode = (key, value) => JSON.stringify(FIELDS[key].type === 'secret' ? { enc: vault.seal(value, secretContext(key)) } : value);

  // Eén proces per database: de waarden staan ook in het geheugen.
  let stored = {};
  const legacy = [];
  for (const row of db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tenantId)) {
    const definition = FIELDS[row.key];
    if (!definition) continue;
    try {
      const parsed = JSON.parse(row.value);
      if (definition.type !== 'secret') stored[row.key] = parsed;
      else if (parsed && typeof parsed === 'object' && typeof parsed.enc === 'string') stored[row.key] = vault.open(parsed.enc, secretContext(row.key));
      else {
        // Van voor de versleuteling: meteen versleuteld opnieuw opslaan.
        stored[row.key] = String(parsed ?? '');
        legacy.push(row.key);
      }
    } catch {
      console.warn(`Instelling ${row.key} is onleesbaar (of versleuteld met een andere hoofdsleutel) en wordt genegeerd.`);
    }
  }

  /**
   * Waar de waarde van een instelling vandaan komt: database, omgeving of standaard.
   * @param {string} key Naam van de instelling.
   * @param {boolean} [ignoreStored] De database overslaan (voor de startwaarde).
   * @returns {'instellingen'|'omgeving'|'standaard'} De bron.
   */
  function source(key, ignoreStored = false) {
    const definition = FIELDS[key];
    if (!ignoreStored && Object.prototype.hasOwnProperty.call(stored, key)) return 'instellingen';
    const envValue = definition.env && env[definition.env];
    if (envValue !== undefined && envValue !== '') return 'omgeving';
    return 'standaard';
  }

  /**
   * De waarde van een instelling.
   * @param {string} key Naam van de instelling.
   * @param {boolean} [initial] true = de startwaarde (omgeving of standaard), zonder wat in de database staat; daar gaat een veld naartoe bij 'terugzetten'.
   * @returns {*} De waarde.
   * @throws {Error} Bij een onbekende instelling.
   */
  function get(key, initial = false) {
    const definition = FIELDS[key];
    if (!definition) throw new Error(`Onbekende instelling ${key}`);
    switch (source(key, initial)) {
      case 'instellingen': return coerce(definition, stored[key]);
      case 'omgeving': return coerce(definition, env[definition.env]);
      default: return definition.type === 'flags' ? {} : definition.type === 'object' ? coerce(definition, definition.default) : definition.default;
    }
  }

  /**
   * Slaat gewijzigde velden op in de database (weggelaten velden worden verwijderd).
   * @param {object} next Alle opgeslagen waarden na de wijziging.
   * @param {string[]} changed Namen van de gewijzigde velden.
   * @param {string|null} userId Wie de wijziging doet (updated_by).
   * @returns {void}
   */
  function save(next, changed, userId) {
    const deleteRow = db.prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?');
    const upsertRow = db.prepare(`INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    const timestamp = new Date().toISOString();
    transaction(db, () => {
      for (const key of changed) {
        if (Object.prototype.hasOwnProperty.call(next, key)) upsertRow.run(tenantId, key, encode(key, next[key]), timestamp, userId || null);
        else deleteRow.run(tenantId, key);
      }
    });
  }

  if (legacy.length) {
    const updateRow = db.prepare('UPDATE settings SET value = ? WHERE tenant_id = ? AND key = ?');
    transaction(db, () => { for (const key of legacy) updateRow.run(encode(key, stored[key]), tenantId, key); });
    console.log(`Geheimen versleuteld opgeslagen: ${legacy.join(', ')}`);
  }

  /**
   * Wijzigingen uit het instellingenscherm. Geheimen: weglaten = ongewijzigd,
   * tekst = nieuwe waarde, '' = leegmaken. `reset: ['veld']` zet een veld terug
   * naar de startwaarde (omgeving of standaard).
   * @param {object} [patch] De gewijzigde velden (en eventueel reset).
   * @param {string|null} [userId] Wie de wijziging doet (voor updated_by).
   * @returns {string[]} De gewijzigde velden.
   * @throws {SettingsError} Bij een onbekend veld of een ongeldige waarde.
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
      const definition = FIELDS[key];
      if (!definition) throw new SettingsError(key, `Onbekende instelling: ${key}`);
      if (definition.type === 'secret') {
        if (typeof raw !== 'string') throw new SettingsError(key, 'Ongeldige waarde.');
        const value = raw.trim();
        if (value.length > (definition.max || 500)) throw new SettingsError(key, 'Waarde is te lang.');
        if (value && value.length < definition.min) throw new SettingsError(key, `Minimaal ${definition.min} tekens.`);
        next[key] = value;
      } else if (definition.type === 'int') {
        const number = raw;
        if (typeof number !== 'number' || !Number.isInteger(number) || number < definition.min || number > definition.max) throw new SettingsError(key, `Kies een geheel getal van ${definition.min} tot ${definition.max}.`);
        next[key] = number;
      } else if (definition.type === 'enum') {
        if (!definition.values.includes(raw)) throw new SettingsError(key, 'Kies een van de mogelijkheden.');
        next[key] = raw;
      } else if (definition.type === 'bool') {
        if (typeof raw !== 'boolean') throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = raw;
      } else if (definition.type === 'flags') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = { ...get(key), ...coerce(definition, raw) };
      } else if (definition.type === 'object') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(key, 'Ongeldige waarde.');
        next[key] = coerce(definition, raw);
      }
      changed.push(key);
    }
    const unique = [...new Set(changed)];
    save(next, unique, userId);
    stored = next;
    return unique;
  }

  /**
   * Overzicht voor het instellingenscherm. Geheimen gaan nooit volledig terug:
   * alleen of ze gezet zijn en zo nodig de laatste 4 tekens.
   * @returns {Object<string, { value?: *, set?: boolean, hint?: string, source: string }>} Per instelling de waarde (of de stand van het geheim) en de bron.
   */
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
