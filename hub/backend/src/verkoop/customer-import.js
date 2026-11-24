// Klanten importeren uit Excel (V-05): de velden van het bestand, het voorbeeldbestand, de controle (wat is nieuw, wat wijzigt,
// wat klopt niet) en het verwerken. Een klant wordt gevonden op e-mailadres, anders op de naam. Een lege cel laat een bestaande
// klant ongemoeid. Dezelfde regels als de klantkaart: adres moet bij PDOK kloppen, zakelijke klanten en prijzen alleen met recht beheer.
const { sanitizeBusinessProfile } = require('../webshop/business-profile');
const { cellText, parseNumber, readTable, countStatuses } = require('../platform/excel-import');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');

/** Hoeveel klanten een import hoogstens bevat (elk adres wordt bij PDOK gecontroleerd). */
const MAX_CUSTOMERS = 500;
/** Hoeveel adressen tegelijk bij PDOK worden gecontroleerd. */
const ADDRESS_CONCURRENCY = 5;
/** Hoeveel klanten per pagina uit de database worden geladen om op te zoeken. */
const LOAD_PAGE = 200;

/** De velden van het klantenbestand: sleutel, kolomkop, synoniemen, voorbeeldwaarde en uitleg. */
const FIELDS = [
  { key: 'displayName', label: 'Naam', aliases: ['klantnaam', 'contactpersoon', 'naam klant'], required: true, example: 'Jan de Vries', hint: 'Verplicht, hoogstens 80 tekens.' },
  { key: 'email', label: 'E-mail', aliases: ['e-mailadres', 'mail', 'emailadres'], example: 'jan@voorbeeld.nl', hint: 'Hiermee wordt een bestaande klant herkend.' },
  { key: 'phone', label: 'Telefoon', aliases: ['telefoonnummer', 'tel', 'mobiel'], example: '06 12345678', hint: '' },
  { key: 'address', label: 'Adres', aliases: ['adres compleet'], example: 'Hoofdstraat 1, 8071 AB Nunspeet', hint: 'Straat, huisnummer, postcode en plaats; wordt bij PDOK gecontroleerd.' },
  { key: 'companyName', label: 'Bedrijfsnaam', aliases: ['bedrijf', 'firma'], example: '', hint: 'Alleen invullen voor een zakelijke klant (alleen een beheerder).' },
  { key: 'kvkNumber', label: 'KvK-nummer', aliases: ['kvk'], example: '', hint: '8 cijfers.' },
  { key: 'vatNumber', label: 'Btw-nummer', aliases: ['btw', 'btwnummer'], example: '', hint: 'Bijvoorbeeld NL123456789B01.' },
  { key: 'customerGroup', label: 'Klantgroep', aliases: ['groep'], example: 'particulier', hint: 'particulier of zakelijk (zakelijk alleen door een beheerder).' },
  { key: 'paymentDays', label: 'Betaaltermijn (dagen)', aliases: ['betaaltermijn', 'betaaltermijn dagen'], example: '', hint: '0 tot en met 365; leeg = standaard.' },
  { key: 'documentLanguage', label: 'Documenttaal', aliases: ['taal'], example: 'nl', hint: 'nl of en.' },
];

/** De velden die bij een wijziging met naam in het overzicht staan. */
const LABELS = Object.fromEntries(FIELDS.map((field) => [field.key, field.label]));

/**
 * Vertaalt een documenttaal uit het bestand naar nl of en.
 * @param {string} text De tekst uit de cel.
 * @returns {string|null} 'nl', 'en' of null als het niets is.
 */
function languageOf(text) {
  const key = text.toLowerCase();
  if (['nl', 'nederlands', 'dutch'].includes(key)) return 'nl';
  if (['en', 'engels', 'english'].includes(key)) return 'en';
  return null;
}

/**
 * Laadt alle klanten van de omgeving en maakt opzoeklijsten op e-mailadres en op naam.
 * @param {object} store De platformopslag.
 * @param {string} tenantId De omgeving.
 * @returns {{ byEmail: Map<string, object>, byName: Map<string, object[]> }} De lijsten.
 */
function loadCustomers(store, tenantId) {
  const byEmail = new Map();
  const byName = new Map();
  for (let offset = 0; ; offset += LOAD_PAGE) {
    const page = store.listCustomerPage([tenantId], { limit: LOAD_PAGE, offset });
    for (const customer of page.items) {
      if (customer.email) byEmail.set(customer.email.toLowerCase(), customer);
      const nameKey = customer.displayName.toLowerCase();
      byName.set(nameKey, [...(byName.get(nameKey) || []), customer]);
    }
    if (offset + LOAD_PAGE >= page.total || !page.items.length) break;
  }
  return { byEmail, byName };
}

/**
 * Saneert de cellen van één regel tot de velden die de klant moet krijgen.
 * @param {object} values De ruwe cellen per veld.
 * @param {{ mayPrice: boolean }} rights De rechten van de aanvrager.
 * @param {object|null} existing De bestaande klant als die gevonden is.
 * @returns {{ wanted: object, business: object|null, problems: string[] }} De gewenste waarden (alleen gevulde cellen), het bedrijfsprofiel en de problemen.
 */
function sanitizeRow(values, { mayPrice }, existing) {
  const { sanitizeContact } = require('./customers');
  const problems = [];
  const wanted = {};
  const name = cellText(values.displayName).replace(/\s+/g, ' ');
  if (!name) problems.push('Naam ontbreekt.');
  else if (name.length > 80) problems.push('Naam is te lang (hoogstens 80 tekens).');
  else wanted.displayName = name;
  const contactInput = {};
  for (const key of ['email', 'phone', 'address']) if (cellText(values[key])) contactInput[key] = cellText(values[key]);
  // Een adres in één regel ("Straat 1, 8071 AB Plaats") krijgt de twee regels die de app overal gebruikt.
  if (contactInput.address && !contactInput.address.includes('\n')) contactInput.address = contactInput.address.replace(/\s*,\s*(?=\d{4}\s?[A-Za-z]{2}\b)/, '\n');
  const contact = sanitizeContact(contactInput);
  if (contact.error) problems.push(contact.error);
  else Object.assign(wanted, contact.contact);
  const days = parseNumber(values.paymentDays);
  if (days === undefined || (days !== null && (!Number.isInteger(days) || days < 0 || days > 365))) problems.push('Betaaltermijn moet een heel aantal dagen van 0 tot en met 365 zijn.');
  else if (days !== null) wanted.paymentDays = days;
  if (cellText(values.documentLanguage)) {
    const language = languageOf(cellText(values.documentLanguage));
    if (!language) problems.push('Documenttaal moet nl of en zijn.');
    else wanted.documentLanguage = language;
  }
  let group = cellText(values.customerGroup).toLowerCase();
  if (group && !['particulier', 'zakelijk'].includes(group)) { problems.push('Klantgroep moet particulier of zakelijk zijn.'); group = ''; }
  const businessCells = ['companyName', 'kvkNumber', 'vatNumber'].some((key) => cellText(values[key]));
  let business = null;
  const becomesBusiness = group === 'zakelijk' || (!group && businessCells);
  if (becomesBusiness || (existing && existing.customerGroup === 'zakelijk' && businessCells)) {
    if (!mayPrice) problems.push('Alleen een beheerder importeert een zakelijke klant of wijzigt bedrijfsgegevens.');
    else {
      const checked = sanitizeBusinessProfile({
        companyName: cellText(values.companyName) || (existing && existing.companyName) || '',
        kvkNumber: cellText(values.kvkNumber) || (existing && existing.kvkNumber) || '',
        vatNumber: cellText(values.vatNumber) || (existing && existing.vatNumber) || '',
      }, { kvkRequired: false });
      if (checked.error) problems.push(checked.error);
      else business = checked.profile;
    }
  } else if (group === 'particulier' && existing && existing.customerGroup === 'zakelijk') {
    problems.push('Een zakelijke klant wordt niet via de import particulier; wijzig dat op de klantkaart.');
  }
  return { wanted, business, problems };
}

/**
 * Vergelijkt de gewenste waarden met de bestaande klant.
 * @param {object} wanted De gewenste waarden.
 * @param {object|null} business Het bedrijfsprofiel uit het bestand.
 * @param {object} existing De bestaande klant.
 * @returns {{ field: string, label: string, from: string, to: string }[]} De verschillen.
 */
function diffCustomer(wanted, business, existing) {
  const changes = [];
  /**
   * Voegt een verschil toe als de waarde anders is.
   * @param {string} field Het veld.
   * @param {*} next De nieuwe waarde.
   * @param {*} current De huidige waarde.
   * @returns {void}
   */
  const compare = (field, next, current) => {
    if (next === undefined) return;
    if (String(next ?? '') !== String(current ?? '')) changes.push({ field, label: LABELS[field], from: String(current ?? ''), to: String(next ?? '') });
  };
  for (const field of ['displayName', 'email', 'phone', 'address', 'paymentDays', 'documentLanguage']) compare(field, wanted[field], existing[field]);
  if (business) {
    compare('companyName', business.companyName, existing.companyName);
    compare('kvkNumber', business.kvkNumber, existing.kvkNumber);
    compare('vatNumber', business.vatNumber, existing.vatNumber);
    if (existing.customerGroup !== 'zakelijk') changes.push({ field: 'customerGroup', label: LABELS.customerGroup, from: 'particulier', to: 'zakelijk' });
  }
  return changes;
}

/**
 * Voert taken uit met een beperkt aantal tegelijk.
 * @param {Function[]} tasks Functies die een belofte geven.
 * @param {number} limit Hoeveel er tegelijk lopen.
 * @returns {Promise<void>}
 */
async function runPool(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const task = tasks[next++]; await task(); }
  });
  await Promise.all(workers);
}

/**
 * Controleert een klantenbestand tegen de bestaande klanten: per regel nieuw, wijzigt, ongewijzigd of fout. Schrijft niets.
 * @param {{ store: object, addressGuard: object, tenantId: string, mayPrice: boolean, body: object }} options De opslag, adrescontrole, omgeving, rechten en het verzoek ({ headers, rows }).
 * @returns {Promise<{ error: string }|{ unknown: string[], results: object[], counts: object }>} De controle of een melding. Elke regel heeft intern `plan` voor het verwerken.
 */
async function planCustomerImport({ store, addressGuard, tenantId, mayPrice, body }) {
  const table = readTable(body, FIELDS);
  if (table.error) return table;
  if (table.rows.length > MAX_CUSTOMERS) return { error: `Hoogstens ${MAX_CUSTOMERS} klanten per keer.` };
  const { byEmail, byName } = loadCustomers(store, tenantId);
  const seenEmails = new Set();
  const seenNewNames = new Set();
  const addressChecks = [];
  const results = table.rows.map(({ line, values }) => {
    const nameText = cellText(values.displayName);
    const emailKey = cellText(values.email).toLowerCase();
    let existing = null;
    let matchedBy = null;
    const problems = [];
    if (emailKey && byEmail.has(emailKey)) { existing = byEmail.get(emailKey); matchedBy = 'e-mail'; }
    else if (!emailKey && nameText) {
      const sameName = byName.get(nameText.replace(/\s+/g, ' ').toLowerCase()) || [];
      if (sameName.length === 1) { existing = sameName[0]; matchedBy = 'naam'; }
      else if (sameName.length > 1) problems.push('Er zijn meerdere klanten met deze naam; vul het e-mailadres in om de juiste te kiezen.');
    }
    const row = sanitizeRow(values, { mayPrice }, existing);
    problems.push(...row.problems);
    if (emailKey) {
      if (seenEmails.has(emailKey)) problems.push('Dit e-mailadres staat al eerder in het bestand.');
      seenEmails.add(emailKey);
    } else if (!existing && nameText) {
      const nameKey = nameText.replace(/\s+/g, ' ').toLowerCase();
      if (seenNewNames.has(nameKey)) problems.push('Deze nieuwe klant staat al eerder in het bestand (zonder e-mailadres).');
      seenNewNames.add(nameKey);
    }
    if (existing && row.wanted.email && existing.hasLogin && row.wanted.email !== existing.email && !mayPrice) problems.push('Alleen een beheerder wijzigt het e-mailadres van een klant die kan inloggen.');
    if (!existing && emailKey && row.wanted.email && byEmail.has(row.wanted.email)) problems.push('Er is al een klant met dit e-mailadres.');
    const changes = existing && !problems.length ? diffCustomer(row.wanted, row.business, existing) : [];
    const result = { line, name: row.wanted.displayName || nameText, email: row.wanted.email || '', matchedBy, problems, changes, status: 'ongewijzigd', plan: { existing, wanted: row.wanted, business: row.business } };
    if (row.wanted.address && !row.problems.length && (!existing || row.wanted.address !== existing.address)) {
      addressChecks.push(async () => {
        const verdict = await addressGuard.verify(row.wanted.address);
        if (!verdict.ok) result.problems.push(verdict.status === 503 ? 'Het adres kon nu niet worden gecontroleerd; probeer het later opnieuw.' : 'Het adres klopt niet met PDOK (postcode en huisnummer).');
      });
    }
    return result;
  });
  await runPool(addressChecks, ADDRESS_CONCURRENCY);
  for (const result of results) {
    if (result.problems.length) result.status = 'fout';
    else if (!result.plan.existing) result.status = 'nieuw';
    else result.status = result.changes.length ? 'wijzigt' : 'ongewijzigd';
  }
  return { unknown: table.unknown, results, counts: countStatuses(results) };
}

/**
 * Verwerkt de nieuwe en gewijzigde regels van een gecontroleerd bestand.
 * @param {{ store: object, tenantId: string, results: object[] }} options De opslag, omgeving en de uitkomst van planCustomerImport.
 * @returns {Promise<{ created: number, updated: number, failed: { line: number, message: string }[] }>} De aantallen.
 */
async function applyCustomerImport({ store, tenantId, results }) {
  let created = 0;
  let updated = 0;
  const failed = [];
  for (const result of results) {
    if (!['nieuw', 'wijzigt'].includes(result.status)) continue;
    const { existing, wanted, business } = result.plan;
    try {
      if (!existing) {
        const out = store.createCustomer(tenantId, { ...wanted, business });
        if (out.error) failed.push({ line: result.line, message: out.error });
        else created += 1;
      } else {
        const input = {};
        if (wanted.displayName !== undefined) input.displayName = wanted.displayName;
        const contact = {};
        for (const key of ['email', 'phone', 'address']) if (wanted[key] !== undefined) contact[key] = wanted[key];
        if (Object.keys(contact).length) input.contact = contact;
        if (business) { input.business = business; input.customerGroup = 'zakelijk'; }
        if (wanted.paymentDays !== undefined) input.paymentDays = wanted.paymentDays;
        if (wanted.documentLanguage !== undefined) input.documentLanguage = wanted.documentLanguage;
        const out = await store.updateAccount(existing.tenantId, existing.id, input);
        if (out.error) failed.push({ line: result.line, message: out.error });
        else updated += 1;
      }
    } catch (error) {
      failed.push({ line: result.line, message: 'Opslaan is mislukt.' });
    }
  }
  return { created, updated, failed };
}

/**
 * Maakt van de uitkomst van de controle het antwoord voor de browser (zonder de interne plannen).
 * @param {{ unknown: string[], results: object[], counts: object }} plan De controle.
 * @returns {object} { unknown, counts, rows }.
 */
function previewOf(plan) {
  return { unknown: plan.unknown, counts: plan.counts, rows: plan.results.map(({ line, status, name, email, matchedBy, problems, changes }) => ({ line, status, name, email, matchedBy, problems, changes })) };
}

/**
 * Registreert de routes van de klantenimport: de velden (voor het voorbeeldbestand) en de controle/verwerking.
 * @param {object} app De Express-app.
 * @param {{ store: object, requireRight: Function, requireJson: Function, audit: Function, addressGuard: object, can: Function }} ctx De afhankelijkheden (zoals bij registerCustomerRoutes).
 * @returns {void}
 */
function registerCustomerImportRoutes(app, ctx) {
  const { store, requireRight, requireJson, audit } = ctx;
  const requireCustomers = requireRight('klanten');
  const perUser = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `klantimport:${req.user?.id || clientKey(req)}` });

  app.get('/api/customers/import/fields', requireCustomers, (req, res) => {
    res.json({ max: MAX_CUSTOMERS, fields: FIELDS.map(({ key, label, required, example, hint }) => ({ key, label, required: Boolean(required), example, hint })) });
  });

  app.post('/api/customers/import', requireJson, requireCustomers, perUser, async (req, res, next) => {
    try {
      const body = req.body || {};
      const tenantId = req.tenantId;
      const plan = await planCustomerImport({ store, addressGuard: ctx.addressGuard, tenantId, mayPrice: ctx.can(req.user, 'beheer'), body });
      if (plan.error) return res.status(400).json({ error: 'invalid_import', message: plan.error });
      if (body.apply !== true) return res.json(previewOf(plan));
      if (plan.counts.fout && body.skipErrors !== true) return res.status(409).json({ error: 'has_errors', message: 'Het bestand bevat regels met fouten. Herstel ze, of verwerk alleen de goede regels.', ...previewOf(plan) });
      const done = await applyCustomerImport({ store, tenantId, results: plan.results });
      audit(req, 'klanten_geimporteerd', { aangemaakt: done.created, gewijzigd: done.updated, overgeslagen: plan.counts.fout, mislukt: done.failed.length }, undefined, tenantId);
      return res.json({ ...done, skipped: plan.counts.fout, unchanged: plan.counts.ongewijzigd });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerCustomerImportRoutes, FIELDS, MAX_CUSTOMERS, planCustomerImport, applyCustomerImport, previewOf };
