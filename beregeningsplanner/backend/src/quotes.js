// Offertes: opslag (tabel quotes), het bedrijfsprofiel voor op de offerte
// (instelling quoteProfile) en de API-routes. De berekening zelf staat in
// frontend/offertes/quote-core.js en is gedeeld met de browser.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));
const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));

// Bedrijfsprofiel: tekstvelden met maximale lengte en getallen [min, max].
const PROFILE_TEXT = {
  companyName: 120, address: 400, email: 160, phone: 40, website: 160, kvk: 20, vatNumber: 30, iban: 40,
  numberPrefix: 12, intro: 4000, terms: 6000,
};
const PROFILE_NUMBERS = { hourlyRate: [0, 10000], validDays: [1, 365], vatRate: [0, 21], markupPct: [-100, 1000], callOutFee: [0, 100000] };
const PROFILE_DEFAULTS = {
  companyName: 'AquaTech Service', address: '', email: '', phone: '', website: 'aquatechservice.nl', kvk: '', vatNumber: '', iban: '',
  numberPrefix: 'OF-',
  intro: 'Naar aanleiding van ons gesprek bieden wij u vrijblijvend de aanleg aan van een automatisch beregeningssysteem, volgens het ontwerp dat wij voor uw tuin hebben gemaakt.',
  terms: 'Alle bedragen zijn in euro\'s. Deze offerte is geldig tot de genoemde datum. Meerwerk voeren wij alleen in overleg uit, op basis van nacalculatie. Graafwerk gaat uit van een normaal bewerkbare grond zonder obstakels of kabels en leidingen in het tracé. Na akkoord plannen wij de werkzaamheden in overleg in.',
  hourlyRate: 55, validDays: 30, vatRate: 21, markupPct: 0, callOutFee: 0,
};

/** Schoont een (deel)profiel op; ontbrekende velden krijgen de standaardwaarde. */
function sanitizeProfile(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, max] of Object.entries(PROFILE_TEXT)) out[k] = typeof r[k] === 'string' ? r[k].slice(0, max) : PROFILE_DEFAULTS[k];
  for (const [k, [min, max]] of Object.entries(PROFILE_NUMBERS)) {
    const n = Number(r[k]);
    out[k] = r[k] !== undefined && r[k] !== null && r[k] !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : PROFILE_DEFAULTS[k];
  }
  if (![0, 9, 21].includes(out.vatRate)) out.vatRate = 21;
  out.validDays = Math.round(out.validDays);
  return out;
}

const STATUSES = Object.keys(Core.STATUSES);
const now = () => new Date().toISOString();

function createQuoteStore(db) {
  const q = (sql) => db.prepare(sql);

  function row(r, withData) {
    const out = {
      id: r.id, number: r.number, status: r.status, title: r.title, customer: r.customer, planId: r.plan_id || null,
      totalExcl: r.total_excl, totalIncl: r.total_incl, createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.valid_until !== undefined) out.validUntil = r.valid_until;
    if (r.owner_name !== undefined) out.owner = { id: r.owner_id, username: r.owner_username, displayName: r.owner_name };
    out.customerId = r.customer_id || null;
    if (r.customer_name !== undefined) out.customerAccount = r.customer_id ? { id: r.customer_id, displayName: r.customer_name } : null;
    if (withData) out.data = JSON.parse(r.data);
    return out;
  }

  // Wat een klant van een offerte te zien krijgt: met de opmaak "totaal per
  // onderdeel" geen prijzen per regel, wel de totalen.
  function forCustomer(quote) {
    const out = { ...quote, totals: Core.totals(quote.data) };
    if (quote.data.layout === 'totaal') {
      out.data = { ...quote.data, lines: quote.data.lines.map((l) => ({ id: l.id, section: l.section, description: l.description, qty: l.qty, unit: l.unit })) };
    }
    return out;
  }

  // customerId: alleen de offertes van dat klantaccount, en geen concepten.
  function list(tenantId, { ownerId = null, planId = null, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT q.id, q.number, q.status, q.title, q.customer, q.plan_id, q.total_excl, q.total_incl, q.created_at, q.updated_at,
        json_extract(q.data, '$.validUntil') AS valid_until, q.owner_id, u.username AS owner_username, u.display_name AS owner_name,
        q.customer_id, c.display_name AS customer_name
      FROM quotes q JOIN users u ON u.id = q.owner_id LEFT JOIN users c ON c.id = q.customer_id
      WHERE q.tenant_id = ? AND q.deleted_at IS NULL`;
    if (ownerId) { sql += ' AND q.owner_id = ?'; args.push(ownerId); }
    if (customerId) { sql += " AND q.customer_id = ? AND q.status <> 'concept'"; args.push(customerId); }
    if (planId) { sql += ' AND q.plan_id = ?'; args.push(String(planId)); }
    return q(`${sql} ORDER BY q.updated_at DESC`).all(...args).map((r) => row(r, false));
  }

  // Bewerken: de eigenaar, of iedereen met offertes.alle (beheerder,
  // installateur) binnen de tenant. Een klant bewerkt nooit.
  function findEditable(user, id) {
    if (!Roles.can(user, 'offertes')) return null;
    const r = q('SELECT * FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(user.tenant_id, String(id));
    if (!r || (r.owner_id !== user.id && !Roles.can(user, 'offertes.alle'))) return null;
    return r;
  }

  // Inzien: wie mag bewerken, plus de gekoppelde klant zodra de offerte
  // verzonden is (concepten blijven intern).
  function findVisible(user, id) {
    const r = findEditable(user, id);
    if (r) return { r, asCustomer: false };
    const c = q("SELECT * FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND customer_id = ? AND status <> 'concept'")
      .get(user.tenant_id, String(id), user.id);
    return c ? { r: c, asCustomer: true } : null;
  }

  const fullRow = (id) => row(q(`SELECT q.*, c.display_name AS customer_name FROM quotes q LEFT JOIN users c ON c.id = q.customer_id WHERE q.id = ?`).get(id), true);

  const get = (user, id) => {
    const f = findVisible(user, id);
    if (!f) return null;
    const quote = fullRow(f.r.id);
    return f.asCustomer ? forCustomer(quote) : quote;
  };

  // Offertenummer per tenant en jaar: <voorvoegsel><jaar>-0001, oplopend (ook
  // verwijderde offertes tellen mee, zodat een nummer nooit terugkomt).
  function nextNumber(tenantId, prefix, year) {
    const head = `${prefix}${year}-`;
    let max = 0;
    for (const r of q('SELECT number FROM quotes WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const n = Number(r.number.slice(head.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  function fields(data) {
    const t = Core.totals(data);
    return {
      title: data.title.trim() || data.planTitle.trim() || 'Offerte',
      customer: data.customer.name.trim(),
      totalExcl: t.net,
      totalIncl: t.total,
    };
  }

  function create(user, rawData, { status = 'concept', prefix = 'OF-', customerId = null } = {}) {
    const data = Core.sanitize(rawData);
    const f = fields(data);
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const ts = now();
      const number = nextNumber(user.tenant_id, prefix, data.date.slice(0, 4));
      q(`INSERT INTO quotes (id, tenant_id, owner_id, plan_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.tenant_id, user.id, data.planId || null, number, STATUSES.includes(status) ? status : 'concept',
          f.title, f.customer, f.totalExcl, f.totalIncl, JSON.stringify(data), ts, ts, customerId || null);
      return fullRow(id);
    });
  }

  // customerId: undefined = ongewijzigd, null = ontkoppelen.
  function update(user, id, rawData, status, customerId) {
    return transaction(db, () => {
      const r = findEditable(user, id);
      if (!r) return null;
      const data = rawData === undefined ? JSON.parse(r.data) : Core.sanitize(rawData);
      const f = fields(data);
      const st = STATUSES.includes(status) ? status : r.status;
      const cid = customerId === undefined ? r.customer_id : customerId || null;
      q(`UPDATE quotes SET plan_id = ?, status = ?, title = ?, customer = ?, total_excl = ?, total_incl = ?, data = ?, updated_at = ?, customer_id = ? WHERE id = ?`)
        .run(data.planId || null, st, f.title, f.customer, f.totalExcl, f.totalIncl, JSON.stringify(data), now(), cid, r.id);
      return fullRow(r.id);
    });
  }

  // Reactie van de klant op een verzonden offerte: akkoord of afgewezen.
  function respond(user, id, answer) {
    return transaction(db, () => {
      const r = q('SELECT * FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND customer_id = ?').get(user.tenant_id, String(id), user.id);
      if (!r || r.status === 'concept') return { error: 'not_found' };
      if (r.status !== 'verzonden') return { error: 'answered', status: r.status };
      const validUntil = JSON.parse(r.data).validUntil;
      if (answer === 'akkoord' && validUntil && validUntil < Core.today()) return { error: 'expired' };
      q('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run(answer, now(), r.id);
      return { quote: forCustomer(fullRow(r.id)) };
    });
  }

  function remove(user, id) {
    const r = findEditable(user, id);
    if (!r) return false;
    q('UPDATE quotes SET deleted_at = ? WHERE id = ?').run(now(), r.id);
    return true;
  }

  // Definitief wissen (AVG-verzoek): ook al verwijderde offertes.
  function purge(tenantId, id) {
    return q('DELETE FROM quotes WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
  }

  return { list, get, create, update, respond, remove, purge, nextNumber };
}

/**
 * API-routes. ctx: { quotes, tenantOf(req), settingsOf(req), customersOf(req),
 * identify, requireUser, requireAdmin, requireRight, requireJson, audit }.
 * Opstellen en bewerken: recht 'offertes' (beheerder, installateur); een
 * klant ziet alleen de verzonden offertes die aan zijn account hangen en kan
 * die accepteren of afwijzen.
 */
function registerQuoteRoutes(app, ctx) {
  const { quotes, identify, requireAdmin, requireRight, requireJson, settingsOf, customersOf, audit } = ctx;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Offerte niet gevonden.' });
  const validData = (d) => d && typeof d === 'object' && !Array.isArray(d);
  const validStatus = (s) => s === undefined || STATUSES.includes(s);
  const requireQuotes = requireRight('offertes');

  // Klantaccount voor een offerte: leeg (geen) of een actieve klant van de organisatie.
  function customerIdOf(req, raw) {
    if (raw === undefined) return { value: undefined };
    if (raw === null || raw === '') return { value: null };
    return customersOf(req).some((c) => c.id === String(raw)) ? { value: String(raw) } : { error: true };
  }
  const badCustomer = (res) => res.status(400).json({ error: 'invalid_customer', message: 'Onbekend klantaccount.' });

  // Bedrijfsgegevens en standaardwaarden voor op de offerte (geen geheimen).
  // Ook een klant heeft ze nodig om de offerte te kunnen tonen.
  app.get('/api/quote-profile', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.json({ profile: settingsOf(req).get('quoteProfile'), canEdit: Roles.can(user, 'beheer') });
  });

  app.put('/api/quote-profile', requireJson, requireAdmin, (req, res) => {
    const settings = settingsOf(req);
    const next = sanitizeProfile({ ...settings.get('quoteProfile'), ...(validData(req.body?.profile) ? req.body.profile : {}) });
    settings.update({ quoteProfile: next }, req.user?.id);
    audit(req, 'instellingen_gewijzigd', { fields: ['quoteProfile'] });
    res.json({ profile: settings.get('quoteProfile') });
  });

  // Klantaccounts om een offerte aan te koppelen.
  app.get('/api/quote-customers', requireQuotes, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: customersOf(req) });
  });

  // Eigen offertes; beheerders en installateurs zien met ?all=1 die van
  // iedereen, een klant alleen de offertes voor zijn account.
  app.get('/api/quotes', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.json({ items: [] });
    if (!Roles.can(user, 'offertes')) {
      return res.json({ items: Roles.can(user, 'offertes.klant') ? quotes.list(user.tenant_id, { customerId: user.id }) : [] });
    }
    const all = req.query.all === '1' && Roles.can(user, 'offertes.alle');
    res.json({ items: quotes.list(user.tenant_id, { ownerId: all ? null : user.id, planId: req.query.plan || null }) });
  });

  app.get('/api/quotes/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    const quote = user && quotes.get(user, req.params.id);
    if (!quote) return notFound(res);
    res.json(quote);
  });

  app.post('/api/quotes', requireJson, requireQuotes, (req, res) => {
    const { data, status } = req.body || {};
    if (!validData(data) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const cid = customerIdOf(req, req.body.customerId);
    if (cid.error) return badCustomer(res);
    const prefix = settingsOf(req).get('quoteProfile').numberPrefix;
    res.status(201).json(quotes.create(req.user, data, { status, prefix, customerId: cid.value }));
  });

  app.put('/api/quotes/:id', requireJson, requireQuotes, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const cid = customerIdOf(req, req.body.customerId);
    if (cid.error) return badCustomer(res);
    const quote = quotes.update(req.user, req.params.id, data, status, cid.value);
    if (!quote) return notFound(res);
    res.json(quote);
  });

  // De klant accepteert of wijst af (alleen een verzonden offerte).
  app.post('/api/quotes/:id/respond', requireJson, requireRight('offertes.klant'), (req, res) => {
    const answer = req.body?.answer;
    if (answer !== 'akkoord' && answer !== 'afgewezen') return res.status(400).json({ error: 'invalid_answer', message: 'Kies akkoord of afwijzen.' });
    const out = quotes.respond(req.user, req.params.id, answer);
    if (out.error === 'not_found') return notFound(res);
    if (out.error === 'answered') return res.status(409).json({ error: 'answered', message: `Deze offerte is al ${out.status === 'akkoord' ? 'geaccepteerd' : 'afgewezen'}.` });
    if (out.error === 'expired') return res.status(409).json({ error: 'expired', message: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.' });
    audit(req, answer === 'akkoord' ? 'offerte_akkoord' : 'offerte_afgewezen', { quoteId: out.quote.id, number: out.quote.number });
    res.json(out.quote);
  });

  app.delete('/api/quotes/:id', requireQuotes, (req, res) => {
    if (!quotes.remove(req.user, req.params.id)) return notFound(res);
    res.json({ ok: true });
  });

  app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
    if (!quotes.purge(ctx.tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'offerte_gewist', { quoteId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createQuoteStore, registerQuoteRoutes, sanitizeProfile, PROFILE_DEFAULTS, Core };
