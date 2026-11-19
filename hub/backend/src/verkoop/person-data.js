// AVG-rechten per persoon: een inzage-export (Excel) van alle persoonsgegevens van één klant, en wissen (anonimiseren)
// met respect voor de wettelijke bewaarplicht. Facturen die definitief zijn en de stukken waarop ze rusten (offerte,
// werkorder, bestelling, debiteur) blijven zeven jaar staan; al het andere dat naar de persoon herleidbaar is wordt
// geanonimiseerd of gewist. De account zelf blijft als lege huls staan (verwijzingen in bewaarde facturen), zonder inlog.
const { buildWorkbook } = require('../mcp/xlsx-writer');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');
const { transaction } = require('../database/db');

/** Naam die in de plaats komt van een gewiste persoon. */
const ANONYMOUS_NAME = 'Verwijderde persoon';
/** Voorvoegsel van de gebruikersnaam van een geanonimiseerd account. */
const ANONYMOUS_PREFIX = 'verwijderd-';
/** Hoeveel regels een tabblad van de inzage hoogstens krijgt. */
const EXPORT_LIMIT = 2000;
/** Facturen met deze status vallen onder de bewaarplicht. */
const RETAINED_INVOICE_STATUSES = ['definitief', 'betaald'];
/** Werkorders met deze status zijn nog niet afgerond. */
const OPEN_WORK_ORDER_STATUSES = ['open', 'gepland', 'bezig'];

/**
 * Parseert JSON zonder te falen.
 * @param {*} text De tekst.
 * @returns {object} Het object, of een leeg object.
 */
function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Het lege klantblok dat in een geanonimiseerd document komt.
 * @param {object} [shape] Het oude blok; alleen de sleutels die erin stonden komen terug.
 * @returns {object} Het blok zonder persoonsgegevens.
 */
function blankCustomer(shape = {}) {
  const blank = { name: ANONYMOUS_NAME };
  for (const key of Object.keys(shape)) if (key !== 'name') blank[key] = '';
  return blank;
}

/**
 * Haalt de persoonsgegevens uit het JSON-deel van een offerte, werkorder of factuur.
 * @param {object} data De gegevens.
 * @returns {object} Dezelfde gegevens zonder klantblok, afleveradres, notities en bewijs.
 */
function scrubDocumentData(data) {
  const out = { ...data };
  if (out.customer && typeof out.customer === 'object') out.customer = blankCustomer(out.customer);
  if (out.delivery && typeof out.delivery === 'object') out.delivery = { ...out.delivery, address: '' };
  if (typeof out.internalNote === 'string') out.internalNote = '';
  if (typeof out.note === 'string') out.note = '';
  if (out.vatShift && typeof out.vatShift === 'object') out.vatShift = { ...out.vatShift, number: '', name: '' };
  return out;
}

/**
 * Haalt de persoonsgegevens uit het JSON-deel van een webshopbestelling.
 * @param {object} data De gegevens van de bestelling.
 * @returns {object} Dezelfde gegevens zonder klantblok, adressen, btw-bewijs, gasttoken en mailstanden.
 */
function scrubOrderData(data) {
  const out = scrubDocumentData(data);
  out.address = {};
  if (out.billingAddress) out.billingAddress = {};
  for (const key of ['guest', 'mail', 'shipMail', 'dropshipping', 'consent', 'vat']) if (out[key]) out[key] = null;
  if (out.pay && typeof out.pay === 'object') out.pay = { ...out.pay, checkoutUrl: '' };
  return out;
}

/**
 * Maakt de AVG-functies voor één database.
 * @param {object} db De database.
 * @param {object} store De store (voor het wissen van plannen).
 * @returns {{ collect: Function, anonymize: Function, workbookFor: Function }} De functies.
 */
function createPersonData(db, store) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De opdracht.
   * @returns {object} Het statement.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Plaatsaanduidingen voor een IN-lijst.
   * @param {number} count Aantal waarden.
   * @returns {string} Bijvoorbeeld "?, ?, ?".
   */
  const marks = (count) => Array.from({ length: count }, () => '?').join(', ');
  /**
   * Maakt van een JSON-veld van een document de klantgegevens die erin staan.
   * @param {string} text Het JSON-veld.
   * @returns {object} naam, contactpersoon, adres, e-mail en telefoon (leeg waar onbekend).
   */
  const customerBlock = (text) => {
    const customer = parseJson(text).customer || {};
    return { name: customer.name || customer.company || '', contact: customer.contact || '', address: customer.address || '', email: customer.email || '', phone: customer.phone || '' };
  };

  /**
   * De gegevens die de bewaarplicht beschermen: definitieve facturen van de persoon en wat daarop rust.
   * @param {string} tenantId De omgeving.
   * @param {string} userId Id van de persoon.
   * @returns {{ invoiceIds: string[], quoteIds: Set<string>, workOrderIds: Set<string>, orderIds: Set<string>, debtorIds: Set<string> }} De te bewaren onderdelen.
   */
  function retainedOf(tenantId, userId) {
    const invoices = prepare(`SELECT id, quote_id, work_order_id, shop_order_id, debtor_id FROM invoices
      WHERE tenant_id = ? AND customer_id = ? AND status IN (${marks(RETAINED_INVOICE_STATUSES.length)})`).all(tenantId, userId, ...RETAINED_INVOICE_STATUSES);
    /**
     * De unieke waarden van één kolom uit de bewaarde facturen.
     * @param {string} field De kolom.
     * @returns {Set<string>} De waarden.
     */
    const pick = (field) => new Set(invoices.map((row) => row[field]).filter(Boolean));
    return { invoiceIds: invoices.map((row) => row.id), quoteIds: pick('quote_id'), workOrderIds: pick('work_order_id'), orderIds: pick('shop_order_id'), debtorIds: pick('debtor_id') };
  }

  /**
   * Alle persoonsgegevens van een klant in een omgeving, per soort.
   * @param {string} tenantId De omgeving waarin de documenten staan.
   * @param {object} customer De klant (uit store.getCustomer).
   * @returns {object} Per soort een lijst regels: quotes, workOrders, invoices, orders, returns, requests, plans, debtors, alerts en log.
   */
  function collectIn(tenantId, customer) {
    const userId = customer.id;
    const email = String(customer.email || '').toLowerCase();
    const limit = ` LIMIT ${EXPORT_LIMIT}`;
    const quotes = prepare(`SELECT number, status, title, customer, total_incl, created_at, sent_to, data FROM quotes
      WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL ORDER BY created_at DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ number: row.number, status: row.status, title: row.title, total: Number(row.total_incl) || 0, createdAt: row.created_at, sentTo: row.sent_to || '', ...customerBlock(row.data) }));
    const workOrders = prepare(`SELECT w.number, w.status, w.title, w.customer, w.address, w.planned_date, w.created_at, w.data FROM work_orders w
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND (w.customer_id = ?
        OR w.quote_id IN (SELECT q.id FROM quotes q WHERE q.tenant_id = w.tenant_id AND q.customer_id = ?)
        OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))
      ORDER BY w.created_at DESC${limit}`).all(tenantId, userId, userId, userId)
      .map((row) => ({ number: row.number, status: row.status, title: row.title, plannedDate: row.planned_date || '', createdAt: row.created_at, ...customerBlock(row.data), address: row.address || customerBlock(row.data).address }));
    const invoices = prepare(`SELECT number, status, kind, customer_name, total, invoice_date, due_date, data FROM invoices
      WHERE tenant_id = ? AND customer_id = ? ORDER BY invoice_date DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ number: row.number || '', status: row.status, kind: row.kind, total: Number(row.total) || 0, invoiceDate: row.invoice_date, dueDate: row.due_date, ...customerBlock(row.data), name: row.customer_name || customerBlock(row.data).name }));
    const orders = prepare(`SELECT number, status, customer_name, email, total, created_at, data FROM web_orders
      WHERE tenant_id = ? AND (user_id = ?${email ? ' OR (user_id IS NULL AND lower(email) = ?)' : ''}) ORDER BY created_at DESC${limit}`)
      .all(tenantId, userId, ...(email ? [email] : []))
      .map((row) => {
        const data = parseJson(row.data);
        const address = data.address && typeof data.address === 'object' ? Object.values(data.address).filter(Boolean).join(', ') : String(data.address || '');
        return { number: row.number, status: row.status, name: row.customer_name, email: row.email, phone: (data.customer || {}).phone || '', address, total: Number(row.total) || 0, createdAt: row.created_at };
      });
    const returns = prepare(`SELECT number, status, created_at, data FROM web_returns WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ number: row.number, status: row.status, reason: parseJson(row.data).reason || '', note: parseJson(row.data).note || '', createdAt: row.created_at }));
    const requests = prepare(`SELECT number, kind, subject, description, customer_name, address, phone, email, status, created_at FROM service_requests
      WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ number: row.number, kind: row.kind, subject: row.subject, description: row.description, name: row.customer_name, address: row.address, phone: row.phone, email: row.email, status: row.status, createdAt: row.created_at }));
    const plans = prepare(`SELECT title, customer, address, created_at, deleted_at FROM plans WHERE tenant_id = ? AND owner_id = ? ORDER BY created_at DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ title: row.title, customer: row.customer, address: row.address, createdAt: row.created_at, deletedAt: row.deleted_at || '' }));
    const debtors = prepare(`SELECT number, name, contact, address, email, phone, vat_number, created_at FROM debtors
      WHERE tenant_id = ? AND (customer_id = ? OR shop_customer_id = ?) ORDER BY number${limit}`).all(tenantId, userId, userId)
      .map((row) => ({ number: Number(row.number), name: row.name, contact: row.contact, address: row.address, email: row.email, phone: row.phone, vatNumber: row.vat_number, createdAt: row.created_at }));
    const alerts = email ? prepare(`SELECT item_code, created_at FROM stock_alerts WHERE tenant_id = ? AND lower(email) = ? ORDER BY created_at DESC${limit}`).all(tenantId, email)
      .map((row) => ({ itemCode: row.item_code, createdAt: row.created_at })) : [];
    const log = prepare(`SELECT action, ip, created_at FROM audit WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC${limit}`).all(tenantId, userId)
      .map((row) => ({ action: row.action, ip: row.ip || '', createdAt: row.created_at }));
    return { quotes, workOrders, invoices, orders, returns, requests, plans, debtors, alerts, log };
  }

  /**
   * Alle persoonsgegevens van een klant, samengevoegd over de omgevingen (de live-omgeving en een testomgeving).
   * @param {string[]} tenantIds De omgevingen om in te zoeken.
   * @param {object} customer De klant.
   * @returns {object} Zoals collectIn.
   */
  function collect(tenantIds, customer) {
    const merged = {};
    for (const tenantId of [...new Set(tenantIds)]) {
      for (const [kind, rows] of Object.entries(collectIn(tenantId, customer))) merged[kind] = [...(merged[kind] || []), ...rows];
    }
    return merged;
  }

  /**
   * De Excel-inzage voor een klant: één tabblad per soort gegevens plus een toelichting.
   * @param {string[]} tenantIds De omgevingen om in te zoeken.
   * @param {object} customer De klant.
   * @param {string} organization Naam van de organisatie voor de toelichting.
   * @returns {Buffer} Het .xlsx-bestand.
   */
  function workbookFor(tenantIds, customer, organization) {
    const data = collect(tenantIds, customer);
    /**
     * Een tekstkolom voor de Excel.
     * @param {string} header Kop.
     * @param {string} key Sleutel in de rij.
     * @param {number} [width] Breedte.
     * @returns {object} De kolom.
     */
    const text = (header, key, width = 22) => ({ header, key, width, type: 'text' });
    /**
     * Een geldkolom voor de Excel.
     * @param {string} header Kop.
     * @param {string} key Sleutel in de rij.
     * @returns {object} De kolom.
     */
    const money = (header, key) => ({ header, key, width: 14, type: 'money' });
    const account = [{
      name: customer.displayName, username: customer.username, email: customer.email || '', phone: customer.phone || '', address: customer.address || '',
      company: customer.companyName || '', kvk: customer.kvkNumber || '', vat: customer.vatNumber || '', group: customer.customerGroup || 'particulier',
      language: customer.documentLanguage || 'nl', paymentDays: customer.paymentDays ?? '', createdAt: customer.createdAt || '', lastSeenAt: customer.lastSeenAt || '', hasLogin: customer.hasLogin ? 'ja' : 'nee',
    }];
    const sheets = [
      { name: 'Over deze inzage', columns: [text('Onderwerp', 'topic', 28), text('Toelichting', 'text', 110)], rows: [
        { topic: 'Organisatie', text: organization },
        { topic: 'Opgesteld op', text: new Date().toISOString().slice(0, 10) },
        { topic: 'Inhoud', text: 'Alle persoonsgegevens die onze administratie van deze persoon bevat: account, offertes, werkorders, facturen, bestellingen, retouren, meldingen, plannen, debiteurgegevens, voorraadmeldingen en inlogactiviteit.' },
        { topic: 'Niet in dit bestand', text: 'Foto\'s bij werkorders en meldingen, en wachtwoorden en beveiligingsgegevens (die staan versleuteld of als hash en zijn niet leesbaar). Vraag de beheerder om foto\'s apart aan te leveren.' },
        { topic: 'Bewaarplicht', text: 'Definitieve facturen en de stukken waarop ze rusten bewaren we zeven jaar (fiscale bewaarplicht); die kunnen niet gewist worden.' },
        { topic: 'Beperking', text: `Elk tabblad toont hoogstens ${EXPORT_LIMIT} regels (nieuwste eerst).` },
      ] },
      { name: 'Account', columns: [text('Naam', 'name'), text('Gebruikersnaam', 'username'), text('E-mail', 'email', 28), text('Telefoon', 'phone'), text('Adres', 'address', 40), text('Bedrijf', 'company'), text('KvK', 'kvk'),
        text('Btw-nummer', 'vat'), text('Klantgroep', 'group'), text('Documenttaal', 'language'), text('Betaaltermijn (dagen)', 'paymentDays'), text('Aangemaakt', 'createdAt'), text('Laatst actief', 'lastSeenAt'), text('Kan inloggen', 'hasLogin')], rows: account },
      { name: 'Offertes', columns: [text('Nummer', 'number'), text('Status', 'status'), text('Titel', 'title', 30), money('Totaal incl. btw', 'total'), text('Aangemaakt', 'createdAt'), text('Verstuurd naar', 'sentTo', 28),
        text('Naam', 'name'), text('Contactpersoon', 'contact'), text('Adres', 'address', 40), text('E-mail', 'email', 28), text('Telefoon', 'phone')], rows: data.quotes },
      { name: 'Werkorders', columns: [text('Nummer', 'number'), text('Status', 'status'), text('Omschrijving', 'title', 30), text('Gepland', 'plannedDate'), text('Aangemaakt', 'createdAt'),
        text('Naam', 'name'), text('Contactpersoon', 'contact'), text('Adres', 'address', 40), text('E-mail', 'email', 28), text('Telefoon', 'phone')], rows: data.workOrders },
      { name: 'Facturen', columns: [text('Nummer', 'number'), text('Status', 'status'), text('Soort', 'kind'), money('Totaal', 'total'), text('Factuurdatum', 'invoiceDate'), text('Vervaldatum', 'dueDate'),
        text('Naam', 'name'), text('Adres', 'address', 40), text('E-mail', 'email', 28), text('Telefoon', 'phone')], rows: data.invoices },
      { name: 'Bestellingen', columns: [text('Nummer', 'number'), text('Status', 'status'), text('Naam', 'name'), text('E-mail', 'email', 28), text('Telefoon', 'phone'), text('Adres', 'address', 40), money('Totaal', 'total'), text('Besteld op', 'createdAt')], rows: data.orders },
      { name: 'Retouren', columns: [text('Nummer', 'number'), text('Status', 'status'), text('Reden', 'reason'), text('Toelichting', 'note', 40), text('Aangevraagd', 'createdAt')], rows: data.returns },
      { name: 'Meldingen', columns: [text('Nummer', 'number'), text('Soort', 'kind'), text('Onderwerp', 'subject', 30), text('Omschrijving', 'description', 50), text('Naam', 'name'), text('Adres', 'address', 40),
        text('Telefoon', 'phone'), text('E-mail', 'email', 28), text('Status', 'status'), text('Gemeld op', 'createdAt')], rows: data.requests },
      { name: 'Plannen', columns: [text('Titel', 'title', 30), text('Klant', 'customer'), text('Adres', 'address', 40), text('Aangemaakt', 'createdAt'), text('Verwijderd op', 'deletedAt')], rows: data.plans },
      { name: 'Debiteur', columns: [text('Debiteurnummer', 'number'), text('Naam', 'name'), text('Contactpersoon', 'contact'), text('Adres', 'address', 40), text('E-mail', 'email', 28), text('Telefoon', 'phone'), text('Btw-nummer', 'vatNumber'), text('Aangemaakt', 'createdAt')], rows: data.debtors },
      { name: 'Voorraadmeldingen', columns: [text('Artikelcode', 'itemCode'), text('Aangemeld op', 'createdAt')], rows: data.alerts },
      { name: 'Inlogactiviteit', columns: [text('Actie', 'action', 30), text('IP-adres', 'ip'), text('Tijdstip', 'createdAt')], rows: data.log },
    ];
    return buildWorkbook(sheets);
  }

  /**
   * Wat een wisverzoek tegenhoudt: onafgehandelde bestellingen of werkorders van de persoon.
   * @param {string[]} tenantIds De omgevingen.
   * @param {object} customer De klant.
   * @returns {{ orders: number, workOrders: number }} Aantallen openstaande stukken.
   */
  function blockersOf(tenantIds, customer) {
    const email = String(customer.email || '').toLowerCase();
    let orders = 0;
    let workOrders = 0;
    for (const tenantId of tenantIds) {
      orders += Number(prepare(`SELECT COUNT(*) AS n FROM web_orders WHERE tenant_id = ? AND status = 'nieuw' AND (user_id = ?${email ? ' OR (user_id IS NULL AND lower(email) = ?)' : ''})`)
        .get(tenantId, customer.id, ...(email ? [email] : [])).n);
      workOrders += Number(prepare(`SELECT COUNT(*) AS n FROM work_orders w WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status IN (${marks(OPEN_WORK_ORDER_STATUSES.length)}) AND (w.customer_id = ?
        OR w.quote_id IN (SELECT q.id FROM quotes q WHERE q.tenant_id = w.tenant_id AND q.customer_id = ?))`).get(tenantId, ...OPEN_WORK_ORDER_STATUSES, customer.id, customer.id).n);
    }
    return { orders, workOrders };
  }

  /**
   * Past een JSON-veld van een rij aan met een schoonmaakfunctie.
   * @param {string} text Het huidige JSON-veld.
   * @param {Function} scrub De schoonmaakfunctie.
   * @returns {string} Het nieuwe JSON-veld.
   */
  const scrubbed = (text, scrub) => JSON.stringify(scrub(parseJson(text)));

  /**
   * Anonimiseert de gegevens van een klant in één omgeving.
   * @param {string} tenantId De omgeving.
   * @param {object} customer De klant.
   * @returns {object} Tellingen per soort: anonymized (aantal aangepast), deleted en kept (bewaard i.v.m. bewaarplicht).
   */
  function anonymizeIn(tenantId, customer) {
    const userId = customer.id;
    const email = String(customer.email || '').toLowerCase();
    const keep = retainedOf(tenantId, userId);
    const counts = { quotes: 0, workOrders: 0, invoices: 0, orders: 0, returns: 0, requests: 0, plans: 0, debtors: 0, alerts: 0, kept: { invoices: keep.invoiceIds.length, quotes: 0, workOrders: 0, orders: 0, debtors: 0 } };

    for (const row of prepare('SELECT id, data, acceptance FROM quotes WHERE tenant_id = ? AND customer_id = ?').all(tenantId, userId)) {
      if (keep.quoteIds.has(row.id)) { counts.kept.quotes += 1; continue; }
      const acceptance = row.acceptance ? JSON.stringify({ ...parseJson(row.acceptance), name: '', signature: null, reason: '' }) : null;
      prepare(`UPDATE quotes SET customer = ?, customer_id = NULL, sent_to = NULL, share_hash = NULL, share_token = NULL, share_url = NULL, acceptance = ?, data = ?
        WHERE tenant_id = ? AND id = ?`).run(ANONYMOUS_NAME, acceptance, scrubbed(row.data, scrubDocumentData), tenantId, row.id);
      counts.quotes += 1;
    }
    const workOrders = prepare(`SELECT w.id, w.data FROM work_orders w WHERE w.tenant_id = ? AND (w.customer_id = ?
      OR w.quote_id IN (SELECT q.id FROM quotes q WHERE q.tenant_id = w.tenant_id AND q.customer_id = ?))`).all(tenantId, userId, userId);
    const fromRequests = prepare(`SELECT w.id, w.data FROM work_orders w WHERE w.tenant_id = ? AND EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?)`).all(tenantId, userId);
    const seenWorkOrders = new Set();
    for (const row of [...workOrders, ...fromRequests]) {
      if (seenWorkOrders.has(row.id)) continue;
      seenWorkOrders.add(row.id);
      if (keep.workOrderIds.has(row.id)) { counts.kept.workOrders += 1; continue; }
      prepare(`UPDATE work_orders SET customer = ?, address = '', customer_id = NULL, sent_to = NULL, share_hash = NULL, share_token = NULL, share_url = NULL, appointment = NULL, data = ?
        WHERE tenant_id = ? AND id = ?`).run(ANONYMOUS_NAME, scrubbed(row.data, scrubDocumentData), tenantId, row.id);
      counts.workOrders += 1;
    }
    for (const row of prepare(`SELECT id, data FROM invoices WHERE tenant_id = ? AND customer_id = ? AND status NOT IN (${marks(RETAINED_INVOICE_STATUSES.length)})`).all(tenantId, userId, ...RETAINED_INVOICE_STATUSES)) {
      prepare('UPDATE invoices SET customer_name = ?, customer_id = NULL, data = ? WHERE tenant_id = ? AND id = ?').run(ANONYMOUS_NAME, scrubbed(row.data, scrubDocumentData), tenantId, row.id);
      counts.invoices += 1;
    }
    for (const row of prepare(`SELECT id, data FROM web_orders WHERE tenant_id = ? AND (user_id = ?${email ? ' OR (user_id IS NULL AND lower(email) = ?)' : ''})`).all(tenantId, userId, ...(email ? [email] : []))) {
      if (keep.orderIds.has(row.id)) { counts.kept.orders += 1; continue; }
      prepare("UPDATE web_orders SET user_id = NULL, customer_name = ?, email = '', data = ? WHERE tenant_id = ? AND id = ?").run(ANONYMOUS_NAME, scrubbed(row.data, scrubOrderData), tenantId, row.id);
      counts.orders += 1;
    }
    for (const row of prepare('SELECT id, data FROM web_returns WHERE tenant_id = ? AND user_id = ?').all(tenantId, userId)) {
      prepare('UPDATE web_returns SET user_id = NULL, data = ? WHERE tenant_id = ? AND id = ?').run(scrubbed(row.data, (data) => ({ ...data, note: '', decisionNote: '' })), tenantId, row.id);
      counts.returns += 1;
    }
    const requestIds = prepare('SELECT id FROM service_requests WHERE tenant_id = ? AND customer_id = ?').all(tenantId, userId).map((row) => row.id);
    if (requestIds.length) prepare(`DELETE FROM service_request_photos WHERE tenant_id = ? AND request_id IN (${marks(requestIds.length)})`).run(tenantId, ...requestIds);
    counts.requests = prepare(`UPDATE service_requests SET customer_id = NULL, customer_name = ?, description = '', address = '', phone = '', email = '', preferred = '', reply = '', note = ''
      WHERE tenant_id = ? AND customer_id = ?`).run(ANONYMOUS_NAME, tenantId, userId).changes;
    for (const plan of prepare('SELECT id FROM plans WHERE tenant_id = ? AND owner_id = ?').all(tenantId, userId)) {
      if (store.purgePlan(tenantId, plan.id)) counts.plans += 1;
    }
    for (const row of prepare('SELECT id FROM debtors WHERE tenant_id = ? AND (customer_id = ? OR shop_customer_id = ?)').all(tenantId, userId, userId)) {
      if (keep.debtorIds.has(row.id)) { counts.kept.debtors += 1; continue; }
      prepare(`UPDATE debtors SET name = ?, contact = '', address = '', email = '', phone = '', vat_number = '', match_key = '', customer_id = NULL, shop_customer_id = NULL
        WHERE tenant_id = ? AND id = ?`).run(ANONYMOUS_NAME, tenantId, row.id);
      counts.debtors += 1;
    }
    if (email) counts.alerts = prepare('DELETE FROM stock_alerts WHERE tenant_id = ? AND lower(email) = ?').run(tenantId, email).changes;
    prepare("UPDATE audit SET ip = '' WHERE tenant_id = ? AND user_id = ?").run(tenantId, userId);
    prepare("UPDATE history SET ip = '' WHERE tenant_id = ? AND user_id = ?").run(tenantId, userId);
    return counts;
  }

  /**
   * Anonimiseert een klant: het account wordt een lege huls zonder inlog, de gegevens in andere stukken worden geanonimiseerd of gewist,
   * behalve wat de bewaarplicht beschermt (definitieve facturen en de stukken waarop ze rusten).
   * @param {string[]} tenantIds De omgevingen waarin gegevens van de klant kunnen staan.
   * @param {object} customer De klant (uit store.getCustomer).
   * @returns {object} Telling per soort (aangepast of gewist) en `kept` (bewaard i.v.m. bewaarplicht).
   */
  function anonymize(tenantIds, customer) {
    return transaction(db, () => {
      const total = { quotes: 0, workOrders: 0, invoices: 0, orders: 0, returns: 0, requests: 0, plans: 0, debtors: 0, alerts: 0, kept: { invoices: 0, quotes: 0, workOrders: 0, orders: 0, debtors: 0 } };
      for (const tenantId of [...new Set(tenantIds)]) {
        const counts = anonymizeIn(tenantId, customer);
        for (const key of Object.keys(total)) if (key !== 'kept') total[key] += counts[key];
        for (const key of Object.keys(total.kept)) total.kept[key] += counts.kept[key];
      }
      const home = customer.tenantId;
      prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(home, customer.id);
      prepare('DELETE FROM account_tokens WHERE tenant_id = ? AND user_id = ?').run(home, customer.id);
      prepare('DELETE FROM oauth_grants WHERE tenant_id = ? AND user_id = ?').run(home, customer.id);
      prepare('DELETE FROM season_reminders_sent WHERE tenant_id = ? AND user_id = ?').run(home, customer.id);
      prepare(`UPDATE users SET username = ?, display_name = ?, password_hash = NULL, disabled = 1, email = '', phone = '', address = '', company_name = '', kvk_number = '',
        vat_number = '', business_request = '', customer_group = '', wholesale = 0, wholesale_discount = 0, payment_days = NULL, preferences = '{}', totp_secret = NULL,
        totp_enabled_at = NULL, totp_recovery = '[]', must_change_password = 0, email_verified_at = NULL, last_seen_at = NULL
        WHERE tenant_id = ? AND id = ?`).run(`${ANONYMOUS_PREFIX}${customer.id.slice(0, 8)}`, ANONYMOUS_NAME, home, customer.id);
      return total;
    });
  }

  return { collect, workbookFor, blockersOf, anonymize };
}

/**
 * Registreert de AVG-routes bij een klant: inzage-export en wissen.
 * @param {object} app De Express-app.
 * @param {object} ctx { store, personData (createPersonData), requireRight, requireJson, audit, tenantsOf(req), organizationName(req) }.
 * @returns {void}
 */
function registerPersonDataRoutes(app, ctx) {
  const { store, personData, requireRight, requireJson, audit, tenantsOf } = ctx;
  const requireAdmin = requireRight('beheer');
  const exportLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `avg-inzage:${req.user?.id || clientKey(req)}` });
  const eraseLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `avg-wissen:${req.user?.id || clientKey(req)}` });
  /**
   * Antwoordt 404 voor een onbekende klant.
   * @param {object} res Het antwoord.
   * @returns {object} Het verstuurde antwoord.
   */
  const unknown = (res) => res.status(404).json({ error: 'not_found', message: 'Klant niet gevonden.' });
  /**
   * De omgevingen om in te zoeken: die van de klant en de actieve omgeving van de beheerder.
   * @param {object} req Het verzoek.
   * @param {object} customer De klant.
   * @returns {string[]} De omgevingen.
   */
  const scopeOf = (req, customer) => [...new Set([customer.tenantId, req.tenantId])];

  app.get('/api/customers/:id/privacy-export', requireAdmin, exportLimiter, (req, res) => {
    const customer = store.getCustomer(tenantsOf(req), req.params.id);
    if (!customer) return unknown(res);
    const file = personData.workbookFor(scopeOf(req, customer), customer, ctx.organizationName(req));
    audit(req, 'klant_inzage_export', { userId: customer.id }, undefined, customer.tenantId);
    const name = `inzage-${customer.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.send(file);
  });

  app.post('/api/customers/:id/anonymize', requireJson, requireAdmin, eraseLimiter, (req, res) => {
    const customer = store.getCustomer(tenantsOf(req), req.params.id);
    if (!customer) return unknown(res);
    if (customer.username.startsWith(ANONYMOUS_PREFIX)) return res.status(409).json({ error: 'already_anonymized', message: 'Deze klant is al gewist.' });
    if (!req.body || String(req.body.confirm || '').trim() !== customer.displayName) {
      return res.status(409).json({ error: 'confirm_required', message: 'Typ de naam van de klant om het wissen te bevestigen.' });
    }
    const scope = scopeOf(req, customer);
    const blockers = personData.blockersOf(scope, customer);
    if (blockers.orders || blockers.workOrders) {
      return res.status(409).json({ error: 'open_items', blockers, message: `Rond eerst af wat nog openstaat: ${blockers.orders} bestelling(en) en ${blockers.workOrders} werkorder(s) van deze klant.` });
    }
    const result = personData.anonymize(scope, customer);
    audit(req, 'klant_geanonimiseerd', { userId: customer.id, ...result, kept: result.kept }, undefined, customer.tenantId);
    return res.json({ ok: true, result });
  });
}

module.exports = { createPersonData, registerPersonDataRoutes, ANONYMOUS_PREFIX, ANONYMOUS_NAME };
