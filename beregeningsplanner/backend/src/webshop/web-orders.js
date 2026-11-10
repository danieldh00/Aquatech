// Bestellingen in de eigen webshop (storefront.js): een klant met een account
// plaatst een bestelling op rekening. De prijzen en de voorraad komen bij het
// afrekenen opnieuw uit de database (nooit uit de winkelwagen van de klant);
// bij het plaatsen reserveert de bestelling de voorraad (stock.reserveOrder),
// bij Verzonden boekt hij de artikelen af en bij Geannuleerd vervalt de
// reservering. Tabel web_orders (migratie 37); beheer via /api/admin/web-orders
// (Verkoop > Webshopbestellingen). Alles per omgeving (tenantId). Betalen: op rekening,
// of online via Mollie (web-payments.js): de bestelling krijgt dan `data.pay`
// (status open, betaald, mislukt of verlopen) en kan pas op Verzonden als hij
// betaald is; een onbetaalde online bestelling houdt de voorraad vast tot hij
// betaald, geannuleerd of verlopen is.
const crypto = require('crypto');
const { transaction, isPg } = require('../database/db');
const { validEmail } = require('../platform/mailer');
const Shipping = require('./shipping');
const Vat = require('./vat');
const Wholesale = require('./wholesale');

/** Statussen van een bestelling met hun weergavenaam. */
const STATUSES = { nieuw: 'Nieuw', verzonden: 'Verzonden', afgerond: 'Afgerond', geannuleerd: 'Geannuleerd' };
/** Welke status op welke mag volgen. */
const TRANSITIONS = { nieuw: ['verzonden', 'geannuleerd'], verzonden: ['afgerond'], afgerond: [], geannuleerd: [] };
/** Hoogstens zoveel regels in een winkelwagen (de wagen staat in een cookie van hooguit 4 kB). */
const MAX_LINES = 60;
/** Hoogstens zoveel stuks van één artikel per bestelling (groothandelsklanten bestellen in bulk; de beschikbare voorraad begrenst het echte aantal). */
const MAX_QTY = 9999;
/** Hoogstens zoveel bestellingen per pagina in Beheer. */
const PAGE_LIMIT = 200;
/** Hoogstens zoveel bestellingen met regels per aanvraag (de export haalt meerdere pagina's op). */
const EXPORT_LIMIT = 500;

/**
 * Tot wanneer een nieuwe bestelling de voorraad vasthoudt (8): online kort (de bewaartijd van een onbetaalde
 * bestelling), op rekening lang (dagen), of zonder einde.
 * @param {string} placedAt Moment van bestellen (ISO).
 * @param {boolean} online Of de klant online betaalt.
 * @param {{ holdHours?: number, accountHoldDays?: number }} hold De bewaartijden uit de instelling shopPayment.
 * @returns {string|null} Het moment (ISO), of null als de reservering blijft tot verzenden of annuleren.
 */
function reservedUntilOf(placedAt, online, hold) {
  const start = Date.parse(placedAt);
  if (online) return Number(hold.holdHours) > 0 ? new Date(start + Number(hold.holdHours) * 3600 * 1000).toISOString() : null;
  return Number(hold.accountHoldDays) > 0 ? new Date(start + Number(hold.accountHoldDays) * 86400 * 1000).toISOString() : null;
}

/**
 * Rondt af op twee decimalen.
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt een invoer tot getrimde tekst van hoogstens een bepaalde lengte.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte (tekens).
 * @returns {string} De opgeschoonde tekst.
 */
const clean = (value, max) => Array.from(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');

/**
 * Berekent de totalen van de regels: totaal incl. btw en per btw-tarief het
 * bedrag excl., de btw en het bedrag incl.
 * Heeft elke regel van een tarief een bedrag excl. btw (`lineExcl`, zakelijke
 * klanten), dan rekent dat tarief vanuit het bedrag excl.; anders vanuit incl.
 * @param {{ vatRate: number, lineTotal: number, lineExcl?: number }[]} lines De regels (lineTotal = incl. btw).
 * @returns {{ total: number, byRate: { rate: number, excl: number, vat: number, incl: number }[] }} De totalen.
 */
function totalsOf(lines) {
  const groups = new Map();
  for (const line of lines) {
    const group = groups.get(line.vatRate) || { incl: 0, excl: 0, exclKnown: true };
    group.incl = round2(group.incl + line.lineTotal);
    if (line.lineExcl === undefined) group.exclKnown = false; else group.excl = round2(group.excl + line.lineExcl);
    groups.set(line.vatRate, group);
  }
  const rows = [...groups].sort((left, right) => right[0] - left[0]).map(([rate, group]) => {
    if (group.exclKnown) {
      const vat = round2(group.excl * rate / 100);
      return { rate, excl: group.excl, vat, incl: round2(group.excl + vat) };
    }
    const vat = round2(group.incl - group.incl / (1 + rate / 100));
    return { rate, excl: round2(group.incl - vat), vat, incl: group.incl };
  });
  return { total: round2(rows.reduce((sum, row) => sum + row.incl, 0)), byRate: rows };
}

/**
 * Controleert de gegevens die de klant bij het afrekenen invult.
 * @param {object} raw De invoer (name, company, email, phone, street, postcode, city, note).
 * @param {{ method?: string, country?: string, group?: string }} [choice] De gekozen verzendmethode (ophalen of dpd), het land (bij ophalen is een adres niet nodig) en de klantgroep (zakelijk: bedrijfsnaam verplicht en een eventueel btw-nummer wordt gecontroleerd).
 * @returns {{ value?: object, error?: string, field?: string }} De opgeschoonde gegevens of een foutmelding.
 */
function sanitizeCheckout(raw, { method = 'dpd', country = 'NL', group = '' } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const value = {
    name: clean(input.name, 80), company: clean(input.company, 80), email: clean(input.email, 200).toLowerCase(), phone: clean(input.phone, 30),
    street: clean(input.street, 120), postcode: clean(input.postcode, 10).toUpperCase(), city: clean(input.city, 60),
    note: Array.from(String(input.note == null ? '' : input.note).replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim()).slice(0, 500).join(''),
    vatNumber: group === 'zakelijk' ? Vat.normalizeVatNumber(input.vatNumber) : '',
  };
  if (value.name.length < 2) return { error: 'Vul je naam in.', field: 'name' };
  if (!validEmail(value.email)) return { error: 'Vul een geldig e-mailadres in.', field: 'email' };
  if (group === 'zakelijk') {
    if (value.company.length < 2) return { error: 'Vul de bedrijfsnaam in.', field: 'company' };
    if (value.vatNumber && !Vat.validVatNumber(value.vatNumber)) return { error: 'Vul een geldig btw-nummer in, bijvoorbeeld NL123456789B01, of laat het leeg.', field: 'vatNumber' };
  }
  if (method === 'ophalen') return { value };
  if (value.street.length < 3) return { error: 'Vul je straat en huisnummer in.', field: 'street' };
  if (!Shipping.validPostcode(country, value.postcode)) return { error: country === 'NL' ? 'Vul een geldige postcode in, bijvoorbeeld 8071 AB.' : 'Vul een geldige postcode in.', field: 'postcode' };
  if (value.city.length < 2) return { error: 'Vul je woonplaats in.', field: 'city' };
  if (country === 'NL') value.postcode = value.postcode.replace(/^([0-9]{4})\s?([A-Z]{2})$/, '$1 $2');
  return { value };
}

/**
 * Maakt de opslag voor bestellingen van de eigen webshop.
 * @param {object} db De database.
 * @param {{ stock: object }} deps De voorraadopslag (reserveren en afboeken).
 * @returns {{ priceCart: Function, shippingQuote: Function, orderTotals: Function, place: Function, get: Function, getForUser: Function, listForUser: Function, list: Function, setStatus: Function, setTracking: Function, updateData: Function, changePay: Function, unpaidOnline: Function, onShipped: Function, onCancelled: Function, onTracking: Function }} De functies.
 */
function createWebOrderStore(db, { stock }) {
  const shippedHooks = [];
  // Haken die na het annuleren van een bestelling draaien.
  const cancelledHooks = [];
  const trackingHooks = [];
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Prijst een winkelwagen met de gegevens van nu: verkoopprijs, btw en de
   * beschikbare voorraad (stand min gereserveerd). Alleen artikelen die in de
   * webshop staan (Naar webshop aan, met verkoopprijs) tellen mee.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ code: string, qty: number }[]} wanted De gewenste artikelen en aantallen.
   * @param {{ group?: string, wholesale?: ?{ discountPct: number } }} [customer] De klantgroep: 'zakelijk' rekent met de zakelijke prijs (excl. btw, anders de verkoopprijs) en toont prijzen excl. btw. Met `wholesale` (alleen bij zakelijk) gelden ook de groothandelsvoorwaarden: staffelkorting, de vaste korting `discountPct` van de klant, verpakkingseenheid en minimale afname.
   * @returns {{ lines: object[], missing: string[], totals: object, ok: boolean, pricesExcl: boolean }} De regels (itemId, code, name, unit, unitContent, qty, available, unitExcl, vatRate, unitIncl, lineTotal, enough, weightGrams en bij zakelijk lineExcl; bij groothandel ook listExcl, discountPct, discountSource en packProblem), de codes die niet (meer) te koop zijn, de totalen, of er besteld kan worden en of de prijzen excl. btw getoond worden.
   */
  function priceCart(tenantId, wanted, { group = '', wholesale = null } = {}) {
    const business = group === 'zakelijk';
    const wholesaleTerms = business && wholesale ? wholesale : null;
    const unique = new Map();
    for (const line of wanted) {
      const code = String(line.code || '').trim().toUpperCase();
      const qty = Math.floor(Number(line.qty));
      if (code && qty >= 1) unique.set(code, Math.min(MAX_QTY, (unique.get(code) || 0) + qty));
    }
    const codes = [...unique.keys()].slice(0, MAX_LINES);
    const rows = codes.length ? prepare(`SELECT i.id, i.code, i.name, i.unit, i.on_hand, i.stock_managed, i.sale_price, i.business_price, i.vat_rate, i.weight_grams, i.variant_values, i.order_pack_size, i.order_min_qty, i.price_tiers, i.unit_content, p.name AS parent_name,
        (SELECT sp.in_stock FROM shop_products sp WHERE sp.tenant_id = i.tenant_id AND sp.id = i.shop_product_id) AS shop_in_stock,
        COALESCE((SELECT SUM(r.qty) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id), 0) AS reserved
      FROM stock_items i
      LEFT JOIN stock_items p ON p.tenant_id = i.tenant_id AND p.id = i.parent_id
      WHERE i.tenant_id = ? AND i.archived = 0 AND i.has_variants = 0 AND i.shop_sync = 1 AND i.sale_price IS NOT NULL
        AND i.code IN (${codes.map(() => '?').join(', ')})`).all(tenantId, ...codes) : [];
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const lines = [];
    const missing = [];
    for (const code of codes) {
      const row = byCode.get(code);
      if (!row) { missing.push(code); continue; }
      let values = {};
      try { values = JSON.parse(row.variant_values || '{}') || {}; } catch { values = {}; }
      const label = Object.values(values).join(' / ');
      const qty = unique.get(code);
      const vatRate = Number(row.vat_rate ?? 21);
      const listExcl = business && row.business_price != null ? Number(row.business_price) : Number(row.sale_price);
      const terms = { packSize: Number(row.order_pack_size) || 1, orderMinQty: Number(row.order_min_qty) || 1 };
      const priced = wholesaleTerms ? Wholesale.wholesalePrice(listExcl, qty, Wholesale.tiersOf(row.price_tiers), wholesaleTerms.discountPct) : null;
      const unitExcl = priced ? priced.unitExcl : listExcl;
      const unitIncl = round2(unitExcl * (1 + vatRate / 100));
      const lineExcl = round2(unitExcl * qty);
      // Zonder voorraadbeheer (stock_managed = 0) telt alleen of het artikel in de oude webshop op voorraad staat: wel = genoeg, niet = 0.
      const available = Number(row.stock_managed) === 0
        ? (row.shop_in_stock != null && !Number(row.shop_in_stock) ? 0 : qty)
        : Math.round((Number(row.on_hand) - Number(row.reserved)) * 1000) / 1000;
      lines.push({
        itemId: row.id, code: row.code, name: row.parent_name && label ? `${row.parent_name} (${label})` : row.name, unit: row.unit || 'st', qty, available,
        unitExcl, vatRate, unitIncl, lineTotal: business ? round2(lineExcl * (1 + vatRate / 100)) : round2(unitIncl * qty), enough: available >= qty,
        weightGrams: row.weight_grams == null ? null : Number(row.weight_grams), unitContent: row.unit_content == null ? null : Number(row.unit_content), ...(business ? { lineExcl } : {}),
        ...(wholesaleTerms ? { listExcl, discountPct: priced.discountPct, discountSource: priced.source, packSize: terms.packSize, minimum: Wholesale.minimumOf(terms), packProblem: Wholesale.quantityProblem(qty, terms) } : {}),
      });
    }
    return { lines, missing, totals: totalsOf(lines), ok: lines.length > 0 && !missing.length && lines.every((line) => line.enough && !line.packProblem), pricesExcl: business };
  }

  /**
   * Volgnummer van de bestelling: WEB-<jaar>-0001, per omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} year Het jaar.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, year) {
    const head = `WEB-${year}-`;
    // Alleen het hoogste volgnummer via de unieke index (tenant_id, number), niet alle bestellingen van het jaar (W-09).
    // De grenzen houden het bij nummers met een cijfer na het voorvoegsel (':' komt na '9').
    const row = prepare('SELECT MAX(CAST(substr(number, ?) AS INTEGER)) AS last FROM web_orders WHERE tenant_id = ? AND number > ? AND number < ?')
      .get(head.length + 1, tenantId, head, `${head}:`);
    const max = Number(row && row.last) || 0;
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * Telt de bestellingen die een account sinds een moment heeft geplaatst (voor de bestellimiet per account, W-12).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van het account.
   * @param {string} since ISO-moment.
   * @returns {number} Het aantal bestellingen.
   */
  function countSince(tenantId, userId, since) {
    return Number(prepare('SELECT COUNT(*) AS n FROM web_orders WHERE tenant_id = ? AND user_id = ? AND created_at > ?').get(tenantId, String(userId), since).n) || 0;
  }

  /**
   * Zet een rij om naar het formaat van de API (zonder regels).
   * @param {object} row Rij met id, number, user_id, status, customer_name, email, total, created_at en updated_at.
   * @returns {object} De bestelling.
   */
  const shape = (row) => ({
    id: row.id, number: row.number, userId: row.user_id || null, status: row.status, statusLabel: STATUSES[row.status] || row.status,
    customerName: row.customer_name, email: row.email, total: Number(row.total), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.pay_status !== undefined ? { payStatus: row.pay_status || null } : {}),
  });
  /**
   * Zet een rij met data om naar de volledige bestelling.
   * @param {object} row De rij, met data.
   * @returns {object} De bestelling met regels, adres, opmerking, totalen en verloop.
   */
  const shapeFull = (row) => {
    const data = JSON.parse(row.data);
    return { ...shape(row), lines: data.lines, customer: data.customer, address: data.address, note: data.note, totals: data.totals, history: data.history, mail: data.mail || null, shipping: data.shipping || null, customerGroup: data.customerGroup || '', vat: data.vat || null, consent: data.consent || null, invoiceError: data.invoiceError || '', shipMail: data.shipMail || null, payment: data.payment || 'op rekening', pay: data.pay || null, creditNote: data.creditNote || null, reservedUntil: data.reservedUntil || null, reservationReleasedAt: data.reservationReleasedAt || null };
  };
  const COLUMNS = 'id, number, user_id, status, customer_name, email, total, created_at, updated_at';

  /**
   * Vergrendelt de voorraadartikelen van een winkelwagen tot het einde van de
   * transactie, zodat twee gelijktijdige bestellingen niet dezelfde voorraad
   * kunnen claimen (PostgreSQL). SQLite serialiseert al via BEGIN IMMEDIATE.
   * Moet binnen een transactie lopen; vaste volgorde voorkomt deadlocks.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ code: string }[]} wanted De winkelwagen.
   * @returns {void}
   */
  function lockItems(tenantId, wanted) {
    if (!isPg(db)) return;
    const codes = [...new Set(wanted.map((line) => String(line.code || '').trim().toUpperCase()).filter(Boolean))].sort().slice(0, MAX_LINES);
    if (!codes.length) return;
    prepare(`SELECT id FROM stock_items WHERE tenant_id = ? AND code IN (${codes.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`).all(tenantId, ...codes);
  }

  /**
   * Leest de bestelling voor een wijziging; onder PostgreSQL met een rijslot tot het einde van de transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} columns De kolommen om te lezen.
   * @returns {object|undefined} De rij.
   */
  function readForUpdate(tenantId, id, columns) {
    return prepare(`SELECT ${columns} FROM web_orders WHERE tenant_id = ? AND id = ?${isPg(db) ? ' FOR UPDATE' : ''}`).get(tenantId, String(id));
  }

  /**
   * De verzendopties voor een winkelwagen: de landen, het gewicht en per methode de kosten.
   * @param {object} cart De geprijsde winkelwagen (priceCart).
   * @param {object} config De verzendinstelling (shipping.js, sanitizeShipping).
   * @param {string} country Het gekozen land (landcode).
   * @returns {{ weightGrams: number, countries: object[], options: object[] }} Gewicht, bezorgbare landen en de opties (ophalen, dpd).
   */
  function shippingQuote(cart, config, country) {
    const weightGrams = Shipping.weightOf(cart.lines, config);
    return { weightGrams, countries: Shipping.countriesOf(config), options: Shipping.optionsFor(config, { country, weightGrams, subtotal: cart.totals.total }) };
  }

  /**
   * Rekent de regels, de verzendkosten en de totalen van een bestelling uit,
   * met btw-verlegging als die van toepassing is (zie vat.js).
   * @param {object} cart De geprijsde winkelwagen (priceCart, met dezelfde klantgroep).
   * @param {object} option De gekozen verzendoptie (shippingQuote, options).
   * @param {{ group: string, country: string, vatNumber: string, approvedVatNumber?: string }} customer Klantgroep, land van aflevering, genormaliseerd btw-nummer en het door een beheerder goedgekeurde btw-nummer van het account.
   * @returns {{ lines: object[], shipping: { price: number, priceExcl: number, vatRate: number }, shifted: boolean, otherNumber: boolean, totals: object }} De regels (bij verlegging zonder btw), de verzendkosten incl. en excl. btw, of de btw is verlegd, of verleggen alleen faalt op een ander nummer dan dat van het account, en de totalen.
   */
  function orderTotals(cart, option, { group, country, vatNumber, approvedVatNumber = '' }) {
    const shifted = Vat.vatShifted({ group, method: option.method, country, vatNumber, approvedVatNumber });
    // Verleggen zou kunnen, maar niet met dit nummer: de klant krijgt uitleg bij het totaal.
    const otherNumber = !shifted && Vat.vatShiftPossible({ group, method: option.method, country, vatNumber });
    const lines = shifted ? cart.lines.map((line) => ({ ...line, vatRate: 0, unitIncl: line.unitExcl, lineTotal: line.lineExcl })) : cart.lines;
    const shippingExcl = round2(option.price / (1 + Shipping.SHIPPING_VAT_RATE / 100));
    const shippingRate = shifted ? 0 : Shipping.SHIPPING_VAT_RATE;
    const business = group === 'zakelijk';
    const shipping = { price: shifted ? shippingExcl : option.price, priceExcl: shippingExcl, vatRate: shippingRate };
    const shippingLine = option.price > 0 ? [business ? { vatRate: shippingRate, lineExcl: shippingExcl, lineTotal: shifted ? shippingExcl : round2(shippingExcl * (1 + shippingRate / 100)) } : { vatRate: shippingRate, lineTotal: option.price }] : [];
    return { lines, shipping, shifted, otherNumber, totals: totalsOf([...lines, ...shippingLine]) };
  }

  /**
   * Plaatst een bestelling: controleert prijzen, voorraad en verzending
   * opnieuw, legt de bestelling vast en reserveert de voorraad, alles in één
   * transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, group?: string, wholesale?: ?{ discountPct: number }, vatNumber?: string, vies?: object, addressUnverified?: boolean }} user De klant die bestelt, met zijn klantgroep ('zakelijk' of leeg), bij een groothandelsklant zijn vaste korting, het goedgekeurde btw-nummer van het account en de uitkomst van de VIES-controle (vies.js) als bewijs bij verlegging, en of het bezorgadres met de hand is ingevuld zonder PDOK-controle.
   * @param {object} rawFields De gegevens van het afrekenformulier (zie sanitizeCheckout, plus shippingMethod en country).
   * @param {{ code: string, qty: number }[]} wanted De winkelwagen.
   * @param {object} [shippingConfig] De verzendinstelling (shipping.js); standaard de startwaarden.
   * @param {?number} [expectedTotal] Het totaal dat de klant bevestigde; wijkt het berekende totaal af, dan volgt een fout (409) en wordt niet besteld.
   * @param {string[]} [paymentOptions] De betaalwijzen die de klant mag kiezen: 'rekening' en/of 'online'. Is er maar één, dan hoeft de klant niets te kiezen.
   * @param {{ holdHours?: number, accountHoldDays?: number }} [hold] Hoe lang de bestelling de voorraad vasthoudt: online zoveel uur, op rekening zoveel dagen (0 = tot verzenden of annuleren). Het moment komt in `data.reservedUntil`.
   * @returns {{ order?: object, error?: string, field?: string, status?: number, cart?: object }} De bestelling, of een foutmelding (met de actuele winkelwagen bij een probleem met prijs of voorraad).
   */
  function place(tenantId, user, rawFields, wanted, shippingConfig = Shipping.DEFAULT_CONFIG, expectedTotal = null, paymentOptions = ['rekening'], hold = {}) {
    const input = rawFields && typeof rawFields === 'object' ? rawFields : {};
    const method = String(input.shippingMethod || '');
    const country = method === 'ophalen' ? 'NL' : String(input.country || 'NL').toUpperCase();
    if (!['ophalen', 'dpd'].includes(method)) return { error: 'Kies een verzendmethode.', field: 'shippingMethod', status: 400 };
    const group = user.group === 'zakelijk' ? 'zakelijk' : '';
    const checked = sanitizeCheckout(input, { method, country, group });
    if (checked.error) return { error: checked.error, field: checked.field, status: 400 };
    if (input.terms !== 'ja') return { error: 'Ga akkoord met de algemene voorwaarden om te bestellen.', field: 'terms', status: 400 };
    const asked = String(input.paymentMethod || '');
    const paymentMethod = paymentOptions.length === 1 && !asked ? paymentOptions[0] : asked;
    if (!paymentOptions.includes(paymentMethod)) return { error: 'Kies hoe je wilt betalen.', field: 'paymentMethod', status: 400 };
    const online = paymentMethod === 'online';
    return transaction(db, () => {
      lockItems(tenantId, wanted);
      const cart = priceCart(tenantId, wanted, { group, wholesale: group === 'zakelijk' ? user.wholesale || null : null });
      if (!cart.lines.length) return { error: 'Je winkelwagen is leeg.', status: 409, cart };
      if (cart.lines.some((line) => line.packProblem)) return { error: 'Een artikel in je winkelwagen voldoet niet aan de verpakkingseenheid of minimale afname. Controleer je winkelwagen.', status: 409, cart };
      if (!cart.ok) return { error: 'Een artikel in je winkelwagen is niet meer in de gevraagde hoeveelheid beschikbaar. Controleer je winkelwagen.', status: 409, cart };
      const quote = shippingQuote(cart, shippingConfig, country);
      const option = quote.options.find((candidate) => candidate.method === method);
      if (!option || !option.available) return { error: option ? option.reason : 'Deze verzendmethode is niet beschikbaar.', field: 'shippingMethod', status: 400 };
      const fields = checked.value;
      const timestamp = currentTimestamp();
      const id = crypto.randomUUID();
      const reservedUntil = reservedUntilOf(timestamp, online, hold);
      if (isPg(db)) prepare('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked').get(`web-orders:${tenantId}:${timestamp.slice(0, 4)}`);
      const number = nextNumber(tenantId, timestamp.slice(0, 4));
      // De verzendkosten zijn een eigen regel in de btw-opbouw (alleen als ze niet gratis zijn).
      const calculated = orderTotals(cart, option, { group, country, vatNumber: fields.vatNumber, approvedVatNumber: user.vatNumber || '' });
      const totals = calculated.totals;
      if (expectedTotal !== null && !(Math.abs(expectedTotal - totals.total) <= 0.005)) return { error: 'Het totaal is bijgewerkt voor je invoer. Controleer het bedrag en plaats je bestelling opnieuw.', status: 409 };
      const data = {
        lines: calculated.lines.map((line) => ({ itemId: line.itemId, code: line.code, name: line.name, unit: line.unit, qty: line.qty, unitExcl: line.unitExcl, vatRate: line.vatRate, unitIncl: line.unitIncl, lineTotal: line.lineTotal, ...(line.lineExcl !== undefined ? { lineExcl: line.lineExcl } : {}) })),
        customer: { name: fields.name, company: fields.company, email: fields.email, phone: fields.phone },
        address: method === 'ophalen' ? { street: '', postcode: '', city: '', country: '' } : { street: fields.street, postcode: fields.postcode, city: fields.city, country, ...(user.addressUnverified ? { unverified: true } : {}) },
        shipping: { method, label: option.label, price: calculated.shipping.price, priceExcl: calculated.shipping.priceExcl, free: option.free && method === 'dpd', vatRate: calculated.shipping.vatRate, weightGrams: quote.weightGrams, tracking: null },
        customerGroup: group, vat: group === 'zakelijk' ? { number: fields.vatNumber, shifted: calculated.shifted, ...(calculated.shifted && user.vies ? { vies: user.vies } : {}) } : null,
        note: fields.note, totals, payment: online ? 'online' : 'op rekening', consent: { terms: true, at: timestamp },
        ...(online ? { pay: { provider: 'mollie', status: 'open', id: null, ids: [], checkoutUrl: '', createdAt: timestamp, paidAt: null } } : {}),
        ...(reservedUntil ? { reservedUntil } : {}),
        history: [{ at: timestamp, status: 'nieuw', by: fields.name }],
      };
      prepare(`INSERT INTO web_orders (id, tenant_id, number, user_id, status, customer_name, email, total, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'nieuw', ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, number, user.id, fields.company || fields.name, fields.email, totals.total, JSON.stringify(data), timestamp, timestamp);
      stock.reserveOrder(tenantId, id, cart.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })));
      return { order: shapeFull(prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND id = ?`).get(tenantId, id)) };
    });
  }

  /**
   * Eén bestelling met regels.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @returns {object|null} De bestelling, of null.
   */
  function get(tenantId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return row ? shapeFull(row) : null;
  }

  /**
   * Eén bestelling van een klant (een ander account krijgt niets).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de klant.
   * @param {string} id Id van de bestelling.
   * @returns {object|null} De bestelling, of null.
   */
  function getForUser(tenantId, userId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND user_id = ? AND id = ?`).get(tenantId, String(userId), String(id));
    return row ? shapeFull(row) : null;
  }

  /**
   * De bestellingen van één klant, nieuwste eerst (zonder regels; het detail haalt getForUser op).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de klant.
   * @param {{ limit?: number, offset?: number }} [paging] Hoogstens zoveel bestellingen (standaard 25, ten hoogste 200) vanaf deze plek.
   * @returns {{ items: object[], total: number }} De bestellingen (id, nummer, status, totaal, datum) van deze pagina en het totaal aantal.
   */
  function listForUser(tenantId, userId, { limit = 25, offset = 0 } = {}) {
    const size = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 25));
    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const total = Number(prepare('SELECT COUNT(*) AS n FROM web_orders WHERE tenant_id = ? AND user_id = ?').get(tenantId, String(userId)).n);
    const items = prepare(`SELECT ${COLUMNS} FROM web_orders WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`).all(tenantId, String(userId), size, start).map(shape);
    return { items, total };
  }

  /**
   * Bestellingen voor Beheer, nieuwste eerst, met een telling per status.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ status?: string, query?: string, limit?: number, offset?: number, withLines?: boolean }} [options] Filter op status en zoekterm (nummer, naam of e-mail), paginering en of de regels meekomen (export).
   * @returns {{ total: number, items: object[], counts: Object<string, number> }} Aantal, bestellingen en aantal per status.
   */
  function list(tenantId, { status = '', query = '', limit = 50, offset = 0, withLines = false } = {}) {
    const where = ['tenant_id = ?'];
    const args = [tenantId];
    if (STATUSES[status]) { where.push('status = ?'); args.push(status); }
    const words = String(query || '').replace(/[%_\\]/g, ' ').trim().toLowerCase().slice(0, 80);
    if (words) { where.push('(lower(number) LIKE ? OR lower(customer_name) LIKE ? OR lower(email) LIKE ?)'); args.push(`%${words}%`, `%${words}%`, `%${words}%`); }
    const cap = withLines ? EXPORT_LIMIT : PAGE_LIMIT;
    const size = Math.min(cap, Math.max(1, Math.floor(Number(limit)) || 50));
    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const clause = where.join(' AND ');
    const total = Number(prepare(`SELECT COUNT(*) AS n FROM web_orders WHERE ${clause}`).get(...args).n);
    const payStatus = isPg(db) ? "((data)::jsonb -> 'pay' ->> 'status')" : "json_extract(data, '$.pay.status')";
    const rows = prepare(`SELECT ${COLUMNS}${withLines ? ', data' : `, ${payStatus} AS pay_status`} FROM web_orders WHERE ${clause} ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`).all(...args, size, start);
    const counts = Object.fromEntries(Object.keys(STATUSES).map((key) => [key, 0]));
    for (const row of prepare('SELECT status, COUNT(*) AS n FROM web_orders WHERE tenant_id = ? GROUP BY status').all(tenantId)) counts[row.status] = Number(row.n);
    return { total, items: rows.map((row) => (withLines ? shapeFull(row) : shape(row))), counts };
  }

  /**
   * Zet een bestelling op een nieuwe status. Verzonden boekt de artikelen af
   * van de voorraad, Geannuleerd laat de reservering vervallen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} status De nieuwe status.
   * @param {{ id: string, display_name?: string }|null} user Wie de status wijzigt.
   * @param {{ trackingCode?: string }} [options] Bij Verzonden: de volgcode van DPD (leeg mag).
   * @returns {{ order?: object, error?: string, status?: number }} De bijgewerkte bestelling of een foutmelding.
   */
  function setStatus(tenantId, id, status, user, { trackingCode = '' } = {}) {
    const out = changeStatus(tenantId, id, status, user, { trackingCode });
    if (out.order && status === 'verzonden') {
      for (const hook of shippedHooks) {
        try { Promise.resolve(hook(tenantId, out.order, user)).catch((error) => console.warn(`Na verzenden: ${error.message}`)); } catch (error) { console.warn(`Na verzenden: ${error.message}`); }
      }
    }
    if (out.order && status === 'geannuleerd') {
      for (const hook of cancelledHooks) {
        try { Promise.resolve(hook(tenantId, out.order, user)).catch((error) => console.warn(`Na annuleren: ${error.message}`)); } catch (error) { console.warn(`Na annuleren: ${error.message}`); }
      }
    }
    return out;
  }

  /**
   * Registreert een haak die na elke bestelling die wordt geannuleerd wordt aangeroepen (nadat de wijziging is vastgelegd).
   * @param {Function} hook Functie (tenantId, order, user); mag een belofte geven, fouten worden alleen gelogd.
   * @returns {void}
   */
  const onCancelled = (hook) => { cancelledHooks.push(hook); };

  /**
   * Registreert een haak die na elke bestelling die op Verzonden gaat wordt aangeroepen (nadat de wijziging is vastgelegd).
   * @param {Function} hook Functie (tenantId, order, user); mag een belofte geven, fouten worden alleen gelogd.
   * @returns {void}
   */
  const onShipped = (hook) => { shippedHooks.push(hook); };

  /**
   * Registreert een haak die wordt aangeroepen als bij een verzonden bestelling een (nieuwe) volgcode is vastgelegd.
   * @param {Function} hook Functie (tenantId, order); mag een belofte geven, fouten worden alleen gelogd.
   * @returns {void}
   */
  const onTracking = (hook) => { trackingHooks.push(hook); };

  /**
   * Legt de nieuwe status vast in één transactie (zie setStatus).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} status De nieuwe status.
   * @param {object|null} user Wie de status wijzigt.
   * @param {{ trackingCode?: string }} options De volgcode bij Verzonden.
   * @returns {{ order?: object, error?: string, status?: number }} De bijgewerkte bestelling of een foutmelding.
   */
  function changeStatus(tenantId, id, status, user, { trackingCode }) {
    if (!STATUSES[status]) return { error: 'Onbekende status.', status: 400 };
    const tracking = String(trackingCode || '').trim() ? Shipping.trackingOf(trackingCode) : null;
    if (String(trackingCode || '').trim() && !tracking) return { error: 'Ongeldige volgcode (6 tot 40 letters, cijfers of streepjes).', status: 400 };
    return transaction(db, () => {
      const row = readForUpdate(tenantId, id, `${COLUMNS}, data`);
      if (!row) return { error: 'Bestelling niet gevonden.', status: 404 };
      if (!TRANSITIONS[row.status].includes(status)) return { error: `Een bestelling met status ${STATUSES[row.status]} kan niet naar ${STATUSES[status]}.`, status: 409 };
      const data = JSON.parse(row.data);
      if (status === 'verzonden' && data.payment === 'online' && !(data.pay && data.pay.status === 'betaald')) return { error: 'Deze bestelling is nog niet betaald: verzenden kan pas na de betaling.', status: 409 };
      // Een vrijgegeven reservering (8): de voorraad kan intussen voor een ander gereserveerd zijn; alleen verzenden wat vrij is.
      if (status === 'verzonden' && data.reservationReleasedAt) {
        // Dezelfde rijsloten als bij het plaatsen: tot het einde van de transactie kan niemand deze voorraad reserveren.
        lockItems(tenantId, data.lines);
        const short = stock.shortageFor(tenantId, data.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })), `order:${row.id}`);
        if (short.length) return { error: `De reservering van deze bestelling was vervallen en er is niet genoeg vrije voorraad meer voor: ${short.map((item) => item.name).join(', ')}.`, status: 409 };
      }
      const timestamp = currentTimestamp();
      if (status === 'verzonden') stock.issueOrder(tenantId, { id: row.id, number: row.number }, data.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })), user);
      if (status === 'geannuleerd') stock.releaseOrder(tenantId, row.id);
      // Een al online betaalde bestelling die wordt geannuleerd moet worden terugbetaald: zichtbaar in Beheer.
      if (status === 'geannuleerd' && data.payment === 'online' && data.pay && data.pay.status === 'betaald') data.pay.refundNeeded = true;
      data.history.push({ at: timestamp, status, by: user ? user.display_name || user.displayName || '' : '' });
      if (status === 'verzonden' && tracking && data.shipping && data.shipping.method === 'dpd') data.shipping.tracking = tracking;
      prepare('UPDATE web_orders SET status = ?, data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(status, JSON.stringify(data), timestamp, tenantId, row.id);
      return { order: get(tenantId, row.id) };
    });
  }

  /**
   * Legt de volgcode (track & trace) van een bezorgde bestelling vast, of wist hem (lege code).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} trackingCode De volgcode van DPD.
   * @returns {{ order?: object, error?: string, status?: number }} De bijgewerkte bestelling of een foutmelding.
   */
  function setTracking(tenantId, id, trackingCode) {
    const out = changeTracking(tenantId, id, trackingCode);
    if (out.order && out.changed && out.order.shipping && out.order.shipping.tracking) {
      for (const hook of trackingHooks) {
        try { Promise.resolve(hook(tenantId, out.order)).catch((error) => console.warn(`Na volgcode: ${error.message}`)); } catch (error) { console.warn(`Na volgcode: ${error.message}`); }
      }
    }
    return out.error ? out : { order: out.order };
  }

  /**
   * Legt de volgcode vast in één transactie (zie setTracking).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} trackingCode De volgcode van DPD (leeg wist hem).
   * @returns {{ order?: object, changed?: boolean, error?: string, status?: number }} De bijgewerkte bestelling en of de volgcode veranderde, of een foutmelding.
   */
  function changeTracking(tenantId, id, trackingCode) {
    const wanted = String(trackingCode || '').trim();
    const tracking = wanted ? Shipping.trackingOf(wanted) : null;
    if (wanted && !tracking) return { error: 'Ongeldige volgcode (6 tot 40 letters, cijfers of streepjes).', status: 400 };
    return transaction(db, () => {
      const row = readForUpdate(tenantId, id, `${COLUMNS}, data`);
      if (!row) return { error: 'Bestelling niet gevonden.', status: 404 };
      const data = JSON.parse(row.data);
      if (!data.shipping || data.shipping.method !== 'dpd') return { error: 'Alleen bij bezorging door DPD hoort een volgcode.', status: 409 };
      if (!['verzonden', 'afgerond'].includes(row.status)) return { error: 'Een volgcode kan pas als de bestelling is verzonden.', status: 409 };
      const changed = (data.shipping.tracking ? data.shipping.tracking.code : '') !== (tracking ? tracking.code : '');
      data.shipping.tracking = tracking;
      prepare('UPDATE web_orders SET data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(data), currentTimestamp(), tenantId, row.id);
      return { order: get(tenantId, row.id), changed };
    });
  }

  /**
   * Bewaart een uitkomst bij de bestelling (bijvoorbeeld of de bevestigingsmail is verstuurd).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {object} patch Velden die in de data worden bijgewerkt (nu: mail).
   * @returns {void}
   */
  function updateData(tenantId, id, patch) {
    transaction(db, () => {
      const row = readForUpdate(tenantId, id, 'data');
      if (!row) return;
      prepare('UPDATE web_orders SET data = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify({ ...JSON.parse(row.data), ...patch }), tenantId, String(id));
    });
  }

  /**
   * Past de betaalgegevens (`data.pay`) van een online bestelling aan in één transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {Function} mutate Functie (pay, order) die de nieuwe betaalgegevens geeft, of null als er niets verandert; order is de bestelling zoals hij nu is.
   * @returns {{ order?: object, changed?: boolean, error?: string, status?: number }} De bestelling en of er iets veranderde, of een foutmelding (geen online bestelling: 409).
   */
  function changePay(tenantId, id, mutate) {
    return transaction(db, () => {
      const row = readForUpdate(tenantId, id, `${COLUMNS}, data`);
      if (!row) return { error: 'Bestelling niet gevonden.', status: 404 };
      const data = JSON.parse(row.data);
      if (data.payment !== 'online' || !data.pay) return { error: 'Dit is geen online bestelling.', status: 409 };
      const next = mutate(data.pay, shapeFull(row));
      if (!next) return { order: shapeFull(row), changed: false };
      data.pay = next;
      prepare('UPDATE web_orders SET data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(data), currentTimestamp(), tenantId, row.id);
      return { order: get(tenantId, row.id), changed: true };
    });
  }

  /**
   * De nieuwe online bestellingen die nog niet betaald zijn en ouder zijn dan een bepaald moment.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} before Tijdstip (ISO): alleen bestellingen die daarvoor zijn geplaatst.
   * @param {number} [limit] Hoogstens zoveel bestellingen (standaard 100).
   * @param {number} [skip] Zoveel oudste bestellingen overslaan (voor wie ze laat staan).
   * @returns {string[]} De id's van de bestellingen.
   */
  function unpaidOnline(tenantId, before, limit = 100, skip = 0) {
    return prepare("SELECT id FROM web_orders WHERE tenant_id = ? AND status = 'nieuw' AND created_at < ? AND data LIKE '%\"payment\":\"online\"%' AND data NOT LIKE '%\"status\":\"betaald\"%' ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(tenantId, String(before), Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(skip))).map((row) => row.id);
  }

  /**
   * Geeft de voorraad vrij van nieuwe bestellingen op rekening waarvan de reserveringstermijn (`data.reservedUntil`)
   * voorbij is (8). De bestelling blijft staan en kan nog steeds verzonden worden (dan wordt gewoon afgeboekt); alleen
   * de reservering vervalt, zodat de voorraad weer in de shop beschikbaar is. Online bestellingen lopen via
   * web-payments.expireUnpaid (die annuleert ze). Eén query voor de open bestellingen; een bestelling die al vrijgegeven
   * is telt niet opnieuw.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} [now] Het huidige moment (ISO); standaard nu.
   * @returns {{ released: number }} Het aantal vrijgegeven bestellingen.
   */
  function releaseExpired(tenantId, now = currentTimestamp()) {
    // Per pagina van 500 bladeren tot er 500 verlopen zijn: niet-verlopen bestellingen verdringen verlopen dan niet.
    const page = prepare(`SELECT id, data FROM web_orders WHERE tenant_id = ? AND status = 'nieuw' AND data LIKE '%"reservedUntil"%' AND data NOT LIKE '%"reservationReleasedAt"%' AND data NOT LIKE '%"payment":"online"%' ORDER BY created_at, id LIMIT 500 OFFSET ?`);
    const candidates = [];
    for (let offset = 0; candidates.length < 500; offset += 500) {
      const rows = page.all(tenantId, offset);
      for (const row of rows) {
        const until = JSON.parse(row.data).reservedUntil;
        if (typeof until === 'string' && until <= now && candidates.length < 500) candidates.push(row);
      }
      if (rows.length < 500) break;
    }
    let released = 0;
    for (const candidate of candidates) {
      const done = transaction(db, () => {
        const row = readForUpdate(tenantId, candidate.id, 'status, data');
        if (!row || row.status !== 'nieuw') return false;
        const data = JSON.parse(row.data);
        if (data.reservationReleasedAt || !data.reservedUntil || data.reservedUntil > now) return false;
        stock.releaseOrder(tenantId, candidate.id);
        data.reservationReleasedAt = now;
        data.history = [...(Array.isArray(data.history) ? data.history : []), { at: now, status: 'nieuw', by: 'Systeem', note: 'Reserveringstermijn voorbij: voorraad vrijgegeven' }];
        prepare('UPDATE web_orders SET data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(data), now, tenantId, candidate.id);
        return true;
      });
      if (done) released += 1;
    }
    return { released };
  }

  return { priceCart, shippingQuote, orderTotals, place, countSince, get, getForUser, listForUser, list, setStatus, setTracking, updateData, changePay, unpaidOnline, releaseExpired, onShipped, onCancelled, onTracking };
}

/**
 * Registreert de API-routes van Beheer voor bestellingen (recht `beheer`,
 * door de poort van /api/admin; alles per omgeving van de beheerder).
 * @param {object} app De Express-app.
 * @param {{ orders: object, requireJson: Function, audit: Function, invoices?: object, payments?: object, returns?: object }} ctx De opslag en hulpfuncties van de server; met invoices (web-order-invoices.js) toont Beheer de factuur en kan hij opnieuw gemaakt worden, met payments (web-payments.js) en returns kan Beheer via Mollie terugbetalen.
 * @returns {void}
 */
function registerWebOrderRoutes(app, { orders, requireJson, audit, invoices = null, payments = null, returns = null }) {
  /**
   * Geeft een afwijzing van een async handler door aan Express.
   * @param {Function} handler De async handler (req, res).
   * @returns {Function} De handler voor Express.
   */
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/api/admin/web-orders', (req, res) => {
    const out = orders.list(req.tenantId, {
      status: String(req.query.status || ''), query: String(req.query.q || ''), limit: req.query.limit, offset: req.query.offset, withLines: req.query.lines === '1',
    });
    res.json({ ...out, statuses: STATUSES });
  });

  app.get('/api/admin/web-orders/:id', (req, res) => {
    const order = orders.get(req.tenantId, req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found', message: 'Bestelling niet gevonden.' });
    res.json({ order, invoice: invoices ? invoices.invoiceFor(req.tenantId, order.id) : null });
  });

  app.post('/api/admin/web-orders/:id/invoice', wrap(async (req, res) => {
    if (!invoices) return res.status(404).json({ error: 'not_found', message: 'Facturen staan niet aan.' });
    const out = invoices.ensureInvoice(req.tenantId, req.params.id, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: 'invoice_failed', message: out.error });
    if (out.created || out.finalizedNow) audit(req, 'webshop_bestelling_factuur', { number: out.invoice.number });
    await invoices.mailIfFinalized(req.tenantId, out);
    res.json({ invoice: out.invoice, created: out.created });
  }));

  app.post('/api/admin/web-orders/:id/status', requireJson, (req, res) => {
    const out = orders.setStatus(req.tenantId, req.params.id, String(req.body?.status || ''), req.user, { trackingCode: String(req.body?.trackingCode || '') });
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_status', message: out.error });
    audit(req, 'webshop_bestelling_status', { number: out.order.number, status: out.order.status });
    res.json({ order: out.order, invoice: invoices ? invoices.invoiceFor(req.tenantId, out.order.id) : null });
  });

  // Terugbetalen via Mollie (W-05): bij een retour het bedrag van de definitieve creditnota, bij een geannuleerde bestelling wat er nog over is.
  app.post('/api/admin/web-orders/:id/refund', requireJson, wrap(async (req, res) => {
    if (!payments) return res.status(404).json({ error: 'not_found', message: 'Online betalen staat niet aan.' });
    const order = orders.get(req.tenantId, req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found', message: 'Bestelling niet gevonden.' });
    const returnId = req.body && req.body.returnId ? String(req.body.returnId) : '';
    let request;
    if (returnId) {
      const record = returns ? returns.get(req.tenantId, returnId) : null;
      if (!record || record.orderId !== order.id) return res.status(404).json({ error: 'not_found', message: 'Retour niet gevonden.' });
      const amount = invoices ? invoices.refundAmountOf(req.tenantId, record) : null;
      if (amount === null) return res.status(409).json({ error: 'no_credit', message: 'Maak eerst de creditnota (definitief); dat bedrag wordt terugbetaald.' });
      request = { amount, description: `Terugbetaling retour ${record.number}`, key: `retour:${record.id}` };
    } else {
      if (order.status !== 'geannuleerd') return res.status(409).json({ error: 'not_cancelled', message: 'Zonder retour kan alleen een geannuleerde bestelling worden terugbetaald.' });
      request = { amount: order.totals.total, description: `Terugbetaling bestelling ${order.number}`, key: 'annulering' };
    }
    const out = await payments.refund(req.tenantId, order.id, request);
    if (out.error) return res.status(out.status || 400).json({ error: 'refund_failed', message: out.error });
    audit(req, 'webshop_bestelling_terugbetaald', { number: order.number, amount: out.refund.amount, ...(returnId ? { returnId } : {}) });
    res.json({ order: out.order, refund: out.refund });
  }));

  app.post('/api/admin/web-orders/:id/tracking', requireJson, (req, res) => {
    const out = orders.setTracking(req.tenantId, req.params.id, String(req.body?.trackingCode || ''));
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_tracking', message: out.error });
    audit(req, 'webshop_bestelling_volgcode', { number: out.order.number });
    res.json({ order: out.order });
  });
}

module.exports = { createWebOrderStore, registerWebOrderRoutes, sanitizeCheckout, totalsOf, STATUSES, TRANSITIONS, MAX_QTY, MAX_LINES };
