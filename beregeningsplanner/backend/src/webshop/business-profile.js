// Bedrijfsgegevens van een zakelijke klant (bedrijfsnaam, KvK-nummer, btw-nummer):
// invoer controleren en normaliseren. Gedeeld door de registratie in de shop, de
// aanvraag vanaf "Mijn account" en het beheer van klanten. Een zakelijk account
// is de basis voor prijzen excl. btw en later voor de groothandel.

const Vat = require('./vat');

/** Maximale lengte van de bedrijfsnaam; gelijk aan de limiet van het afrekenformulier, zodat de naam bij het bestellen niet wordt afgekapt. */
const MAX_COMPANY_NAME = 80;
/** Een KvK-nummer heeft acht cijfers. */
const KVK_PATTERN = /^\d{8}$/;

/**
 * Controleert en normaliseert de bedrijfsgegevens uit een formulier of verzoek.
 * Bedrijfsnaam en KvK-nummer zijn verplicht, het btw-nummer is optioneel maar
 * moet kloppen als het is ingevuld.
 * @param {{ companyName?: *, kvkNumber?: *, vatNumber?: * }} input De ingevulde velden.
 * @returns {{ profile: { companyName: string, kvkNumber: string, vatNumber: string } }|{ error: string, field: string }} De gesaneerde gegevens of een foutmelding met het veld.
 */
function sanitizeBusinessProfile(input = {}) {
  const companyName = String(input.companyName ?? '').replace(/\s+/g, ' ').trim();
  if (!companyName) return { error: 'Vul de bedrijfsnaam in.', field: 'companyName' };
  if (companyName.length > MAX_COMPANY_NAME) return { error: `De bedrijfsnaam mag maximaal ${MAX_COMPANY_NAME} tekens hebben.`, field: 'companyName' };
  const kvkNumber = String(input.kvkNumber ?? '').replace(/[\s.\-]/g, '');
  if (!KVK_PATTERN.test(kvkNumber)) return { error: 'Vul een geldig KvK-nummer in (8 cijfers).', field: 'kvkNumber' };
  const vatNumber = Vat.normalizeVatNumber(input.vatNumber);
  if (vatNumber && !Vat.validVatNumber(vatNumber)) return { error: 'Vul een geldig btw-nummer in, bijvoorbeeld NL123456789B01, of laat het leeg.', field: 'vatNumber' };
  return { profile: { companyName, kvkNumber, vatNumber } };
}

/**
 * Of een formulier een zakelijk account aanvraagt (het selectievakje is aangevinkt).
 * @param {*} value De waarde van het veld `business`.
 * @returns {boolean} true bij een aangevinkt vakje.
 */
function wantsBusiness(value) {
  return value === true || value === '1' || value === 'on' || value === 'true';
}

module.exports = { sanitizeBusinessProfile, wantsBusiness };
