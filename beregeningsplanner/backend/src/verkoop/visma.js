// Koppeling met Visma eAccounting (Spiris), deel 3 van "Brincr vervangen".
//
// - De app (client ID en secret, sandbox of productie) is één registratie
//   voor het hele platform: instelling vismaApp + geheim vismaClientSecret in
//   de hoofdtenant, in te vullen door een hoofdbeheerder (Hoofdbeheer).
// - Elke organisatie verbindt haar eigen Visma-administratie via OAuth2
//   (knop in Facturen → Visma). Het refresh token staat versleuteld per
//   omgeving (geheim vismaRefreshToken); het access token (60 min) alleen in
//   het geheugen.
// - Doorsturen: een definitieve factuur wordt een verkoopfactuur in Visma
//   (POST /v2/customerinvoices). De debiteur wordt eerst een klant in Visma
//   (POST /v2/customers, klantnummer = debiteurnummer). Elke factuurregel
//   gaat op het Visma-artikel dat bij zijn omzetcategorie is gekozen; dat
//   artikel bepaalt in Visma de grootboekrekening en de btw. Ons
//   factuurnummer gaat mee als referentie; Visma nummert zelf.
// - Wanneer: automatisch kort na definitief (instelling visma.autoSync) en
//   elke 10 minuten, of met de knop. Alleen facturen vanaf visma.since
//   (oudere staan al in Visma, bijv. via het oude pakket).
// Alle hosts liggen vast (geen door een tenant ingevuld adres, dus geen SSRF).
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

const HOSTS = {
  production: { identity: 'https://identity.vismaonline.com', api: 'https://eaccountingapi.vismaonline.com/v2' },
  sandbox: { identity: 'https://identity-sandbox.test.vismaonline.com', api: 'https://eaccountingapi-sandbox.test.vismaonline.com/v2' },
};
const SCOPES = 'ea:api offline_access ea:sales';
const DEFAULT_REDIRECT = 'https://aquatech.den-hollander.com/api/visma/callback';
const TIMEOUT_MS = 20000;
const STATE_TTL_MS = 15 * 60 * 1000;
const BATCH = 50;
const DEBOUNCE_MS = 5000;

class VismaError extends Error {
  /**
   * Fout van de Visma-koppeling, met een code voor de frontend en de HTTP-status.
   * @param {string} code Foutcode, bijv. 'not_connected' of 'reconnect'.
   * @param {string} message Melding voor de gebruiker.
   * @param {number} [status] HTTP-status (standaard 502).
   */
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Maakt van een waarde nette tekst: getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} [maxLength] Maximaal aantal tekens (standaard 200).
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength = 200) => String(value == null ? '' : value).trim().slice(0, maxLength);
/**
 * Laat alleen een GUID door (id's in Visma).
 * @param {*} value De invoer.
 * @returns {string} De GUID, of leeg.
 */
const guid = (value) => (typeof value === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(value) ? value : '');

/**
 * Schoont de platforminstelling vismaApp op (zonder secret; dat is een eigen geheim).
 * @param {object} raw De invoer.
 * @returns {{ clientId: string, environment: string, redirectUri: string }} De app-registratie.
 */
function sanitizeVismaApp(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let redirectUri = DEFAULT_REDIRECT;
  try {
    const parsed = new URL(cleanText(input.redirectUri, 300));
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.pathname.endsWith('/api/visma/callback')) redirectUri = `${parsed.origin}${parsed.pathname}`;
  } catch { /* standaard */ }
  return {
    clientId: cleanText(input.clientId, 120).replace(/[^\w.:-]/g, ''),
    environment: input.environment === 'production' ? 'production' : 'sandbox',
    redirectUri,
  };
}

/**
 * Schoont de instelling visma per omgeving op: artikel per omzetcategorie,
 * betalingstermijn, automatisch doorsturen, vanaf welke datum, en de
 * verbonden administratie.
 * @param {object} raw De invoer.
 * @returns {object} articles, termsOfPaymentId, autoSync, since, companyName, environment, connectedAt en connectedBy.
 */
function sanitizeVisma(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const articles = {};
  if (input.articles && typeof input.articles === 'object' && !Array.isArray(input.articles)) {
    for (const group of Object.keys(Core.GROUPS)) {
      for (const rate of Core.VAT_RATES) {
        const key = Core.catKey(group, rate);
        const id = guid(input.articles[key]);
        if (id) articles[key] = id;
      }
    }
  }
  return {
    articles,
    termsOfPaymentId: guid(input.termsOfPaymentId),
    autoSync: input.autoSync === true,
    since: Core.isDate(input.since) ? input.since : '',
    companyName: cleanText(input.companyName, 200),
    environment: input.environment === 'production' ? 'production' : input.environment === 'sandbox' ? 'sandbox' : '',
    connectedAt: typeof input.connectedAt === 'string' ? input.connectedAt.slice(0, 40) : '',
    connectedBy: cleanText(input.connectedBy, 120),
  };
}

/**
 * Zet een adres (vrije regels) om naar de velden van Visma.
 * @param {string} text Het adres; de laatste regel kan een landcode zijn.
 * @returns {{ address1: string, address2: string, postal: string, city: string, country: string }} Straat, extra regels, postcode, plaats en land.
 */
function splitAddress(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let country = 'NL';
  if (lines.length > 1 && /^[A-Z]{2}$/.test(lines[lines.length - 1])) country = lines.pop();
  let postal = '';
  let city = '';
  const last = lines.length > 1 ? lines[lines.length - 1] : '';
  const match = /^(\d{4}\s?[A-Za-z]{2}|\d{4,5})\s+(.+)$/.exec(last);
  if (match) {
    postal = match[1].toUpperCase().replace(/^(\d{4})([A-Z]{2})$/, '$1 $2');
    city = match[2];
    lines.pop();
  } else if (last) {
    city = last;
    lines.pop();
  }
  return { address1: lines[0] || '', address2: lines.slice(1).join(', '), postal, city, country };
}

/**
 * Een debiteur als klant in Visma.
 * @param {object} debtor De debiteur (number, name, address, e-mail, telefoon, contact, btw-nummer).
 * @param {string} termsOfPaymentId De betalingstermijn in Visma.
 * @returns {object} De body voor POST /customers.
 */
function customerBody(debtor, termsOfPaymentId) {
  const address = splitAddress(debtor.address);
  const business = Boolean(debtor.vatNumber || debtor.contact);
  return {
    CustomerNumber: String(debtor.number),
    Name: debtor.name.slice(0, 50),
    IsPrivatePerson: !business,
    IsActive: true,
    InvoiceAddress1: address.address1.slice(0, 50),
    InvoiceAddress2: address.address2.slice(0, 50),
    InvoicePostalCode: address.postal.slice(0, 10),
    InvoiceCity: address.city.slice(0, 50),
    InvoiceCountryCode: address.country,
    EmailAddress: debtor.email || undefined,
    Telephone: debtor.phone || undefined,
    ContactPersonName: debtor.contact || undefined,
    VatNumber: debtor.vatNumber || undefined,
    TermsOfPaymentId: termsOfPaymentId,
  };
}

/**
 * Een factuur als verkoopfactuur in Visma; elke regel op het Visma-artikel van zijn omzetcategorie.
 * @param {object} invoice De factuur (met data).
 * @param {string} customerId Id van de klant in Visma.
 * @param {object} vismaSettings De instelling visma (artikelen per omzetcategorie).
 * @param {object} invoicing De factuurinstellingen (omzetcategorieën).
 * @param {string|null} [creditedInvoiceId] Visma-id van de gecrediteerde factuur.
 * @returns {{ body: object }|{ error: string }} De body voor POST /customerinvoices, of een fout als er een artikel ontbreekt.
 */
function invoiceBody(invoice, customerId, vismaSettings, invoicing, creditedInvoiceId = null) {
  const details = invoice.data;
  const address = splitAddress(details.customer.address);
  const discount = Number(details.discountPct) || 0;
  const rows = [];
  const missing = new Set();
  rows.push({ LineNumber: 0, IsTextRow: true, Text: `${invoice.kind === 'credit' ? 'Creditfactuur' : 'Factuur'} ${invoice.number}${details.reference ? ` – ${details.reference}` : ''}`.slice(0, 250) });
  for (const line of details.lines) {
    const category = Core.categoryOf(line, invoicing);
    const articleId = vismaSettings.articles[category.key];
    if (!articleId) { missing.add(category.name); continue; }
    rows.push({
      LineNumber: rows.length, ArticleId: articleId, IsTextRow: false,
      Text: `${line.description || ''}${line.code ? ` (${line.code})` : ''}`.slice(0, 250),
      UnitPrice: line.price, Quantity: line.qty, DiscountPercentage: discount ? Math.round(discount * 100) / 10000 : 0,
    });
  }
  if (missing.size) return { error: `Kies in Facturen → Visma een artikel voor: ${[...missing].join(', ')}.` };
  return {
    body: {
      CustomerId: customerId,
      InvoiceDate: details.date,
      DueDate: details.dueDate,
      IsCreditInvoice: invoice.kind === 'credit',
      ...(invoice.kind === 'credit' && creditedInvoiceId ? { CreditedInvoiceId: creditedInvoiceId } : {}),
      // Onze prijzen zijn exclusief btw; Visma rekent de btw uit het artikel.
      IncludesVat: false,
      YourReference: (details.customer.contact || '').slice(0, 50) || undefined,
      OurReference: invoice.number,
      InvoiceCustomerName: details.customer.name.slice(0, 50),
      InvoiceAddress1: address.address1.slice(0, 50),
      InvoiceAddress2: address.address2.slice(0, 50),
      InvoicePostalCode: address.postal.slice(0, 10),
      InvoiceCity: address.city.slice(0, 50),
      InvoiceCountryCode: address.country,
      CustomerIsPrivatePerson: !(details.customer.vatNumber || details.customer.contact),
      EuThirdParty: false,
      RotReducedInvoicingType: 0,
      Rows: rows,
    },
  };
}

/**
 * Maakt de Visma-koppeling: OAuth2, API-aanroepen en het doorsturen van facturen.
 * @param {object} ctx db, settingsFor(tenantId), mainTenantId, debtors, invoices, fetchImpl en log.
 * @returns {object} authorizeUrl, finishConnect, disconnect, api, options, pushInvoice, sync, run, schedule, runAll, status en app.
 */
function createVisma({ db, settingsFor, mainTenantId, debtors, invoices, fetchImpl = fetch, log = console }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const states = new Map();
  const tokens = new Map();
  const running = new Map();
  const timers = new Map();

  /**
   * De app-registratie bij Visma (platformbreed, in de hoofdtenant).
   * @returns {object} clientId, environment, redirectUri, secret, configured en hosts.
   */
  function app() {
    const settings = settingsFor(mainTenantId);
    const registration = settings.get('vismaApp');
    const secret = settings.get('vismaClientSecret');
    return { ...registration, secret, configured: Boolean(registration.clientId && secret), hosts: HOSTS[registration.environment] };
  }
  /**
   * De instelling visma van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De instelling.
   */
  const vismaSettingsOf = (tenantId) => settingsFor(tenantId).get('visma');
  /**
   * Of een omgeving met Visma verbonden is.
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} True als er een refresh token is.
   */
  const connected = (tenantId) => Boolean(settingsFor(tenantId).get('vismaRefreshToken'));

  // ---------- OAuth2 ----------
  /**
   * Begin van het verbinden: adres van de inlogpagina van Visma (met een state die 15 minuten geldig is).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de gebruiker die verbindt.
   * @returns {string} Het adres.
   */
  function authorizeUrl(tenantId, userId) {
    const registration = app();
    if (!registration.configured) throw new VismaError('not_configured', 'De Visma-koppeling is nog niet ingesteld door de hoofdbeheerder (Hoofdbeheer → Visma).', 409);
    const now = Date.now();
    for (const [key, entry] of states) if (entry.exp < now) states.delete(key);
    const state = crypto.randomBytes(24).toString('base64url');
    states.set(state, { tenantId, userId, exp: now + STATE_TTL_MS });
    const query = new URLSearchParams({ client_id: registration.clientId, redirect_uri: registration.redirectUri, scope: SCOPES, state, response_type: 'code', prompt: 'select_account' });
    return `${registration.hosts.identity}/connect/authorize?${query}`;
  }

  /**
   * Vraagt tokens op bij Visma.
   * @param {object} form De formuliervelden (grant_type en code of refresh_token).
   * @returns {Promise<object>} Het antwoord met access_token (en eventueel refresh_token).
   */
  async function tokenRequest(form) {
    const registration = app();
    let res;
    try {
      res = await fetchImpl(`${registration.hosts.identity}/connect/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${registration.clientId}:${registration.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new VismaError('unreachable', 'Visma is niet bereikbaar.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new VismaError(body.error === 'invalid_grant' ? 'reconnect' : 'token_failed',
        body.error === 'invalid_grant' ? 'De verbinding met Visma is verlopen of ingetrokken: verbind opnieuw.' : 'Visma weigert de aanmelding (controleer client ID, secret en redirect URI).');
    }
    return body;
  }

  /**
   * Terug van Visma met een code: tokens ophalen en bewaren, en de naam van de administratie onthouden.
   * @param {string} state De state uit authorizeUrl.
   * @param {string} code De code van Visma.
   * @param {{ tenantId: string, userId: string, userName: string }} session Wie terugkomt (moet bij de state horen).
   * @returns {Promise<{ companyName: string }>} De naam van de administratie.
   */
  async function finishConnect(state, code, { tenantId, userId, userName }) {
    const pending = states.get(String(state || ''));
    states.delete(String(state || ''));
    if (!pending || pending.exp < Date.now() || pending.tenantId !== tenantId || pending.userId !== userId) throw new VismaError('invalid_state', 'Deze aanmelding is verlopen of hoort niet bij jouw sessie. Probeer opnieuw te verbinden.', 400);
    if (!code || typeof code !== 'string' || code.length > 2000) throw new VismaError('invalid_code', 'Visma gaf geen geldige code terug.', 400);
    const granted = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: app().redirectUri });
    if (!granted.refresh_token) throw new VismaError('token_failed', 'Visma gaf geen refresh token (scope offline_access ontbreekt).');
    const settings = settingsFor(tenantId);
    tokens.set(tenantId, { access: granted.access_token, exp: Date.now() + (Number(granted.expires_in) || 3600) * 1000 - 60000 });
    settings.update({ vismaRefreshToken: granted.refresh_token }, userId);
    let companyName = '';
    try { companyName = cleanText((await api(tenantId, 'GET', '/companysettings')).Name); } catch { /* naam is niet nodig */ }
    settings.update({ visma: { ...vismaSettingsOf(tenantId), companyName, environment: app().environment, connectedAt: new Date().toISOString(), connectedBy: userName || '' } }, userId);
    return { companyName };
  }

  /**
   * Verbreekt de verbinding met Visma (vergeet de tokens).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de gebruiker.
   */
  function disconnect(tenantId, userId) {
    tokens.delete(tenantId);
    const settings = settingsFor(tenantId);
    settings.update({ vismaRefreshToken: '', visma: { ...vismaSettingsOf(tenantId), companyName: '', connectedAt: '', connectedBy: '', environment: '' } }, userId);
  }

  /**
   * Een geldig access token: uit het geheugen, of nieuw met het refresh token.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<string>} Het access token.
   */
  async function accessToken(tenantId) {
    const cached = tokens.get(tenantId);
    if (cached && cached.exp > Date.now()) return cached.access;
    const refresh = settingsFor(tenantId).get('vismaRefreshToken');
    if (!refresh) throw new VismaError('not_connected', 'Deze omgeving is niet verbonden met Visma.', 409);
    if (!app().configured) throw new VismaError('not_configured', 'De Visma-koppeling is nog niet ingesteld door de hoofdbeheerder.', 409);
    const granted = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    tokens.set(tenantId, { access: granted.access_token, exp: Date.now() + (Number(granted.expires_in) || 3600) * 1000 - 60000 });
    // Visma kan een nieuw refresh token geven; dan het nieuwe bewaren.
    if (granted.refresh_token && granted.refresh_token !== refresh) settingsFor(tenantId).update({ vismaRefreshToken: granted.refresh_token });
    return granted.access_token;
  }

  /**
   * Eén API-aanroep (met een nieuw access token bij 401).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} method HTTP-methode.
   * @param {string} apiPath Pad onder /v2, bijv. '/customers'.
   * @param {object} [body] De body (JSON).
   * @param {boolean} [retried] Al opnieuw geprobeerd na 401.
   * @returns {Promise<*>} Het antwoord (JSON), of null.
   */
  async function api(tenantId, method, apiPath, body, retried = false) {
    const token = await accessToken(tenantId);
    let res;
    try {
      res = await fetchImpl(`${app().hosts.api}${apiPath}`, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new VismaError('unreachable', 'Visma is niet bereikbaar.');
    }
    if (res.status === 401 && !retried) {
      tokens.delete(tenantId);
      return api(tenantId, method, apiPath, body, true);
    }
    const text = await res.text();
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch { out = null; }
    if (!res.ok) {
      const message = out && (out.Message || out.DeveloperErrorMessage || out.message);
      throw new VismaError(res.status === 403 ? 'forbidden' : 'api_error', `Visma: ${message ? String(message).slice(0, 300) : `status ${res.status}`}`);
    }
    return out;
  }
  /**
   * De lijst uit een antwoord van Visma (met of zonder Data).
   * @param {*} out Het antwoord.
   * @returns {object[]} De items.
   */
  const dataOf = (out) => (Array.isArray(out) ? out : (out && Array.isArray(out.Data) ? out.Data : []));

  /**
   * Haalt een lijst op over meerdere pagina's van 200.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} apiPath Pad onder /v2.
   * @param {number} [maxPages] Hooguit zoveel pagina's.
   * @returns {Promise<object[]>} Alle items.
   */
  async function list(tenantId, apiPath, maxPages = 10) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const out = await api(tenantId, 'GET', `${apiPath}${apiPath.includes('?') ? '&' : '?'}$page=${page}&$pagesize=200`);
      const items = dataOf(out);
      all.push(...items);
      const total = out && out.Meta ? Number(out.Meta.TotalNumberOfPages) || 1 : 1;
      if (page >= total || !items.length) break;
    }
    return all;
  }

  /**
   * Artikelen en betalingstermijnen uit Visma, om te kiezen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ articles: object[], terms: object[] }>} Actieve artikelen en betalingstermijnen.
   */
  async function options(tenantId) {
    const [articles, terms] = await Promise.all([list(tenantId, '/articles'), list(tenantId, '/termsofpayments')]);
    return {
      articles: articles.filter((article) => article.IsActive !== false).map((article) => ({ id: article.Id, number: cleanText(article.Number, 40), name: cleanText(article.Name, 120) })),
      terms: terms.map((term) => ({ id: term.Id, name: cleanText(term.Name, 120), days: Number(term.NumberOfDays) || 0 })),
    };
  }

  // ---------- Doorsturen ----------
  /**
   * Zorgt dat de debiteur als klant in Visma staat (klantnummer = debiteurnummer);
   * een bestaand klantnummer wordt alleen gekoppeld als het dezelfde klant is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} debtorId Id van de debiteur.
   * @param {object} vismaSettings De instelling visma (betalingstermijn).
   * @returns {Promise<string>} Id van de klant in Visma.
   */
  async function pushDebtor(tenantId, debtorId, vismaSettings) {
    const row = prepare('SELECT visma_customer_id FROM debtors WHERE tenant_id = ? AND id = ?').get(tenantId, debtorId);
    if (!row) throw new VismaError('no_debtor', 'De factuur heeft geen debiteur.', 409);
    if (row.visma_customer_id) return row.visma_customer_id;
    const debtor = debtors.get(tenantId, debtorId);
    if (!vismaSettings.termsOfPaymentId) throw new VismaError('no_terms', 'Kies in Facturen → Visma een betalingstermijn voor nieuwe klanten.', 409);
    // Bestaat het klantnummer al in Visma? Alleen koppelen als het dezelfde klant is.
    const found = dataOf(await api(tenantId, 'GET', `/customers?$filter=${encodeURIComponent(`CustomerNumber eq '${debtor.number}'`)}`))[0];
    let id;
    if (found) {
      if (cleanText(found.Name).toLowerCase() !== debtor.name.trim().toLowerCase()) {
        throw new VismaError('number_taken', `Klantnummer ${debtor.number} bestaat in Visma al voor "${cleanText(found.Name)}". Verhoog het eerste debiteurnummer in Facturen → Instellingen.`, 409);
      }
      id = found.Id;
    } else {
      id = (await api(tenantId, 'POST', '/customers', customerBody(debtor, vismaSettings.termsOfPaymentId))).Id;
    }
    prepare('UPDATE debtors SET visma_customer_id = ? WHERE tenant_id = ? AND id = ?').run(String(id), tenantId, debtorId);
    return String(id);
  }

  /**
   * Stuurt één factuur naar Visma; een fout komt op de factuur (visma_error).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @returns {Promise<object>} De bijgewerkte factuur. Gooit een VismaError.
   */
  async function pushInvoice(tenantId, invoiceId) {
    const invoice = invoices.get(tenantId, invoiceId);
    if (!invoice) throw new VismaError('not_found', 'Factuur niet gevonden.', 404);
    if (invoice.status === 'concept') throw new VismaError('not_final', 'Maak de factuur eerst definitief.', 409);
    if (invoice.vismaInvoiceId) return invoice;
    const vismaSettings = vismaSettingsOf(tenantId);
    const settings = Core.sanitizeSettings(settingsFor(tenantId).get('invoicing'));
    try {
      const original = invoice.kind === 'credit' && invoice.creditOf ? invoices.get(tenantId, invoice.creditOf) : null;
      const built = invoiceBody(invoice, 'x', vismaSettings, settings, original && original.vismaInvoiceId);
      if (built.error) throw new VismaError('no_article', built.error, 409);
      const customerId = await pushDebtor(tenantId, invoice.debtorId, vismaSettings);
      const out = await api(tenantId, 'POST', '/customerinvoices', { ...built.body, CustomerId: customerId });
      prepare("UPDATE invoices SET visma_invoice_id = ?, visma_number = ?, visma_synced_at = ?, visma_error = '' WHERE tenant_id = ? AND id = ?")
        .run(String(out && out.Id), cleanText(out && out.InvoiceNumber, 40), new Date().toISOString(), tenantId, invoice.id);
    } catch (error) {
      if (error instanceof VismaError) prepare('UPDATE invoices SET visma_error = ? WHERE tenant_id = ? AND id = ?').run(error.message.slice(0, 300), tenantId, invoice.id);
      throw error;
    }
    return invoices.get(tenantId, invoice.id);
  }

  /**
   * Stuurt alle definitieve facturen vanaf visma.since die nog niet in Visma staan (oudste eerst, hooguit BATCH).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ sent: number, failed: number, errors: string[] }|{ skipped: string }>} Aantallen en de eerste foutmeldingen.
   */
  async function sync(tenantId) {
    if (!connected(tenantId)) return { skipped: 'not_connected' };
    const vismaSettings = vismaSettingsOf(tenantId);
    const args = [tenantId];
    let sql = "SELECT id FROM invoices WHERE tenant_id = ? AND status <> 'concept' AND visma_invoice_id IS NULL";
    if (vismaSettings.since) { sql += ' AND invoice_date >= ?'; args.push(vismaSettings.since); }
    const ids = prepare(`${sql} ORDER BY finalized_at, number LIMIT ${BATCH}`).all(...args).map((row) => row.id);
    const out = { sent: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        await pushInvoice(tenantId, id);
        out.sent++;
      } catch (error) {
        if (!(error instanceof VismaError)) throw error;
        out.failed++;
        if (out.errors.length < 5) out.errors.push(error.message);
        // Verbinding of instelling ontbreekt: de rest heeft hetzelfde probleem.
        if (['not_connected', 'not_configured', 'reconnect', 'token_failed', 'unreachable', 'no_terms', 'forbidden'].includes(error.code)) break;
      }
    }
    return out;
  }

  /**
   * Doorsturen per omgeving na elkaar (nooit twee keer tegelijk).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<object>} Het resultaat van sync.
   */
  function run(tenantId) {
    const previous = running.get(tenantId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => sync(tenantId));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /**
   * Na definitief: kort daarna doorsturen als automatisch aan staat.
   * @param {string} tenantId Id van de omgeving.
   */
  function schedule(tenantId) {
    if (timers.has(tenantId)) return;
    try {
      if (!connected(tenantId) || !vismaSettingsOf(tenantId).autoSync) return;
    } catch { return; }
    const timer = setTimeout(() => {
      timers.delete(tenantId);
      run(tenantId).catch((error) => log.warn(`Visma (${tenantId}): doorsturen mislukt: ${error.code || error.message}`));
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    timers.set(tenantId, timer);
  }

  /**
   * Doorsturen voor alle omgevingen met automatisch aan (elke 10 minuten).
   * @param {string[]} tenantIds De omgevingen.
   * @returns {Promise<object>} Resultaat per omgeving.
   */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      try {
        if (!connected(id) || !vismaSettingsOf(id).autoSync) continue;
        out[id] = await run(id);
      } catch (error) {
        log.warn(`Visma (${id}): doorsturen mislukt: ${error.code || error.message}`);
      }
    }
    return out;
  }

  /**
   * Stand van de koppeling voor het scherm Facturen → Visma.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} configured, environment, connected, settings, pending en failed.
   */
  function status(tenantId) {
    const registration = app();
    const vismaSettings = vismaSettingsOf(tenantId);
    const counts = prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN visma_error <> '' THEN 1 ELSE 0 END) AS failed FROM invoices
      WHERE tenant_id = ? AND status <> 'concept' AND visma_invoice_id IS NULL${vismaSettings.since ? ' AND invoice_date >= ?' : ''}`)
      .get(...[tenantId, ...(vismaSettings.since ? [vismaSettings.since] : [])]);
    return {
      configured: registration.configured, environment: registration.environment, connected: connected(tenantId),
      settings: vismaSettings, pending: Number(counts && counts.n) || 0, failed: Number(counts && counts.failed) || 0,
    };
  }

  return { authorizeUrl, finishConnect, disconnect, api, options, pushInvoice, sync, run, schedule, runAll, status, app };
}

/**
 * Registreert de routes (recht facturen): status, opties uit Visma,
 * instellingen, verbinden (OAuth) en verbreken, nu doorsturen, één factuur
 * doorsturen. Platform (hoofdbeheerder, onder /api/platform): de app-gegevens.
 * @param {object} app De Express-app.
 * @param {object} ctx visma, requireRight, requireJson, audit, settingsFor, mainTenantId en syncLimiter.
 */
function registerVismaRoutes(app, { visma, requireRight, requireJson, audit, settingsFor, mainTenantId, syncLimiter }) {
  const requireInvoices = requireRight('facturen');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  const limiter = syncLimiter || ((req, res, next) => next());
  /**
   * Stuurt een VismaError als antwoord; een andere fout wordt opnieuw gegooid.
   * @param {object} res Het Express-antwoord.
   * @param {Error} error De fout.
   */
  const fail = (res, error) => {
    if (!(error instanceof VismaError)) throw error;
    res.status(error.status).json({ error: error.code, message: error.message });
  };
  /**
   * Maakt van een async route-afhandeling een gewone: een VismaError wordt een antwoord, een andere fout gaat naar Express.
   * @param {Function} handler De async afhandeling (req, res, next).
   * @returns {Function} De route-afhandeling.
   */
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    try { fail(res, error); } catch (nextError) { next(nextError); }
  });

  app.get('/api/visma', requireInvoices, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...visma.status(tenantOf(req)), groups: Core.GROUPS, rates: Core.VAT_RATES });
  });

  app.get('/api/visma/options', requireInvoices, limiter, wrap(async (req, res) => {
    res.json(await visma.options(tenantOf(req)));
  }));

  app.put('/api/visma/settings', requireJson, requireInvoices, (req, res) => {
    const settings = settingsFor(tenantOf(req));
    const current = settings.get('visma');
    const body = req.body || {};
    const next = sanitizeVisma({
      ...current, articles: body.articles, termsOfPaymentId: body.termsOfPaymentId, autoSync: body.autoSync === true,
      since: body.since === undefined ? current.since : body.since,
    });
    // Automatisch aangezet zonder datum: vanaf vandaag (oudere facturen staan al in Visma).
    if (next.autoSync && !next.since) next.since = Core.today();
    settings.update({ visma: next }, req.user.id);
    audit(req, 'instellingen_gewijzigd', { fields: ['visma'] });
    res.json(visma.status(tenantOf(req)));
  });

  // Verbinden: de browser gaat naar Visma en komt terug op /api/visma/callback.
  app.post('/api/visma/connect', requireJson, requireInvoices, wrap(async (req, res) => {
    res.json({ url: visma.authorizeUrl(tenantOf(req), req.user.id) });
  }));

  app.get('/api/visma/callback', requireInvoices, wrap(async (req, res) => {
    /**
     * Stuurt de browser terug naar Facturen (relatief, werkt ook onder een padprefix).
     * @param {string} query De querystring met de uitkomst.
     * @returns {object} Het antwoord.
     */
    const back = (query) => res.redirect(303, `../../facturen/?${query}#visma`);
    if (req.query.error) return back('visma=geweigerd');
    try {
      await visma.finishConnect(String(req.query.state || ''), String(req.query.code || ''), {
        tenantId: tenantOf(req), userId: req.user.id, userName: req.user.display_name,
      });
    } catch (error) {
      if (!(error instanceof VismaError)) throw error;
      console.warn(`Visma verbinden mislukt (${tenantOf(req)}): ${error.code}`);
      return back(`visma=fout&reden=${encodeURIComponent(error.code)}`);
    }
    audit(req, 'visma_verbonden', {});
    back('visma=verbonden');
  }));

  app.post('/api/visma/disconnect', requireJson, requireInvoices, (req, res) => {
    visma.disconnect(tenantOf(req), req.user.id);
    audit(req, 'visma_verbroken', {});
    res.json(visma.status(tenantOf(req)));
  });

  app.post('/api/visma/sync', requireJson, requireInvoices, limiter, wrap(async (req, res) => {
    const out = await visma.run(tenantOf(req));
    if (out.skipped) return res.status(409).json({ error: out.skipped, message: 'Deze omgeving is niet verbonden met Visma.' });
    if (out.sent) audit(req, 'facturen_naar_visma', { count: out.sent });
    res.json({ ...out, status: visma.status(tenantOf(req)) });
  }));

  app.post('/api/visma/invoices/:id', requireJson, requireInvoices, limiter, wrap(async (req, res) => {
    const invoice = await visma.pushInvoice(tenantOf(req), req.params.id);
    audit(req, 'factuur_naar_visma', { invoiceId: invoice.id, number: invoice.number });
    res.json(invoice);
  }));

  // ---------- Platform: de app-registratie bij Visma (hoofdbeheerder) ----------
  app.get('/api/platform/visma', (req, res) => {
    const settings = settingsFor(mainTenantId);
    res.json({ app: settings.get('vismaApp'), secretSet: Boolean(settings.get('vismaClientSecret')), defaultRedirect: DEFAULT_REDIRECT });
  });
  app.put('/api/platform/visma', requireJson, (req, res) => {
    const body = req.body || {};
    const patch = { vismaApp: sanitizeVismaApp(body) };
    if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) patch.vismaClientSecret = body.clientSecret.trim();
    if (body.clearSecret === true) patch.vismaClientSecret = '';
    try {
      settingsFor(mainTenantId).update(patch, req.user.id);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_setting', field: error.field, message: error.message });
    }
    audit(req, 'instellingen_gewijzigd', { fields: Object.keys(patch) }, undefined, mainTenantId);
    const settings = settingsFor(mainTenantId);
    res.json({ app: settings.get('vismaApp'), secretSet: Boolean(settings.get('vismaClientSecret')), defaultRedirect: DEFAULT_REDIRECT });
  });
}

module.exports = { createVisma, registerVismaRoutes, sanitizeVisma, sanitizeVismaApp, splitAddress, customerBody, invoiceBody, VismaError, HOSTS, SCOPES };
