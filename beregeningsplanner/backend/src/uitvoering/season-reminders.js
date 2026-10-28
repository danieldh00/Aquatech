// Seizoensherinneringen: in het voorjaar (beregening opstarten) en het najaar
// (winterklaar maken) krijgen klanten met een installatie een mail via de eigen
// mailserver van de organisatie, en in het klantportaal staat de herinnering
// bovenaan met een knop om onderhoud aan te vragen (melding, service-requests.js).
//
// Instelling seasonReminders per omgeving (Beheer > Instellingen): aan/uit, het
// adres van het portaal voor de knop in de mail en de herinneringen (datum en
// tekst). Elk uur kijkt runAll of er een herinnering aan de beurt is; tabel
// season_reminders_sent zorgt dat een klant hem maar één keer per jaar krijgt.
// Een klant zet de mails uit met de voorkeur seasonReminders (store.js).
const crypto = require('crypto');
const { preferencesOf } = require('../platform/store');
const { validEmail } = require('../platform/mailer');
const { mailBody } = require('../verkoop/quotes');

// Zo lang na de datum gaat de mail nog uit (de server stond bijvoorbeeld uit),
// en zo lang staat de herinnering in het portaal.
const MAIL_WINDOW_DAYS = 21;
const PORTAL_DAYS = 60;
// Hoogstens zoveel mails per omgeving per ronde; de rest volgt het uur erna.
const MAILS_PER_RUN = 100;
const MAX_ITEMS = 6;
const DEFAULT_ITEMS = [
  {
    key: 'voorjaar', title: 'Beregening weer opstarten', month: 3, day: 15,
    text: 'Het voorjaar komt eraan. Tijd om de beregening weer aan te zetten: wij controleren de leidingen, sproeiers en de besturing, zodat alles werkt voordat het droog wordt.',
  },
  {
    key: 'najaar', title: 'Beregening winterklaar maken', month: 10, day: 1,
    text: 'De eerste nachtvorst komt eraan. Laat de beregening op tijd winterklaar maken: wij blazen de leidingen leeg, zodat er niets kapotvriest.',
  },
];
const DEFAULTS = { enabled: false, portalUrl: '', items: DEFAULT_ITEMS };

/**
 * Maakt van een waarde nette tekst: regeleinden gelijkgetrokken, getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength) => (typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);

/**
 * Controleert het adres van het klantportaal (voor de knop in de mail): http(s),
 * zonder inloggegevens, eindigend op /portaal/.
 * @param {*} url Het adres.
 * @returns {string} Het adres, of leeg als het niet klopt.
 */
function cleanPortalUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && parsed.pathname.endsWith('/portaal/')
      ? `${parsed.origin}${parsed.pathname}` : '';
  } catch {
    return '';
  }
}

/**
 * Schoont de instelling seasonReminders op. Zonder herinneringen komen de
 * standaardherinneringen terug.
 * @param {object} raw De ruwe invoer.
 * @returns {{ enabled: boolean, portalUrl: string, items: object[] }} De instelling.
 */
function sanitizeSeasonReminders(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, MAX_ITEMS).map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const month = Math.min(12, Math.max(1, Math.floor(Number(source.month)) || 1));
    const day = Math.min(daysInMonth(month), Math.max(1, Math.floor(Number(source.day)) || 1));
    return { key: /^[a-z0-9-]{1,30}$/.test(source.key) ? source.key : '', title: cleanText(source.title, 100).replace(/\n/g, ' '), month, day, text: cleanText(source.text, 1000) };
  }).filter((item) => item.key && item.title && !seen.has(item.key) && seen.add(item.key));
  return { enabled: input.enabled === true, portalUrl: cleanPortalUrl(input.portalUrl), items: items.length ? items : DEFAULTS.items.map((item) => ({ ...item })) };
}

/**
 * Aantal dagen in een maand (februari altijd 28, zodat de datum elk jaar bestaat).
 * @param {number} month Maand 1-12.
 * @returns {number} Aantal dagen.
 */
function daysInMonth(month) {
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * De herinneringen die op een dag lopen: vanaf hun datum, zoveel dagen lang
 * (ook als die periode over de jaarwisseling loopt).
 * @param {object} config De instelling seasonReminders.
 * @param {Date} today De dag.
 * @param {number} days Hoe lang een herinnering loopt.
 * @returns {{ item: object, year: number, date: string }[]} Lopende herinneringen met het jaar waar ze bij horen.
 */
function activeItems(config, today, days) {
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out = [];
  for (const item of config.items || []) {
    for (const year of [today.getUTCFullYear(), today.getUTCFullYear() - 1]) {
      const start = Date.UTC(year, item.month - 1, item.day);
      if (day >= start && day < start + days * 86400000) {
        out.push({ item, year, date: new Date(start).toISOString().slice(0, 10) });
        break;
      }
    }
  }
  return out;
}

/**
 * Maakt de opslag voor verstuurde seizoensherinneringen.
 * @param {object} db De database.
 * @param {{ roles: object }} stores De rollen (welke rollen klant zijn).
 * @returns {{ recipients: Function, markSent: Function }} De opslagfuncties.
 */
function createSeasonReminderStore(db, { roles }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Klanten van een omgeving die een herinnering nog niet kregen: een actief
   * klantaccount met e-mailadres en een werkorder in deze omgeving (via een
   * offerte of een melding), dus met een installatie. In één query.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} userTenantIds Waar de klantaccounts van deze omgeving wonen (live-tenant en de omgeving zelf).
   * @param {string} reminderKey Sleutel van de herinnering.
   * @param {number} year Het jaar.
   * @param {number} limit Hoogstens zoveel klanten.
   * @returns {{ id: string, displayName: string, email: string, preferences: string }[]} De klanten.
   */
  function recipients(tenantId, userTenantIds, reminderKey, year, limit) {
    const keys = roles.keysOfKind(userTenantIds[0], 'klant');
    if (!keys.length) return [];
    return prepare(`SELECT u.id, u.display_name, u.email, u.preferences FROM users u
      WHERE u.tenant_id IN (${userTenantIds.map(() => '?').join(', ')}) AND u.kind = 'account' AND u.disabled = 0
        AND u.role IN (${keys.map(() => '?').join(', ')}) AND u.email IS NOT NULL AND u.email <> ''
        AND EXISTS (SELECT 1 FROM work_orders w WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'
          AND (EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id AND qu.customer_id = u.id)
            OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = u.id)))
        AND NOT EXISTS (SELECT 1 FROM season_reminders_sent s WHERE s.tenant_id = ? AND s.user_id = u.id AND s.reminder_key = ? AND s.year = ?)
      ORDER BY u.id LIMIT ?`)
      .all(...userTenantIds, ...keys, tenantId, tenantId, reminderKey, year, limit)
      .map((row) => ({ id: row.id, displayName: row.display_name || '', email: row.email, preferences: row.preferences }));
  }

  /**
   * Legt vast dat een klant een herinnering in een jaar kreeg (of bewust niet:
   * afgemeld). Twee keer hetzelfde doet niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de klant.
   * @param {string} reminderKey Sleutel van de herinnering.
   * @param {number} year Het jaar.
   * @param {string} [sentAt] Tijdstip (standaard nu).
   * @returns {void}
   */
  function markSent(tenantId, userId, reminderKey, year, sentAt = new Date().toISOString()) {
    prepare(`INSERT INTO season_reminders_sent (id, tenant_id, user_id, reminder_key, year, sent_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, user_id, reminder_key, year) DO NOTHING`).run(crypto.randomUUID(), tenantId, userId, reminderKey, year, sentAt);
  }

  return { recipients, markSent };
}

/**
 * Of een mailfout definitief is voor dit adres: de mailserver weigerde de
 * ontvanger (RCPT TO) met een 5xx-code (nodemailer: code EENVELOPE). Een
 * geweigerde afzender (MAIL FROM), de verbinding of het inloggen telt niet:
 * dat ligt niet aan de klant.
 * @param {Error & { code?: string, command?: string, responseCode?: number, permanent?: boolean }} error De fout van mailer.send.
 * @returns {boolean} true als opnieuw proberen voor deze klant geen zin heeft.
 */
function permanentFailure(error) {
  const rejected = error.permanent === true || (Number(error.responseCode) >= 500 && Number(error.responseCode) < 600 && Number(error.responseCode) !== 503);
  return error.code === 'EENVELOPE' && error.command === 'RCPT TO' && rejected;
}

/**
 * Maakt de verzendronde voor alle omgevingen.
 * @param {object} reminders De opslag uit createSeasonReminderStore.
 * @param {{ settingsFor: Function, mailerFor: Function, userTenantsOf: Function }} options Instellingen en mailer per omgeving, en waar de klanten van een omgeving wonen.
 * @returns {{ runAll: Function, runEnvironment: Function }} De verzendfuncties.
 */
function createSeasonReminderRunner(reminders, { settingsFor, mailerFor, userTenantsOf }) {
  let running = false;

  /**
   * Verstuurt de herinneringen die in één omgeving aan de beurt zijn.
   * @param {string} tenantId Id van de omgeving.
   * @param {Date} [today] De dag (tests).
   * @returns {Promise<{ sent: number, skipped: number, failed: number }>} Aantallen.
   */
  async function runEnvironment(tenantId, today = new Date()) {
    const result = { sent: 0, skipped: 0, failed: 0 };
    const settings = settingsFor(tenantId);
    const config = settings.get('seasonReminders');
    if (!config.enabled) return result;
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return result;
    const profile = settings.get('quoteProfile') || {};
    let budget = MAILS_PER_RUN;
    let transientFailures = 0;
    for (const { item, year } of activeItems(config, today, MAIL_WINDOW_DAYS)) {
      if (budget <= 0) break;
      for (const customer of reminders.recipients(tenantId, userTenantsOf(tenantId), item.key, year, budget)) {
        budget--;
        // Afgemeld of geen bruikbaar adres: vastleggen, dan komt hij niet terug in de lijst.
        if (preferencesOf(customer).seasonReminders === false || !validEmail(customer.email)) {
          reminders.markSent(tenantId, customer.id, item.key, year);
          result.skipped++;
          continue;
        }
        const button = config.portalUrl ? { label: 'Afspraak aanvragen', href: `${config.portalUrl}?herinnering=${encodeURIComponent(item.key)}` } : null;
        const body = mailBody(profile, [
          customer.displayName ? `Beste ${customer.displayName},` : 'Beste klant,',
          item.text,
          config.portalUrl ? 'Via de knop hieronder vraagt u in uw portaal direct een afspraak aan.' : 'Neem contact met ons op voor een afspraak.',
          'Wilt u deze herinneringen niet meer ontvangen? Zet ze uit in uw portaal.',
        ], button);
        try {
          await mailer.send({ to: customer.email, subject: item.title, text: body.text, html: body.html });
          reminders.markSent(tenantId, customer.id, item.key, year);
          result.sent++;
        } catch (error) {
          result.failed++;
          // Afzender geweigerd: geldt voor elke klant, dus deze ronde stoppen.
          if (error.command === 'MAIL FROM') return result;
          // Adres definitief geweigerd: vastleggen, anders blokkeert deze klant de rest.
          if (permanentFailure(error)) {
            reminders.markSent(tenantId, customer.id, item.key, year);
            continue;
          }
          // Tijdelijke fout (mailserver even weg): volgende ronde opnieuw.
          transientFailures++;
          if (transientFailures >= 3) return result;
        }
      }
    }
    return result;
  }

  /**
   * Verstuurt de herinneringen in alle omgevingen (elk uur vanuit server.js).
   * @param {string[]} tenantIds Ids van de omgevingen.
   * @param {Date} [today] De dag (tests).
   * @returns {Promise<Object<string, object>>} Aantallen per omgeving waar iets gebeurde.
   */
  async function runAll(tenantIds, today = new Date()) {
    // Loopt de vorige ronde nog (veel mails, trage server), dan deze overslaan:
    // twee rondes tegelijk kunnen dezelfde klant kiezen en dubbel mailen.
    if (running) return {};
    running = true;
    const out = {};
    try {
      for (const tenantId of tenantIds) {
        try {
          const result = await runEnvironment(tenantId, today);
          if (result.sent || result.skipped || result.failed) out[tenantId] = result;
        } catch (error) {
          out[tenantId] = { error: error.message };
        }
      }
      return out;
    } finally {
      running = false;
    }
  }

  return { runAll, runEnvironment };
}

/**
 * De herinneringen die een klant nu in het portaal ziet (alleen als de
 * herinneringen aan staan).
 * @param {object} config De instelling seasonReminders.
 * @param {Date} [today] De dag.
 * @returns {{ key: string, title: string, text: string, date: string }[]} De herinneringen.
 */
function portalReminders(config, today = new Date()) {
  if (!config || !config.enabled) return [];
  return activeItems(config, today, PORTAL_DAYS).map(({ item, date }) => ({ key: item.key, title: item.title, text: item.text, date }));
}

module.exports = { sanitizeSeasonReminders, createSeasonReminderStore, createSeasonReminderRunner, portalReminders, activeItems, DEFAULTS };
