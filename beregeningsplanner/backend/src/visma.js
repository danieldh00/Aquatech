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

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));

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
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const guid = (v) => (typeof v === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(v) ? v : '');

/** Platforminstelling vismaApp (zonder secret; dat is een eigen geheim). */
function sanitizeVismaApp(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let redirectUri = DEFAULT_REDIRECT;
  try {
    const u = new URL(str(r.redirectUri, 300));
    if (u.protocol === 'https:' && !u.username && !u.password && u.pathname.endsWith('/api/visma/callback')) redirectUri = `${u.origin}${u.pathname}`;
  } catch { /* standaard */ }
  return {
    clientId: str(r.clientId, 120).replace(/[^\w.:-]/g, ''),
    environment: r.environment === 'production' ? 'production' : 'sandbox',
    redirectUri,
  };
}

/**
 * Instelling visma per omgeving: artikel per omzetcategorie, betalingstermijn,
 * automatisch doorsturen, vanaf welke datum, en de verbonden administratie.
 */
function sanitizeVisma(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const articles = {};
  if (r.articles && typeof r.articles === 'object' && !Array.isArray(r.articles)) {
    for (const g of Object.keys(Core.GROUPS)) {
      for (const rate of Core.VAT_RATES) {
        const k = Core.catKey(g, rate);
        const id = guid(r.articles[k]);
        if (id) articles[k] = id;
      }
    }
  }
  return {
    articles,
    termsOfPaymentId: guid(r.termsOfPaymentId),
    autoSync: r.autoSync === true,
    since: Core.isDate(r.since) ? r.since : '',
    companyName: str(r.companyName, 200),
    environment: r.environment === 'production' ? 'production' : r.environment === 'sandbox' ? 'sandbox' : '',
    connectedAt: typeof r.connectedAt === 'string' ? r.connectedAt.slice(0, 40) : '',
    connectedBy: str(r.connectedBy, 120),
  };
}

/** Adres (vrije regels) naar de velden van Visma: straat, postcode, plaats, land. */
function splitAddress(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let country = 'NL';
  if (lines.length > 1 && /^[A-Z]{2}$/.test(lines[lines.length - 1])) country = lines.pop();
  let postal = '';
  let city = '';
  const last = lines.length > 1 ? lines[lines.length - 1] : '';
  const m = /^(\d{4}\s?[A-Za-z]{2}|\d{4,5})\s+(.+)$/.exec(last);
  if (m) {
    postal = m[1].toUpperCase().replace(/^(\d{4})([A-Z]{2})$/, '$1 $2');
    city = m[2];
    lines.pop();
  } else if (last) {
    city = last;
    lines.pop();
  }
  return { address1: lines[0] || '', address2: lines.slice(1).join(', '), postal, city, country };
}

/** Een debiteur als klant in Visma. */
function customerBody(d, termsOfPaymentId) {
  const a = splitAddress(d.address);
  const business = Boolean(d.vatNumber || d.contact);
  return {
    CustomerNumber: String(d.number),
    Name: d.name.slice(0, 50),
    IsPrivatePerson: !business,
    IsActive: true,
    InvoiceAddress1: a.address1.slice(0, 50),
    InvoiceAddress2: a.address2.slice(0, 50),
    InvoicePostalCode: a.postal.slice(0, 10),
    InvoiceCity: a.city.slice(0, 50),
    InvoiceCountryCode: a.country,
    EmailAddress: d.email || undefined,
    Telephone: d.phone || undefined,
    ContactPersonName: d.contact || undefined,
    VatNumber: d.vatNumber || undefined,
    TermsOfPaymentId: termsOfPaymentId,
  };
}

/**
 * Een factuur als verkoopfactuur in Visma. Geeft { body } of { error }
 * (bijv. een omzetcategorie zonder gekozen Visma-artikel).
 */
function invoiceBody(inv, customerId, conf, settings, creditedInvoiceId = null) {
  const d = inv.data;
  const a = splitAddress(d.customer.address);
  const discount = Number(d.discountPct) || 0;
  const rows = [];
  const missing = new Set();
  rows.push({ LineNumber: 0, IsTextRow: true, Text: `${inv.kind === 'credit' ? 'Creditfactuur' : 'Factuur'} ${inv.number}${d.reference ? ` – ${d.reference}` : ''}`.slice(0, 250) });
  for (const l of d.lines) {
    const c = Core.categoryOf(l, settings);
    const articleId = conf.articles[c.key];
    if (!articleId) { missing.add(c.name); continue; }
    rows.push({
      LineNumber: rows.length, ArticleId: articleId, IsTextRow: false,
      Text: `${l.description || ''}${l.code ? ` (${l.code})` : ''}`.slice(0, 250),
      UnitPrice: l.price, Quantity: l.qty, DiscountPercentage: discount ? Math.round(discount * 100) / 10000 : 0,
    });
  }
  if (missing.size) return { error: `Kies in Facturen → Visma een artikel voor: ${[...missing].join(', ')}.` };
  return {
    body: {
      CustomerId: customerId,
      InvoiceDate: d.date,
      DueDate: d.dueDate,
      IsCreditInvoice: inv.kind === 'credit',
      ...(inv.kind === 'credit' && creditedInvoiceId ? { CreditedInvoiceId: creditedInvoiceId } : {}),
      // Onze prijzen zijn exclusief btw; Visma rekent de btw uit het artikel.
      IncludesVat: false,
      YourReference: (d.customer.contact || '').slice(0, 50) || undefined,
      OurReference: inv.number,
      InvoiceCustomerName: d.customer.name.slice(0, 50),
      InvoiceAddress1: a.address1.slice(0, 50),
      InvoiceAddress2: a.address2.slice(0, 50),
      InvoicePostalCode: a.postal.slice(0, 10),
      InvoiceCity: a.city.slice(0, 50),
      InvoiceCountryCode: a.country,
      CustomerIsPrivatePerson: !(d.customer.vatNumber || d.customer.contact),
      EuThirdParty: false,
      RotReducedInvoicingType: 0,
      Rows: rows,
    },
  };
}

/**
 * ctx: { db, settingsFor(tid), mainTenantId, debtors, invoices, fetchImpl, log }.
 */
function createVisma({ db, settingsFor, mainTenantId, debtors, invoices, fetchImpl = fetch, log = console }) {
  const q = (sql) => db.prepare(sql);
  const states = new Map();
  const tokens = new Map();
  const running = new Map();
  const timers = new Map();

  function app() {
    const s = settingsFor(mainTenantId);
    const a = s.get('vismaApp');
    const secret = s.get('vismaClientSecret');
    return { ...a, secret, configured: Boolean(a.clientId && secret), hosts: HOSTS[a.environment] };
  }
  const confOf = (tenantId) => settingsFor(tenantId).get('visma');
  const connected = (tenantId) => Boolean(settingsFor(tenantId).get('vismaRefreshToken'));

  // ---------- OAuth2 ----------
  /** Begin van het verbinden: adres van de inlogpagina van Visma. */
  function authorizeUrl(tenantId, userId) {
    const a = app();
    if (!a.configured) throw new VismaError('not_configured', 'De Visma-koppeling is nog niet ingesteld door de hoofdbeheerder (Hoofdbeheer → Visma).', 409);
    const now = Date.now();
    for (const [k, v] of states) if (v.exp < now) states.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    states.set(state, { tenantId, userId, exp: now + STATE_TTL_MS });
    const qs = new URLSearchParams({ client_id: a.clientId, redirect_uri: a.redirectUri, scope: SCOPES, state, response_type: 'code', prompt: 'select_account' });
    return `${a.hosts.identity}/connect/authorize?${qs}`;
  }

  async function tokenRequest(form) {
    const a = app();
    let res;
    try {
      res = await fetchImpl(`${a.hosts.identity}/connect/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${a.clientId}:${a.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
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

  /** Terug van Visma met een code: tokens ophalen en bewaren. */
  async function finishConnect(state, code, { tenantId, userId, userName }) {
    const s = states.get(String(state || ''));
    states.delete(String(state || ''));
    if (!s || s.exp < Date.now() || s.tenantId !== tenantId || s.userId !== userId) throw new VismaError('invalid_state', 'Deze aanmelding is verlopen of hoort niet bij jouw sessie. Probeer opnieuw te verbinden.', 400);
    if (!code || typeof code !== 'string' || code.length > 2000) throw new VismaError('invalid_code', 'Visma gaf geen geldige code terug.', 400);
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: app().redirectUri });
    if (!t.refresh_token) throw new VismaError('token_failed', 'Visma gaf geen refresh token (scope offline_access ontbreekt).');
    const settings = settingsFor(tenantId);
    tokens.set(tenantId, { access: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000 });
    settings.update({ vismaRefreshToken: t.refresh_token }, userId);
    let companyName = '';
    try { companyName = str((await api(tenantId, 'GET', '/companysettings')).Name); } catch { /* naam is niet nodig */ }
    settings.update({ visma: { ...confOf(tenantId), companyName, environment: app().environment, connectedAt: new Date().toISOString(), connectedBy: userName || '' } }, userId);
    return { companyName };
  }

  function disconnect(tenantId, userId) {
    tokens.delete(tenantId);
    const settings = settingsFor(tenantId);
    settings.update({ vismaRefreshToken: '', visma: { ...confOf(tenantId), companyName: '', connectedAt: '', connectedBy: '', environment: '' } }, userId);
  }

  async function accessToken(tenantId) {
    const cur = tokens.get(tenantId);
    if (cur && cur.exp > Date.now()) return cur.access;
    const refresh = settingsFor(tenantId).get('vismaRefreshToken');
    if (!refresh) throw new VismaError('not_connected', 'Deze omgeving is niet verbonden met Visma.', 409);
    if (!app().configured) throw new VismaError('not_configured', 'De Visma-koppeling is nog niet ingesteld door de hoofdbeheerder.', 409);
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    tokens.set(tenantId, { access: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000 });
    // Visma kan een nieuw refresh token geven; dan het nieuwe bewaren.
    if (t.refresh_token && t.refresh_token !== refresh) settingsFor(tenantId).update({ vismaRefreshToken: t.refresh_token });
    return t.access_token;
  }

  /** Eén API-aanroep (met een nieuw access token bij 401). */
  async function api(tenantId, method, p, body, retried = false) {
    const token = await accessToken(tenantId);
    let res;
    try {
      res = await fetchImpl(`${app().hosts.api}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new VismaError('unreachable', 'Visma is niet bereikbaar.');
    }
    if (res.status === 401 && !retried) {
      tokens.delete(tenantId);
      return api(tenantId, method, p, body, true);
    }
    const text = await res.text();
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch { out = null; }
    if (!res.ok) {
      const msg = out && (out.Message || out.DeveloperErrorMessage || out.message);
      throw new VismaError(res.status === 403 ? 'forbidden' : 'api_error', `Visma: ${msg ? String(msg).slice(0, 300) : `status ${res.status}`}`);
    }
    return out;
  }
  const dataOf = (out) => (Array.isArray(out) ? out : (out && Array.isArray(out.Data) ? out.Data : []));

  async function list(tenantId, p, maxPages = 10) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const out = await api(tenantId, 'GET', `${p}${p.includes('?') ? '&' : '?'}$page=${page}&$pagesize=200`);
      const items = dataOf(out);
      all.push(...items);
      const total = out && out.Meta ? Number(out.Meta.TotalNumberOfPages) || 1 : 1;
      if (page >= total || !items.length) break;
    }
    return all;
  }

  /** Artikelen en betalingstermijnen uit Visma, om te kiezen. */
  async function options(tenantId) {
    const [articles, terms] = await Promise.all([list(tenantId, '/articles'), list(tenantId, '/termsofpayments')]);
    return {
      articles: articles.filter((a) => a.IsActive !== false).map((a) => ({ id: a.Id, number: str(a.Number, 40), name: str(a.Name, 120) })),
      terms: terms.map((t) => ({ id: t.Id, name: str(t.Name, 120), days: Number(t.NumberOfDays) || 0 })),
    };
  }

  // ---------- Doorsturen ----------
  async function pushDebtor(tenantId, debtorId, conf) {
    const r = q('SELECT visma_customer_id FROM debtors WHERE tenant_id = ? AND id = ?').get(tenantId, debtorId);
    if (!r) throw new VismaError('no_debtor', 'De factuur heeft geen debiteur.', 409);
    if (r.visma_customer_id) return r.visma_customer_id;
    const d = debtors.get(tenantId, debtorId);
    if (!conf.termsOfPaymentId) throw new VismaError('no_terms', 'Kies in Facturen → Visma een betalingstermijn voor nieuwe klanten.', 409);
    // Bestaat het klantnummer al in Visma? Alleen koppelen als het dezelfde klant is.
    const found = dataOf(await api(tenantId, 'GET', `/customers?$filter=${encodeURIComponent(`CustomerNumber eq '${d.number}'`)}`))[0];
    let id;
    if (found) {
      if (str(found.Name).toLowerCase() !== d.name.trim().toLowerCase()) {
        throw new VismaError('number_taken', `Klantnummer ${d.number} bestaat in Visma al voor "${str(found.Name)}". Verhoog het eerste debiteurnummer in Facturen → Instellingen.`, 409);
      }
      id = found.Id;
    } else {
      id = (await api(tenantId, 'POST', '/customers', customerBody(d, conf.termsOfPaymentId))).Id;
    }
    q('UPDATE debtors SET visma_customer_id = ? WHERE tenant_id = ? AND id = ?').run(String(id), tenantId, debtorId);
    return String(id);
  }

  /** Eén factuur naar Visma. Geeft de bijgewerkte factuur of gooit een VismaError. */
  async function pushInvoice(tenantId, invoiceId) {
    const inv = invoices.get(tenantId, invoiceId);
    if (!inv) throw new VismaError('not_found', 'Factuur niet gevonden.', 404);
    if (inv.status === 'concept') throw new VismaError('not_final', 'Maak de factuur eerst definitief.', 409);
    if (inv.vismaInvoiceId) return inv;
    const conf = confOf(tenantId);
    const settings = Core.sanitizeSettings(settingsFor(tenantId).get('invoicing'));
    try {
      const orig = inv.kind === 'credit' && inv.creditOf ? invoices.get(tenantId, inv.creditOf) : null;
      const built = invoiceBody(inv, 'x', conf, settings, orig && orig.vismaInvoiceId);
      if (built.error) throw new VismaError('no_article', built.error, 409);
      const customerId = await pushDebtor(tenantId, inv.debtorId, conf);
      const out = await api(tenantId, 'POST', '/customerinvoices', { ...built.body, CustomerId: customerId });
      q("UPDATE invoices SET visma_invoice_id = ?, visma_number = ?, visma_synced_at = ?, visma_error = '' WHERE tenant_id = ? AND id = ?")
        .run(String(out && out.Id), str(out && out.InvoiceNumber, 40), new Date().toISOString(), tenantId, inv.id);
    } catch (err) {
      if (err instanceof VismaError) q('UPDATE invoices SET visma_error = ? WHERE tenant_id = ? AND id = ?').run(err.message.slice(0, 300), tenantId, inv.id);
      throw err;
    }
    return invoices.get(tenantId, inv.id);
  }

  /** Alle definitieve facturen vanaf visma.since die nog niet in Visma staan (oudste eerst). */
  async function sync(tenantId) {
    if (!connected(tenantId)) return { skipped: 'not_connected' };
    const conf = confOf(tenantId);
    const args = [tenantId];
    let sql = "SELECT id FROM invoices WHERE tenant_id = ? AND status <> 'concept' AND visma_invoice_id IS NULL";
    if (conf.since) { sql += ' AND invoice_date >= ?'; args.push(conf.since); }
    const ids = q(`${sql} ORDER BY finalized_at, number LIMIT ${BATCH}`).all(...args).map((r) => r.id);
    const out = { sent: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        await pushInvoice(tenantId, id);
        out.sent++;
      } catch (err) {
        if (!(err instanceof VismaError)) throw err;
        out.failed++;
        if (out.errors.length < 5) out.errors.push(err.message);
        // Verbinding of instelling ontbreekt: de rest heeft hetzelfde probleem.
        if (['not_connected', 'not_configured', 'reconnect', 'token_failed', 'unreachable', 'no_terms', 'forbidden'].includes(err.code)) break;
      }
    }
    return out;
  }

  function run(tenantId) {
    const prev = running.get(tenantId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => sync(tenantId));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /** Na definitief: kort daarna doorsturen als automatisch aan staat. */
  function schedule(tenantId) {
    if (timers.has(tenantId)) return;
    try {
      if (!connected(tenantId) || !confOf(tenantId).autoSync) return;
    } catch { return; }
    const t = setTimeout(() => {
      timers.delete(tenantId);
      run(tenantId).catch((err) => log.warn(`Visma (${tenantId}): doorsturen mislukt: ${err.code || err.message}`));
    }, DEBOUNCE_MS);
    if (t.unref) t.unref();
    timers.set(tenantId, t);
  }

  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      try {
        if (!connected(id) || !confOf(id).autoSync) continue;
        out[id] = await run(id);
      } catch (err) {
        log.warn(`Visma (${id}): doorsturen mislukt: ${err.code || err.message}`);
      }
    }
    return out;
  }

  function status(tenantId) {
    const a = app();
    const conf = confOf(tenantId);
    const r = q(`SELECT COUNT(*) AS n, SUM(CASE WHEN visma_error <> '' THEN 1 ELSE 0 END) AS failed FROM invoices
      WHERE tenant_id = ? AND status <> 'concept' AND visma_invoice_id IS NULL${conf.since ? ' AND invoice_date >= ?' : ''}`)
      .get(...[tenantId, ...(conf.since ? [conf.since] : [])]);
    return {
      configured: a.configured, environment: a.environment, connected: connected(tenantId),
      settings: conf, pending: Number(r && r.n) || 0, failed: Number(r && r.failed) || 0,
    };
  }

  return { authorizeUrl, finishConnect, disconnect, api, options, pushInvoice, sync, run, schedule, runAll, status, app };
}

/**
 * Routes (recht facturen): status, opties uit Visma, instellingen, verbinden
 * (OAuth) en verbreken, nu doorsturen, één factuur doorsturen. Platform
 * (hoofdbeheerder, onder /api/platform): de app-gegevens.
 */
function registerVismaRoutes(app, { visma, requireRight, requireJson, audit, settingsFor, mainTenantId, syncLimiter }) {
  const requireInvoices = requireRight('facturen');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const limiter = syncLimiter || ((req, res, next) => next());
  const fail = (res, err) => {
    if (!(err instanceof VismaError)) throw err;
    res.status(err.status).json({ error: err.code, message: err.message });
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    try { fail(res, err); } catch (e) { next(e); }
  });

  app.get('/api/visma', requireInvoices, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...visma.status(tid(req)), groups: Core.GROUPS, rates: Core.VAT_RATES });
  });

  app.get('/api/visma/options', requireInvoices, limiter, wrap(async (req, res) => {
    res.json(await visma.options(tid(req)));
  }));

  app.put('/api/visma/settings', requireJson, requireInvoices, (req, res) => {
    const s = settingsFor(tid(req));
    const cur = s.get('visma');
    const b = req.body || {};
    const next = sanitizeVisma({
      ...cur, articles: b.articles, termsOfPaymentId: b.termsOfPaymentId, autoSync: b.autoSync === true,
      since: b.since === undefined ? cur.since : b.since,
    });
    // Automatisch aangezet zonder datum: vanaf vandaag (oudere facturen staan al in Visma).
    if (next.autoSync && !next.since) next.since = Core.today();
    s.update({ visma: next }, req.user.id);
    audit(req, 'instellingen_gewijzigd', { fields: ['visma'] });
    res.json(visma.status(tid(req)));
  });

  // Verbinden: de browser gaat naar Visma en komt terug op /api/visma/callback.
  app.post('/api/visma/connect', requireJson, requireInvoices, wrap(async (req, res) => {
    res.json({ url: visma.authorizeUrl(tid(req), req.user.id) });
  }));

  app.get('/api/visma/callback', requireInvoices, wrap(async (req, res) => {
    // Relatief terug naar Facturen (werkt ook onder een padprefix).
    const back = (q) => res.redirect(303, `../../facturen/?${q}#visma`);
    if (req.query.error) return back('visma=geweigerd');
    try {
      await visma.finishConnect(String(req.query.state || ''), String(req.query.code || ''), {
        tenantId: tid(req), userId: req.user.id, userName: req.user.display_name,
      });
    } catch (err) {
      if (!(err instanceof VismaError)) throw err;
      console.warn(`Visma verbinden mislukt (${tid(req)}): ${err.code}`);
      return back(`visma=fout&reden=${encodeURIComponent(err.code)}`);
    }
    audit(req, 'visma_verbonden', {});
    back('visma=verbonden');
  }));

  app.post('/api/visma/disconnect', requireJson, requireInvoices, (req, res) => {
    visma.disconnect(tid(req), req.user.id);
    audit(req, 'visma_verbroken', {});
    res.json(visma.status(tid(req)));
  });

  app.post('/api/visma/sync', requireJson, requireInvoices, limiter, wrap(async (req, res) => {
    const out = await visma.run(tid(req));
    if (out.skipped) return res.status(409).json({ error: out.skipped, message: 'Deze omgeving is niet verbonden met Visma.' });
    if (out.sent) audit(req, 'facturen_naar_visma', { count: out.sent });
    res.json({ ...out, status: visma.status(tid(req)) });
  }));

  app.post('/api/visma/invoices/:id', requireJson, requireInvoices, limiter, wrap(async (req, res) => {
    const inv = await visma.pushInvoice(tid(req), req.params.id);
    audit(req, 'factuur_naar_visma', { invoiceId: inv.id, number: inv.number });
    res.json(inv);
  }));

  // ---------- Platform: de app-registratie bij Visma (hoofdbeheerder) ----------
  app.get('/api/platform/visma', (req, res) => {
    const s = settingsFor(mainTenantId);
    res.json({ app: s.get('vismaApp'), secretSet: Boolean(s.get('vismaClientSecret')), defaultRedirect: DEFAULT_REDIRECT });
  });
  app.put('/api/platform/visma', requireJson, (req, res) => {
    const b = req.body || {};
    const patch = { vismaApp: sanitizeVismaApp(b) };
    if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) patch.vismaClientSecret = b.clientSecret.trim();
    if (b.clearSecret === true) patch.vismaClientSecret = '';
    try {
      settingsFor(mainTenantId).update(patch, req.user.id);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
    }
    audit(req, 'instellingen_gewijzigd', { fields: Object.keys(patch) }, undefined, mainTenantId);
    const s = settingsFor(mainTenantId);
    res.json({ app: s.get('vismaApp'), secretSet: Boolean(s.get('vismaClientSecret')), defaultRedirect: DEFAULT_REDIRECT });
  });
}

module.exports = { createVisma, registerVismaRoutes, sanitizeVisma, sanitizeVismaApp, splitAddress, customerBody, invoiceBody, VismaError, HOSTS, SCOPES };
