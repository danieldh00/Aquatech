// Offerte aanvragen vanuit de winkelwagen van een zakelijke klant: bij een grote winkelwagen kan de klant eerst een offerte vragen in
// plaats van af te rekenen. Dat maakt een concept in Offertes (nooit verstuurd, een medewerker controleert en verstuurt het zelf) en
// meldt het aan het bedrijf. De prijzen en btw komen uit dezelfde berekening als de winkelwagen (priceCart), dus nooit uit de browser.
const { mailStyleOf } = require('../platform/mail-layout');
const crypto = require('node:crypto');
const { validEmail, mailFailure } = require('../platform/mailer');

/** Binnen hoeveel minuten dezelfde winkelwagen niet opnieuw een offerte aanmaakt (dubbelklik, herladen). */
const DUPLICATE_MINUTES = 10;

const { sanitizePayment, DEFAULT_QUOTE_REQUEST_MIN } = require('./mollie');

/** Vanaf welk bedrag (excl. btw) de knop Offerte aanvragen standaard bij de winkelwagen staat (instelbaar in Beheer > Webshop > Betalen). */
const QUOTE_REQUEST_MIN_EXCL = DEFAULT_QUOTE_REQUEST_MIN;

/**
 * Het bedrag excl. btw van de regels in een geprijsde winkelwagen.
 * @param {{ lines: object[] }} cart De winkelwagen uit priceCart (zakelijk: met lineExcl per regel).
 * @returns {number} Het totaal excl. btw, in euro's.
 */
function cartExcl(cart) {
  return Math.round(cart.lines.reduce((sum, line) => sum + (Number(line.lineExcl) || 0), 0) * 100) / 100;
}

/**
 * Of een winkelwagen in aanmerking komt voor een offerteaanvraag: zakelijke prijzen, alles bestelbaar en vanaf het drempelbedrag.
 * @param {{ pricesExcl?: boolean, ok?: boolean, lines: object[] }} cart De winkelwagen uit priceCart.
 * @param {number} [minimum] Het drempelbedrag excl. btw (standaard 500).
 * @returns {boolean} true als de knop Offerte aanvragen getoond en geaccepteerd wordt.
 */
function qualifies(cart, minimum = QUOTE_REQUEST_MIN_EXCL) {
  return Boolean(cart && cart.pricesExcl && cart.ok && cart.lines.length && cartExcl(cart) >= minimum);
}

/**
 * Maakt de offerteaanvragen vanuit de winkelwagen.
 * @param {{ createDraft: Function, findRecent: Function, settingsFor: Function, mailerFor: Function, mailBody: Function }} deps createDraft(user, data, customerId) maakt een conceptofferte, findRecent(tenantId, ownerId, marker, since) zoekt een offerte van deze klant met dat merkteken sinds dat moment (beide server.js), settingsFor(tenantId) de instellingen, mailerFor de mailserver en mailBody de opmaak van de mail.
 * @returns {{ offered: Function, request: Function }} De functies.
 */
function createQuoteRequests({ createDraft, findRecent, settingsFor, mailerFor, mailBody }) {
  /**
   * Of een zakelijke winkelwagen in deze omgeving een offerte mag aanvragen: de instelling staat aan en het bedrag haalt de drempel.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} cart De geprijsde winkelwagen (zie qualifies).
   * @returns {boolean} true als de knop Offerte aanvragen getoond en geaccepteerd wordt.
   */
  const offered = (tenantId, cart) => {
    const config = sanitizePayment(settingsFor(tenantId).get('shopPayment'));
    return config.quoteRequest && qualifies(cart, config.quoteRequestMin);
  };

  /**
   * Maakt een tekst van één regel met een maximale lengte.
   * @param {*} value De invoer.
   * @param {number} max Maximale lengte.
   * @returns {string} De tekst zonder stuurtekens.
   */
  const oneLine = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  /**
   * Maakt van de winkelwagen een conceptofferte voor deze klant en meldt het aan het bedrijf.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, displayName: string, email: string }} viewer De ingelogde zakelijke klant.
   * @param {{ companyName?: string, kvkNumber?: string, vatNumber?: string }} profile De bedrijfsgegevens van de klant.
   * @param {object} cart De geprijsde winkelwagen (zie qualifies).
   * @returns {Promise<{ quote: object, mailed: boolean, duplicate?: boolean }|{ error: string, status: number }>} De offerte en of de melding is verstuurd (`duplicate`: dezelfde winkelwagen kreeg minder dan tien minuten geleden al een offerte; er wordt niets nieuws gemaakt), of de fout.
   */
  async function request(tenantId, viewer, profile, cart) {
    if (!offered(tenantId, cart)) return { error: 'Een offerte aanvragen kan niet bij deze winkelwagen.', status: 409 };
    // Dezelfde wagen (codes en aantallen) binnen tien minuten: de bestaande offerte terug, geen tweede concept of mail.
    const marker = `[aanvraag:${crypto.createHash('sha256').update(cart.lines.map((line) => `${line.code}:${line.qty}`).sort().join('|')).digest('hex').slice(0, 24)}]`;
    const recent = findRecent(tenantId, viewer.id, marker, new Date(Date.now() - DUPLICATE_MINUTES * 60 * 1000).toISOString());
    if (recent) return { quote: recent, mailed: false, duplicate: true };
    const settings = settingsFor(tenantId);
    const quoteProfile = settings.get('quoteProfile') || {};
    const lines = cart.lines.map((line) => ({ section: 'materiaal', code: oneLine(line.baseCode || line.code, 40), description: oneLine(line.name, 500), qty: line.qty, unit: oneLine(line.unit || 'st', 12), price: line.unitExcl, vat: line.vatRate }));
    const company = oneLine(profile.companyName, 120);
    const customer = { name: oneLine(viewer.displayName, 120), company, email: oneLine(viewer.email, 120) };
    const details = [company && `Bedrijf: ${company}`, profile.kvkNumber && `KvK: ${oneLine(profile.kvkNumber, 20)}`, profile.vatNumber && `Btw-nummer: ${oneLine(profile.vatNumber, 40)}`].filter(Boolean).join(' · ');
    const date = new Date().toISOString().slice(0, 10);
    const quote = createDraft({ id: viewer.id, tenant_id: tenantId }, {
      title: company ? `Aanvraag webshop – ${company}` : 'Aanvraag via de webshop', intro: quoteProfile.intro || '', terms: quoteProfile.terms || '', customer, lines, date,
      internalNote: `Aangevraagd door de klant vanuit de webshopwinkelwagen (${date}). Prijzen zijn de zakelijke webshopprijzen excl. btw; controleer ze, vul het adres aan en verstuur de offerte zelf.${details ? `\n${details}` : ''}\n${marker}`,
    }, viewer.id);
    let mailed = false;
    const mailer = mailerFor(settings);
    if (mailer.configured() && validEmail(quoteProfile.email)) {
      try {
        const mail = mailBody(quoteProfile, ['Een zakelijke klant vroeg via de webshop een offerte aan.', `Klant: ${customer.name}${company ? ` (${company})` : ''}\nE-mail: ${customer.email}\nOfferte: ${quote.number} (concept, ${cart.lines.length} ${cart.lines.length === 1 ? 'regel' : 'regels'}, ${cartExcl(cart).toFixed(2).replace('.', ',')} euro excl. btw)\n\nControleer de offerte in Offertes en verstuur hem zelf.`], undefined, mailStyleOf(settings));
        await mailer.send({ to: quoteProfile.email, subject: `Offerteaanvraag via de webshop: ${company || customer.name}`, text: mail.text, html: mail.html, replyTo: validEmail(customer.email) ? customer.email : undefined });
        mailed = true;
      } catch (error) {
        // De offerte staat al als concept; een mislukte melding komt (zonder geheimen) in het serverlog.
        mailFailure(error);
        mailed = false;
      }
    }
    return { quote, mailed };
  }

  return { offered, request };
}

module.exports = { createQuoteRequests, qualifies, cartExcl, QUOTE_REQUEST_MIN_EXCL };
