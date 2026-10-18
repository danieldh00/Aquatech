// Offertes: opslag (tabel quotes), het bedrijfsprofiel voor op de offerte
// (instelling quoteProfile) en de API-routes. De berekening zelf staat in
// frontend/offertes/quote-core.js en is gedeeld met de browser.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));

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
    if (withData) out.data = JSON.parse(r.data);
    return out;
  }

  function list(tenantId, { ownerId = null, planId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT q.id, q.number, q.status, q.title, q.customer, q.plan_id, q.total_excl, q.total_incl, q.created_at, q.updated_at,
        json_extract(q.data, '$.validUntil') AS valid_until, q.owner_id, u.username AS owner_username, u.display_name AS owner_name
      FROM quotes q JOIN users u ON u.id = q.owner_id WHERE q.tenant_id = ? AND q.deleted_at IS NULL`;
    if (ownerId) { sql += ' AND q.owner_id = ?'; args.push(ownerId); }
    if (planId) { sql += ' AND q.plan_id = ?'; args.push(String(planId)); }
    return q(`${sql} ORDER BY q.updated_at DESC`).all(...args).map((r) => row(r, false));
  }

  // Alleen de eigenaar; een beheerder ziet alle offertes binnen de tenant.
  function find(user, id) {
    const r = q('SELECT * FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(user.tenant_id, String(id));
    if (!r || (r.owner_id !== user.id && user.role !== 'beheerder')) return null;
    return r;
  }

  const get = (user, id) => {
    const r = find(user, id);
    return r ? row(r, true) : null;
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

  function create(user, rawData, { status = 'concept', prefix = 'OF-' } = {}) {
    const data = Core.sanitize(rawData);
    const f = fields(data);
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const ts = now();
      const number = nextNumber(user.tenant_id, prefix, data.date.slice(0, 4));
      q(`INSERT INTO quotes (id, tenant_id, owner_id, plan_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.tenant_id, user.id, data.planId || null, number, STATUSES.includes(status) ? status : 'concept',
          f.title, f.customer, f.totalExcl, f.totalIncl, JSON.stringify(data), ts, ts);
      return row(q('SELECT * FROM quotes WHERE id = ?').get(id), true);
    });
  }

  function update(user, id, rawData, status) {
    return transaction(db, () => {
      const r = find(user, id);
      if (!r) return null;
      const data = rawData === undefined ? JSON.parse(r.data) : Core.sanitize(rawData);
      const f = fields(data);
      const st = STATUSES.includes(status) ? status : r.status;
      q(`UPDATE quotes SET plan_id = ?, status = ?, title = ?, customer = ?, total_excl = ?, total_incl = ?, data = ?, updated_at = ? WHERE id = ?`)
        .run(data.planId || null, st, f.title, f.customer, f.totalExcl, f.totalIncl, JSON.stringify(data), now(), r.id);
      return row(q('SELECT * FROM quotes WHERE id = ?').get(r.id), true);
    });
  }

  function remove(user, id) {
    const r = find(user, id);
    if (!r) return false;
    q('UPDATE quotes SET deleted_at = ? WHERE id = ?').run(now(), r.id);
    return true;
  }

  // Definitief wissen (AVG-verzoek): ook al verwijderde offertes.
  function purge(tenantId, id) {
    return q('DELETE FROM quotes WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
  }

  return { list, get, create, update, remove, purge, nextNumber };
}

/**
 * API-routes. ctx: { store (quotes), tenantOf(req), settingsOf(req), identify,
 * requireUser, requireAdmin, requireJson, audit }.
 */
function registerQuoteRoutes(app, ctx) {
  const { quotes, identify, requireUser, requireAdmin, requireJson, settingsOf, audit } = ctx;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Offerte niet gevonden.' });
  const validData = (d) => d && typeof d === 'object' && !Array.isArray(d);
  const validStatus = (s) => s === undefined || STATUSES.includes(s);

  // Bedrijfsgegevens en standaardwaarden voor op de offerte (geen geheimen).
  app.get('/api/quote-profile', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.json({ profile: settingsOf(req).get('quoteProfile'), canEdit: user.role === 'beheerder' });
  });

  app.put('/api/quote-profile', requireJson, requireAdmin, (req, res) => {
    const settings = settingsOf(req);
    const next = sanitizeProfile({ ...settings.get('quoteProfile'), ...(validData(req.body?.profile) ? req.body.profile : {}) });
    settings.update({ quoteProfile: next }, req.user?.id);
    audit(req, 'instellingen_gewijzigd', { fields: ['quoteProfile'] });
    res.json({ profile: settings.get('quoteProfile') });
  });

  // Eigen offertes; een beheerder ziet met ?all=1 die van iedereen.
  app.get('/api/quotes', (req, res) => {
    const user = identify(req);
    if (!user) return res.json({ items: [] });
    const all = req.query.all === '1' && user.role === 'beheerder';
    res.json({ items: quotes.list(user.tenant_id, { ownerId: all ? null : user.id, planId: req.query.plan || null }) });
  });

  app.get('/api/quotes/:id', (req, res) => {
    const user = identify(req);
    const quote = user && quotes.get(user, req.params.id);
    if (!quote) return notFound(res);
    res.json(quote);
  });

  app.post('/api/quotes', requireJson, requireUser, (req, res) => {
    const { data, status } = req.body || {};
    if (!validData(data) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const prefix = settingsOf(req).get('quoteProfile').numberPrefix;
    res.status(201).json(quotes.create(req.user, data, { status, prefix }));
  });

  app.put('/api/quotes/:id', requireJson, requireUser, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const quote = quotes.update(req.user, req.params.id, data, status);
    if (!quote) return notFound(res);
    res.json(quote);
  });

  app.delete('/api/quotes/:id', (req, res) => {
    const user = identify(req);
    if (!user || !quotes.remove(user, req.params.id)) return notFound(res);
    res.json({ ok: true });
  });

  app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
    if (!quotes.purge(ctx.tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'offerte_gewist', { quoteId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createQuoteStore, registerQuoteRoutes, sanitizeProfile, PROFILE_DEFAULTS, Core };
