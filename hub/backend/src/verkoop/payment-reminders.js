// Automatische betalingsherinneringen en aanmaningen voor vervallen facturen. Instelling paymentReminders per omgeving
// (Beheer > Modules > Betalingsherinneringen): aan/uit, per stap (herinnering, aanmaning, laatste aanmaning) of hij aan staat
// en na hoeveel dagen over de vervaldatum hij uitgaat, en na hoeveel dagen er niet meer automatisch gemaild wordt. De teksten
// staan in Beheer > Mail-opmaak (mailtypes factuur_*). Elk uur kijkt runAll welke definitieve, onbetaalde facturen aan de
// beurt zijn; tabel invoice_reminders onthoudt per factuur welke stap is verstuurd (of waarom niet), zodat niets dubbel gaat.
// Een klant is uit te zetten met users.reminders_off (klantkaart). Er is geen eigen boekhouding: een betaalde of gecrediteerde
// factuur valt vanzelf af.
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { validEmail, mailFailure } = require('../platform/mailer');
const { mailStyleOf, composeFor } = require('../platform/mail-layout');
const { permanentFailure } = require('../uitvoering/season-reminders');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));
const DocText = require(path.join(FRONTEND_DIR, 'shared', 'doc-text.js'));

/** De stappen in volgorde: sleutel, titel, standaard aantal dagen na de vervaldatum en het mailtype. */
const STEPS = [
  { key: 'herinnering', title: 'Betalingsherinnering', days: 7, mailType: 'factuur_herinnering', textKey: 1 },
  { key: 'aanmaning', title: 'Aanmaning', days: 21, mailType: 'factuur_aanmaning', textKey: 2 },
  { key: 'laatste_aanmaning', title: 'Laatste aanmaning', days: 35, mailType: 'factuur_laatste_aanmaning', textKey: 3 },
];
const MIN_STEP_GAP_DAYS = 7;
const MAX_STOP_DAYS = 365;
const DEFAULT_STOP_DAYS = 90;
// Hoogstens zoveel facturen per omgeving per ronde bekijken en zoveel mails versturen.
const CANDIDATE_LIMIT = 500;
const MAILS_PER_RUN = 50;
// Na een mail aan deze factuur wacht een volgende minstens zoveel dagen.
const MIN_DAYS_BETWEEN_MAILS = 3;
const DAY_MS = 86400000;
// Zo lang mag een reservering 'verzenden' zijn voor ze als onbekend getoond wordt.
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * Schoont de instelling paymentReminders op: stappen in vaste volgorde, de dagen strikt oplopend (minstens een week
 * ertussen) en de stopgrens boven de laatste stap.
 * @param {object} raw De ruwe invoer.
 * @returns {{ enabled: boolean, stopAfterDays: number, steps: { key: string, title: string, enabled: boolean, days: number }[] }} De instelling.
 */
function sanitizePaymentReminders(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  let previous = 0;
  const steps = STEPS.map((step) => {
    const source = rawSteps.find((item) => item && item.key === step.key) || {};
    const asked = Math.round(Number(source.days));
    const days = Math.min(MAX_STOP_DAYS - 1, Math.max(previous + MIN_STEP_GAP_DAYS, Number.isFinite(asked) && asked > 0 ? asked : step.days));
    previous = days;
    return { key: step.key, title: step.title, enabled: source.enabled === undefined ? step.key !== 'laatste_aanmaning' : source.enabled === true, days };
  });
  const lastDays = steps[steps.length - 1].days;
  const asked = Math.round(Number(input.stopAfterDays));
  const stopAfterDays = Math.min(MAX_STOP_DAYS, Math.max(lastDays + 1, Number.isFinite(asked) && asked > 0 ? asked : Math.max(DEFAULT_STOP_DAYS, lastDays + 1)));
  return { enabled: input.enabled === true, stopAfterDays, steps };
}

/**
 * Aantal hele dagen tussen twee datums (JJJJ-MM-DD).
 * @param {string} from De eerdere datum.
 * @param {string} to De latere datum.
 * @returns {number} Aantal dagen.
 */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);

/**
 * Maakt de opslag voor verstuurde betalingsherinneringen.
 * @param {object} db De database.
 * @returns {object} candidates, optedOut, byInvoice, latestByInvoice, record, claim, finish, release en forInvoice.
 */
function createPaymentReminderStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Plaatshouders voor een IN-lijst.
   * @param {number} count Aantal waarden.
   * @returns {string} Bijv. "?,?,?".
   */
  const marks = (count) => Array.from({ length: count }, () => '?').join(',');
  /**
   * Splitst een lijst in blokken.
   * @param {string[]} values De waarden.
   * @param {number} size Blokgrootte.
   * @returns {string[][]} De blokken.
   */
  const chunks = (values, size = 400) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));

  /**
   * Definitieve, onbetaalde en niet-gecrediteerde facturen waarvan de vervaldatum in het venster valt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} newestDue Laatste vervaldatum (vóór vandaag).
   * @param {string} oldestDue Oudste vervaldatum die nog meedoet.
   * @param {string} lastStepKey Sleutel van de laatste actieve stap: facturen die die al hebben vallen af.
   * @param {{ dueDate: string, id: string }|null} [after] Cursor: alleen facturen na deze (vervaldatum, id).
   * @returns {{ id: string, number: string, customerId: string|null, dueDate: string }[]} Hoogstens CANDIDATE_LIMIT facturen, oudste vervaldatum eerst.
   */
  function candidates(tenantId, newestDue, oldestDue, lastStepKey, after = null) {
    const cursor = after ? 'AND (due_date > ? OR (due_date = ? AND id > ?))' : '';
    return prepare(`SELECT id, number, customer_id, due_date FROM invoices
      WHERE tenant_id = ? AND status = 'definitief' AND kind = 'factuur' AND credited_at IS NULL AND total > 0
        AND due_date <= ? AND due_date >= ? ${cursor}
        AND NOT EXISTS (SELECT 1 FROM invoice_reminders r WHERE r.tenant_id = invoices.tenant_id AND r.invoice_id = invoices.id AND r.step_key = ?)
      ORDER BY due_date, id LIMIT ${CANDIDATE_LIMIT}`)
      .all(tenantId, newestDue, oldestDue, ...(after ? [after.dueDate, after.dueDate, after.id] : []), lastStepKey)
      .map((row) => ({ id: row.id, number: row.number || '', customerId: row.customer_id || null, dueDate: row.due_date }));
  }

  /**
   * Welke van deze klanten hebben de herinneringen uitgezet.
   * @param {string[]} userTenantIds Waar de klantaccounts wonen.
   * @param {string[]} customerIds Id's van de klanten.
   * @returns {Set<string>} Id's van de klanten met herinneringen uit.
   */
  function optedOut(userTenantIds, customerIds) {
    const out = new Set();
    for (const block of chunks([...new Set(customerIds.filter(Boolean))])) {
      for (const row of prepare(`SELECT id FROM users WHERE tenant_id IN (${marks(userTenantIds.length)}) AND reminders_off = 1 AND id IN (${marks(block.length)})`).all(...userTenantIds, ...block)) out.add(row.id);
    }
    return out;
  }

  /**
   * De vastgelegde stappen van een aantal facturen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} invoiceIds Id's van de facturen.
   * @returns {Map<string, { stepKey: string, status: string, sentAt: string }[]>} Factuur-id → stappen.
   */
  function byInvoice(tenantId, invoiceIds) {
    const out = new Map();
    for (const block of chunks(invoiceIds)) {
      for (const row of prepare(`SELECT invoice_id, step_key, status, sent_at FROM invoice_reminders WHERE tenant_id = ? AND invoice_id IN (${marks(block.length)}) ORDER BY sent_at`).all(tenantId, ...block)) {
        if (!out.has(row.invoice_id)) out.set(row.invoice_id, []);
        out.get(row.invoice_id).push({ stepKey: row.step_key, status: row.status, sentAt: row.sent_at });
      }
    }
    return out;
  }

  /**
   * De laatst verstuurde stap per factuur, voor de lijst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} invoiceIds Id's van de facturen.
   * @returns {Map<string, { stepKey: string, title: string, sentAt: string }>} Factuur-id → laatste verstuurde stap.
   */
  function latestByInvoice(tenantId, invoiceIds) {
    const out = new Map();
    for (const [invoiceId, steps] of byInvoice(tenantId, invoiceIds)) {
      const sent = steps.filter((step) => step.status === 'verstuurd');
      if (!sent.length) continue;
      const last = sent[sent.length - 1];
      out.set(invoiceId, { stepKey: last.stepKey, title: (STEPS.find((step) => step.key === last.stepKey) || {}).title || last.stepKey, sentAt: last.sentAt });
    }
    return out;
  }

  /**
   * Legt een stap vast (verstuurd of overgeslagen). Twee keer dezelfde stap doet niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @param {string} stepKey Sleutel van de stap.
   * @param {{ status?: string, sentTo?: string, reason?: string, daysOverdue?: number }} [details] Uitkomst.
   * @returns {void}
   */
  function record(tenantId, invoiceId, stepKey, { status = 'verstuurd', sentTo = '', reason = '', daysOverdue = 0 } = {}) {
    prepare(`INSERT INTO invoice_reminders (id, tenant_id, invoice_id, step_key, status, sent_at, sent_to, reason, days_overdue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, invoice_id, step_key) DO NOTHING`)
      .run(crypto.randomUUID(), tenantId, String(invoiceId), stepKey, status, new Date().toISOString(), String(sentTo).slice(0, 400), String(reason).slice(0, 300), daysOverdue);
  }

  /**
   * Reserveert een stap vóór het mailen (status 'verzenden'), zodat een databasefout of herstart na het mailen nooit tot een tweede mail leidt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @param {string} stepKey Sleutel van de stap.
   * @param {number} daysOverdue Dagen over de vervaldatum.
   * @returns {boolean} true als de stap nieuw is en deze aanroep hem mag versturen.
   */
  function claim(tenantId, invoiceId, stepKey, daysOverdue) {
    const out = prepare(`INSERT INTO invoice_reminders (id, tenant_id, invoice_id, step_key, status, sent_at, days_overdue) VALUES (?, ?, ?, ?, 'verzenden', ?, ?)
      ON CONFLICT (tenant_id, invoice_id, step_key) DO NOTHING`).run(crypto.randomUUID(), tenantId, String(invoiceId), stepKey, new Date().toISOString(), daysOverdue);
    return Number(out.changes) > 0;
  }

  /**
   * Zet een gereserveerde stap op de uitkomst (verstuurd of overgeslagen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @param {string} stepKey Sleutel van de stap.
   * @param {{ status: string, sentTo?: string, reason?: string }} outcome Uitkomst.
   * @returns {void}
   */
  function finish(tenantId, invoiceId, stepKey, { status, sentTo = '', reason = '' }) {
    prepare('UPDATE invoice_reminders SET status = ?, sent_at = ?, sent_to = ?, reason = ? WHERE tenant_id = ? AND invoice_id = ? AND step_key = ?')
      .run(status, new Date().toISOString(), String(sentTo).slice(0, 400), String(reason).slice(0, 300), tenantId, String(invoiceId), stepKey);
  }

  /**
   * Geeft een gereserveerde stap vrij na een tijdelijke mailfout, zodat de volgende ronde het opnieuw probeert.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @param {string} stepKey Sleutel van de stap.
   * @returns {void}
   */
  function release(tenantId, invoiceId, stepKey) {
    prepare("DELETE FROM invoice_reminders WHERE tenant_id = ? AND invoice_id = ? AND step_key = ? AND status = 'verzenden'").run(tenantId, String(invoiceId), stepKey);
  }

  /**
   * Alle vastgelegde stappen van één factuur, voor de factuurkaart.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @returns {{ stepKey: string, title: string, status: string, sentAt: string, sentTo: string, reason: string, daysOverdue: number }[]} De stappen, oudste eerst.
   */
  function forInvoice(tenantId, invoiceId) {
    // Bewuste keuze: liever nooit dubbel mailen dan altijd bereiken. Een reservering die langer dan een uur 'verzenden' blijft (proces gestopt
    // of vastleggen mislukt) wordt niet opnieuw verstuurd, maar hier zichtbaar als 'onbekend', zodat iemand hem zo nodig handmatig nastuurt.
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    return prepare('SELECT step_key, status, sent_at, sent_to, reason, days_overdue FROM invoice_reminders WHERE tenant_id = ? AND invoice_id = ? ORDER BY sent_at')
      .all(tenantId, String(invoiceId))
      .filter((row) => row.status !== 'verzenden' || row.sent_at < staleBefore)
      .map((row) => ({ stepKey: row.step_key, title: (STEPS.find((step) => step.key === row.step_key) || {}).title || row.step_key,
        status: row.status === 'verzenden' ? 'onbekend' : row.status, sentAt: row.sent_at, sentTo: row.sent_to,
        reason: row.status === 'verzenden' ? 'Onderbroken tijdens het versturen: niet zeker of de mail is aangekomen. Stuur zo nodig zelf een herinnering.' : row.reason, daysOverdue: Number(row.days_overdue) }));
  }

  return { candidates, optedOut, byInvoice, latestByInvoice, record, claim, finish, release, forInvoice };
}

/**
 * Maakt de verzendronde voor alle omgevingen.
 * @param {object} reminders De opslag uit createPaymentReminderStore.
 * @param {{ invoices: object, sender: object, settingsFor: Function, mailerFor: Function, mailBody: Function, userTenantsOf?: Function, enabled?: Function }} options
 *   Facturen, de factuurverzender (pdfOf, values), instellingen en mailer per omgeving, mailopbouw, waar de klanten wonen en of de omgeving mag mailen.
 * @returns {{ runAll: Function, runEnvironment: Function }} De verzendfuncties.
 */
function createPaymentReminderRunner(reminders, { invoices, sender, settingsFor, mailerFor, mailBody, userTenantsOf = (id) => [id], enabled = () => true }) {
  let running = false;

  /**
   * Onderwerp en alinea's van een stap, in de taal van de factuur.
   * @param {object} settings De instellingen van de omgeving.
   * @param {object} configured De ingestelde stap (key, days).
   * @param {string} language Documenttaal ('nl' of 'en').
   * @param {object} values De invulwaarden.
   * @returns {{ subject: string, paragraphs: string[] }} De mail.
   */
  function compose(settings, configured, language, values) {
    const step = STEPS.find((candidate) => candidate.key === configured.key);
    if (language !== 'en') return composeFor(settings, step.mailType, values);
    return {
      subject: Core.fillText(DocText.text('en', `mail.reminder${step.textKey}Subject`), values).replace(/\s+/g, ' ').trim(),
      paragraphs: Core.fillText(DocText.text('en', `mail.reminder${step.textKey}Body`), values).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean),
    };
  }

  /**
   * Verstuurt de herinneringen die in één omgeving aan de beurt zijn.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} [today] De dag als JJJJ-MM-DD (tests).
   * @returns {Promise<{ sent: number, skipped: number, failed: number }>} Aantallen.
   */
  async function runEnvironment(tenantId, today = Core.today()) {
    const result = { sent: 0, skipped: 0, failed: 0 };
    if (!enabled(tenantId)) return result;
    const settings = settingsFor(tenantId);
    const config = settings.get('paymentReminders');
    if (!config || !config.enabled) return result;
    const activeSteps = config.steps.filter((step) => step.enabled);
    if (!activeSteps.length) return result;
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return result;
    const profile = settings.get('quoteProfile') || {};
    // Zonder IBAN zou de mail een lege zin bevatten: niet versturen, de stappen blijven openstaan tot het profiel compleet is.
    if (!String(profile.iban || '').trim()) {
      console.warn(`Betalingsherinneringen staan aan, maar er is geen IBAN in het bedrijfsprofiel (omgeving ${tenantId}): niets verstuurd.`);
      return result;
    }
    const newestDue = Core.addDays(today, -activeSteps[0].days);
    const oldestDue = Core.addDays(today, -config.stopAfterDays);
    const lastStepKey = activeSteps[activeSteps.length - 1].key;
    let budget = MAILS_PER_RUN;
    let transientFailures = 0;
    let cursor = null;
    // Pagina's met een cursor, zodat afgehandelde of uitgezette facturen nieuwere niet verdringen.
    for (;;) {
      const candidates = reminders.candidates(tenantId, newestDue, oldestDue, lastStepKey, cursor);
      if (!candidates.length || budget <= 0) break;
      cursor = { dueDate: candidates[candidates.length - 1].dueDate, id: candidates[candidates.length - 1].id };
      const optedOut = reminders.optedOut(userTenantsOf(tenantId), candidates.map((candidate) => candidate.customerId));
      const done = reminders.byInvoice(tenantId, candidates.map((candidate) => candidate.id));
      for (const candidate of candidates) {
        if (budget <= 0) break;
        if (candidate.customerId && optedOut.has(candidate.customerId)) continue;
        const daysOverdue = daysBetween(candidate.dueDate, today);
        const due = activeSteps.filter((step) => step.days <= daysOverdue);
        if (!due.length) continue;
        const target = due[due.length - 1];
        const history = done.get(candidate.id) || [];
        if (history.some((entry) => entry.stepKey === target.key)) continue;
        // Pas een volgende mail als de vorige een paar dagen geleden is (bijvoorbeeld na het aanpassen van de dagen).
        const lastSent = history.filter((entry) => entry.status === 'verstuurd').pop();
        if (lastSent && daysBetween(lastSent.sentAt.slice(0, 10), today) < MIN_DAYS_BETWEEN_MAILS) continue;
        const invoice = invoices.get(tenantId, candidate.id);
        if (!invoice || invoice.status !== 'definitief') continue;
        /**
         * Legt de eerdere stappen die al voorbij zijn vast als overgeslagen.
         * @returns {void}
         */
        const skipEarlier = () => {
          for (const step of due.slice(0, -1)) {
            if (!history.some((entry) => entry.stepKey === step.key)) reminders.record(tenantId, invoice.id, step.key, { status: 'overgeslagen', reason: 'Factuur was al verder dan deze stap.', daysOverdue });
          }
        };
        const to = (invoice.data.customer.email || '').trim();
        if (!validEmail(to)) {
          skipEarlier();
          reminders.record(tenantId, invoice.id, target.key, { status: 'overgeslagen', reason: 'Geen geldig e-mailadres van de klant.', daysOverdue });
          result.skipped++;
          continue;
        }
        // Eerst reserveren: pas mailen als deze stap echt van ons is (nooit dubbel, ook niet bij een databasefout of herstart na het mailen).
        if (!reminders.claim(tenantId, invoice.id, target.key, daysOverdue)) continue;
        budget--;
        const values = { ...sender.values(tenantId, invoice), dagen_te_laat: String(daysOverdue) };
        const language = DocText.clean(invoice.data.language);
        const composed = compose(settings, target, language, values);
        try {
          await mailer.send({
            to: [to], replyTo: profile.email, subject: composed.subject,
            ...mailBody(profile, composed.paragraphs, undefined, mailStyleOf(settings)),
            attachments: [{ filename: `${invoice.number || 'factuur'}.pdf`, content: sender.pdfOf(tenantId, invoice), contentType: 'application/pdf' }],
          });
        } catch (error) {
          result.failed++;
          // Adres definitief geweigerd: vastleggen, anders blokkeert deze factuur elke ronde.
          if (permanentFailure(error)) {
            try {
              reminders.finish(tenantId, invoice.id, target.key, { status: 'overgeslagen', reason: mailFailure(error) });
            } catch (finishError) {
              console.error(`Betalingsherinnering ${invoice.number}: overslaan vastleggen mislukt:`, finishError.message);
            }
            continue;
          }
          // Tijdelijke fout: de reservering vrijgeven, volgende ronde opnieuw.
          try {
            reminders.release(tenantId, invoice.id, target.key);
          } catch (releaseError) {
            console.error(`Betalingsherinnering ${invoice.number}: reservering vrijgeven mislukt:`, releaseError.message);
          }
          // Afzender geweigerd of de mailserver is weg: geldt voor elke factuur, dus deze ronde stoppen.
          if (error.command === 'MAIL FROM') return result;
          transientFailures++;
          if (transientFailures >= 3) return result;
          continue;
        }
        // De mail is weg: de uitkomst vastleggen. Een databasefout hier telt niet als mailfout; de reservering blijft staan, dus geen tweede mail.
        try {
          skipEarlier();
          reminders.finish(tenantId, invoice.id, target.key, { status: 'verstuurd', sentTo: to });
        } catch (error) {
          console.error(`Betalingsherinnering ${invoice.number}: vastleggen na het mailen mislukt:`, error.message);
        }
        result.sent++;
      }
      if (candidates.length < CANDIDATE_LIMIT) break;
    }
    return result;
  }

  /**
   * Verstuurt de herinneringen in alle omgevingen (elk uur vanuit server.js).
   * @param {string[]} tenantIds Ids van de omgevingen.
   * @param {string} [today] De dag als JJJJ-MM-DD (tests).
   * @returns {Promise<Object<string, object>>} Aantallen per omgeving waar iets gebeurde.
   */
  async function runAll(tenantIds, today) {
    // Loopt de vorige ronde nog, dan overslaan: twee rondes tegelijk kunnen dezelfde factuur dubbel mailen.
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

module.exports = { sanitizePaymentReminders, createPaymentReminderStore, createPaymentReminderRunner, STEPS };
