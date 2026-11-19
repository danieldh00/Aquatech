// Offerte-opvolging: krijgt een klant na het mailen van een offerte geen reactie, dan gaat er na een
// ingestelde aantal dagen vanzelf een vriendelijke herinnering uit (met de knop naar de digitale offerte).
//
// Instelling quoteFollowUp per omgeving (Beheer > Instellingen): aan/uit, na hoeveel dagen en hoeveel
// herinneringen hoogstens. Elk uur kijkt runAll welke verzonden offertes aan de beurt zijn. Per offerte
// staan het aantal herinneringen en het laatste tijdstip in quotes.followup_count/followup_at.
// Een verlopen offerte, een offerte met antwoord of zonder mailadres krijgt nooit een herinnering.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { validEmail } = require('../platform/mailer');
const { mailStyleOf } = require('../platform/mail-layout');
const { mailBody } = require('./quotes');

const DocText = require(path.join(FRONTEND_DIR, 'shared', 'doc-text.js'));
const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));

const DAY_MS = 24 * 60 * 60 * 1000;
// Hoogstens zoveel mails per omgeving per ronde; de rest volgt het uur erna.
const MAILS_PER_RUN = 50;
const DEFAULTS = { enabled: false, afterDays: 7, maxReminders: 1 };

/**
 * Schoont de instelling quoteFollowUp op.
 * @param {object} raw De ruwe invoer.
 * @returns {{ enabled: boolean, afterDays: number, maxReminders: number }} De instelling.
 */
function sanitizeQuoteFollowUp(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const afterDays = Math.floor(Number(input.afterDays));
  const maxReminders = Math.floor(Number(input.maxReminders));
  return {
    enabled: input.enabled === true,
    afterDays: Number.isFinite(afterDays) ? Math.min(60, Math.max(2, afterDays)) : DEFAULTS.afterDays,
    maxReminders: Number.isFinite(maxReminders) ? Math.min(2, Math.max(1, maxReminders)) : DEFAULTS.maxReminders,
  };
}

/**
 * Bouwt de herinneringsmail voor één offerte, in de documenttaal van de offerte.
 * @param {object} row De volledige offerterij.
 * @param {object} data De offerte-inhoud.
 * @param {string} link De openbare link naar de offerte.
 * @param {object} profile Het bedrijfsprofiel (quoteProfile).
 * @param {object} style De mailopmaak.
 * @returns {{ subject: string, text: string, html: string }} Onderwerp en inhoud.
 */
function followUpMail(row, data, link, profile, style) {
  const lang = data.language;
  /**
   * Een vaste tekst in de taal van het document.
   * @param {string} key Sleutel uit DocText.
   * @param {object} [values] Waarden voor {naam}.
   * @returns {string} De tekst.
   */
  const translate = (key, values) => DocText.text(lang, key, values);
  const validUntil = data.validUntil ? new Date(`${data.validUntil}T12:00:00Z`).toLocaleDateString(DocText.localeOf(lang), { dateStyle: 'long', timeZone: 'Europe/Amsterdam' }) : '';
  const about = data.title ? translate('mail.quoteAboutLower', { title: data.title.toLowerCase() }) : '';
  const body = mailBody(profile, [
    translate('mail.greeting', { name: data.customer?.name || translate('mail.customer') }),
    translate('mail.followUpBody', { number: row.number, about }),
    validUntil ? translate('mail.followUpValid', { date: validUntil }) : '',
    translate('mail.quoteQuestions'),
  ].filter(Boolean), { label: translate('mail.sendButton'), href: link }, style);
  return { subject: translate('mail.followUpSubject', { number: row.number }), text: body.text, html: body.html };
}

/**
 * Maakt de verzendronde voor alle omgevingen.
 * @param {object} quotes De offertestore (followUpDue, claimFollowUp, releaseFollowUp, shareLink).
 * @param {{ settingsFor: Function, mailerFor: Function, audit?: Function, enabled?: Function }} options Instellingen en mailer per omgeving, een auditfunctie en of de omgeving offertes heeft (standaard altijd).
 * @returns {{ runAll: Function, runEnvironment: Function }} De verzendfuncties.
 */
function createQuoteFollowUpRunner(quotes, { settingsFor, mailerFor, audit = () => {}, enabled = () => true }) {
  let running = false;

  /**
   * Verstuurt de herinneringen die in één omgeving aan de beurt zijn.
   * @param {string} tenantId Id van de omgeving.
   * @param {Date} [now] Het moment (tests).
   * @returns {Promise<{ sent: number, skipped: number, failed: number }>} Aantallen.
   */
  async function runEnvironment(tenantId, now = new Date()) {
    const result = { sent: 0, skipped: 0, failed: 0 };
    if (!enabled(tenantId)) return result;
    const settings = settingsFor(tenantId);
    const config = settings.get('quoteFollowUp');
    if (!config.enabled) return result;
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return result;
    const profile = settings.get('quoteProfile') || {};
    const style = mailStyleOf(settings);
    const today = Core.today(now);
    const cutoff = new Date(now.getTime() - config.afterDays * DAY_MS).toISOString();
    for (const row of quotes.followUpDue(tenantId, cutoff, config.maxReminders, MAILS_PER_RUN)) {
      const data = JSON.parse(row.data);
      const recipients = String(row.sent_to || '').split(/[,;\s]+/).filter((address) => validEmail(address));
      const link = quotes.shareLink(row);
      // Verlopen, geen bruikbaar adres of geen link: er komt nooit een herinnering; vastleggen zodat de offerte niet terugkomt.
      if ((data.validUntil && data.validUntil < today) || !recipients.length || !link) {
        quotes.claimFollowUp(row, now.toISOString(), config.maxReminders);
        result.skipped++;
        continue;
      }
      // Eerst vastleggen (alleen één ronde of server wint), dan mailen: nooit dubbel.
      if (!quotes.claimFollowUp(row, now.toISOString())) continue;
      try {
        await mailer.send({ to: recipients, replyTo: profile.email, ...followUpMail(row, data, link, profile, style) });
        result.sent++;
        audit({ tenantId, userId: null, action: 'offerte_opvolging', detail: { number: row.number, reminder: Number(row.followup_count) + 1, recipients: recipients.length } });
      } catch (error) {
        result.failed++;
        // Mislukt: de poging terugdraaien, de volgende ronde probeert het opnieuw.
        quotes.releaseFollowUp(row);
        if (error.command === 'MAIL FROM' || result.failed >= 3) return result;
      }
    }
    return result;
  }

  /**
   * Verstuurt de herinneringen in alle omgevingen (elk uur vanuit server.js).
   * @param {string[]} tenantIds Ids van de omgevingen.
   * @param {Date} [now] Het moment (tests).
   * @returns {Promise<Object<string, object>>} Aantallen per omgeving waar iets gebeurde.
   */
  async function runAll(tenantIds, now = new Date()) {
    // Loopt de vorige ronde nog, dan deze overslaan: twee rondes tegelijk kiezen dezelfde offerte.
    if (running) return {};
    running = true;
    const out = {};
    try {
      for (const tenantId of tenantIds) {
        try {
          const result = await runEnvironment(tenantId, now);
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

module.exports = { sanitizeQuoteFollowUp, createQuoteFollowUpRunner, followUpMail, DEFAULTS };
