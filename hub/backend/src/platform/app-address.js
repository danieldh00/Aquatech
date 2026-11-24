// Het openbare adres van de app (Beheer > Instellingen > Openbaar adres van de app): de basis voor klantlinks in
// mails (offerte, afspraak) en het adres van de AI-koppeling (OAuth). Los van het webadres van de webshop, maar dat
// geldt als terugval zolang dit adres leeg is.
const { cleanPublicUrl } = require('../webshop/mollie');

/**
 * Maakt de instelling `appPublicUrl` schoon: alleen { url }, https (http alleen voor localhost), zonder inloggegevens.
 * Een losse tekst (de omgevingsvariabele APP_PUBLIC_URL) telt als het adres.
 * @param {*} raw De ingevoerde of opgeslagen waarde (object met url, of een tekst).
 * @returns {{ url: string }} De schone instelling; url is leeg bij een onbruikbaar adres.
 */
function sanitizeAppAddress(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.url : raw;
  return { url: cleanPublicUrl(value) };
}

/**
 * Het openbare adres van de app voor een omgeving: het eigen adres uit de instelling, anders het webadres van de
 * webshop (Beheer > Webshop > Betalen), anders leeg. Nooit het adres uit de browser.
 * @param {{ get: Function }} settings De instellingen van de omgeving.
 * @returns {string} Het adres met slash achteraan (eventueel met pad), of een lege tekst.
 */
function appBaseOf(settings) {
  const own = cleanPublicUrl((settings.get('appPublicUrl') || {}).url);
  if (own) return own;
  return cleanPublicUrl((settings.get('shopPayment') || {}).publicUrl);
}

/**
 * Of een adres naar de eigen computer wijst (localhost of 127.0.0.1): daarmee is geen klant te misleiden, dus dat
 * adres mag voor een klantlink gebruikt worden zolang er nog geen openbaar adres is ingesteld (ontwikkeling en tests).
 * @param {string} url Het adres.
 * @returns {boolean} true bij localhost of 127.0.0.1.
 */
function isLoopbackUrl(url) {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

module.exports = { sanitizeAppAddress, appBaseOf, isLoopbackUrl };
