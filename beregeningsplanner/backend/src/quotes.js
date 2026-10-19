// Offertes: opslag (tabel quotes), het bedrijfsprofiel voor op de offerte
// (instelling quoteProfile) en de API-routes. De berekening zelf staat in
// frontend/offertes/quote-core.js en is gedeeld met de browser.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');
const { createVault } = require('./vault');
const { createMailer, validEmail } = require('./mailer');

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

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const parseJson = (v) => {
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};

// De openbare link: <basis>/openbaar/offerte.html#t=<token>. De basis komt van
// de browser van de installateur (de server kent zijn eigen adres achter een
// proxy met padprefix niet) en moet precies naar die pagina wijzen.
function validShareBase(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.pathname.endsWith('/openbaar/offerte.html')
      ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

// Handtekening: een PNG als data-URL van hooguit ~200 kB.
function validSignature(v) {
  if (typeof v !== 'string' || v.length > 280000 || !v.startsWith('data:image/png;base64,')) return false;
  const buf = Buffer.from(v.slice(22), 'base64');
  return buf.length > 100 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function createQuoteStore(db, { vault = createVault() } = {}) {
  const q = (sql) => db.prepare(sql);
  const tokenCtx = (r) => `${r.tenant_id}:offertelink:${r.id}`;

  // Stand van de openbare link voor wie de offerte bewerkt (met de link zelf).
  function shareOf(r) {
    let url = null;
    if (r.share_hash && r.share_token && r.share_url) {
      try { url = `${r.share_url}#t=${vault.open(r.share_token, tokenCtx(r))}`; } catch { url = null; }
    }
    return {
      active: Boolean(r.share_hash), url, sharedAt: r.shared_at || null, viewedAt: r.viewed_at || null,
      lastViewedAt: r.last_viewed_at || null, viewCount: r.view_count || 0, sentAt: r.sent_at || null, sentTo: r.sent_to || null,
    };
  }

  function row(r, withData) {
    const out = {
      id: r.id, number: r.number, status: r.status, title: r.title, customer: r.customer, planId: r.plan_id || null,
      totalExcl: r.total_excl, totalIncl: r.total_incl, createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.valid_until !== undefined) out.validUntil = r.valid_until;
    if (r.owner_name !== undefined) out.owner = { id: r.owner_id, username: r.owner_username, displayName: r.owner_name };
    out.customerId = r.customer_id || null;
    if (r.customer_name !== undefined) out.customerAccount = r.customer_id ? { id: r.customer_id, displayName: r.customer_name } : null;
    if (r.view_count !== undefined) {
      out.viewedAt = r.viewed_at || null;
      out.respondedAt = r.responded_at || null;
    }
    if (withData) {
      out.data = JSON.parse(r.data);
      out.share = shareOf(r);
      out.acceptance = parseJson(r.acceptance);
    }
    return out;
  }

  // Wat een klant van een offerte te zien krijgt: met de opmaak "totaal per
  // onderdeel" geen prijzen per regel, wel de totalen.
  // Een optie houdt zijn prijs: de klant moet kunnen zien wat die kost.
  function forCustomer(quote) {
    const { share, ...rest } = quote;
    const out = { ...rest, totals: Core.totals(quote.data) };
    if (quote.data.layout === 'totaal') {
      // Zonder regelprijzen kan de klantpagina het totaal bij een andere
      // optiekeuze niet herberekenen; daarom per sectie en btw-tarief de som
      // van de vaste regels.
      const fixed = new Map();
      for (const l of quote.data.lines) {
        if (l.optional) continue;
        const key = `${l.section}|${l.vat}`;
        const cur = fixed.get(key) || { section: l.section, vat: l.vat, amount: 0 };
        cur.amount += Core.lineTotal(l);
        fixed.set(key, cur);
      }
      out.fixed = [...fixed.values()];
      out.data = { ...quote.data, lines: quote.data.lines.map((l) => (l.optional ? l
        : { id: l.id, section: l.section, description: l.description, qty: l.qty, unit: l.unit, optional: false, selected: false })) };
    }
    if (quote.acceptance) {
      const a = quote.acceptance;
      out.acceptance = { answer: a.answer, name: a.name, at: a.at, via: a.via, signature: a.signature || null, reason: a.reason || '', totalIncl: a.totalIncl, contentHash: a.contentHash || null };
    }
    return out;
  }

  // customerId: alleen de offertes van dat klantaccount, en geen concepten.
  function list(tenantId, { ownerId = null, planId = null, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT q.id, q.number, q.status, q.title, q.customer, q.plan_id, q.total_excl, q.total_incl, q.created_at, q.updated_at,
        json_extract(q.data, '$.validUntil') AS valid_until, q.owner_id, u.username AS owner_username, u.display_name AS owner_name,
        q.customer_id, c.display_name AS customer_name, q.view_count, q.viewed_at, q.responded_at
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
      // Na een vastgelegd akkoord ligt de offerte vast (bewijs van wat er is
      // geaccordeerd); wijzigen kan alleen in een kopie.
      if (r.acceptance && (rawData !== undefined || (status !== undefined && status !== r.status))) return { locked: true };
      const data = rawData === undefined ? JSON.parse(r.data) : Core.sanitize(rawData);
      const f = fields(data);
      const st = STATUSES.includes(status) ? status : r.status;
      const cid = customerId === undefined ? r.customer_id : customerId || null;
      q(`UPDATE quotes SET plan_id = ?, status = ?, title = ?, customer = ?, total_excl = ?, total_incl = ?, data = ?, updated_at = ?, customer_id = ? WHERE id = ?`)
        .run(data.planId || null, st, f.title, f.customer, f.totalExcl, f.totalIncl, JSON.stringify(data), now(), cid, r.id);
      return fullRow(r.id);
    });
  }

  /**
   * Reactie van de klant op een verzonden offerte (via de openbare link of
   * een klantaccount). Akkoord: naam, handtekening, akkoord met de voorwaarden
   * en de gekozen opties; de offerte ligt daarna vast, met een hash van de
   * geaccordeerde inhoud. who = { ip, forwardedFor, userAgent, via, userId }.
   */
  function decide(r, answer, input, who) {
    if (!r || r.status === 'concept') return { error: 'not_found' };
    if (r.status !== 'verzonden' || r.acceptance) return { error: 'answered', status: r.status };
    let data = JSON.parse(r.data);
    if (answer === 'akkoord' && data.validUntil && data.validUntil < Core.today()) return { error: 'expired' };
    const name = String(input.name || '').trim().slice(0, 120);
    if (answer === 'akkoord') {
      if (name.length < 2) return { error: 'invalid', message: 'Vul uw naam in.' };
      if (input.terms !== true) return { error: 'invalid', message: 'Ga akkoord met de voorwaarden.' };
      if (!validSignature(input.signature)) return { error: 'invalid', message: 'Zet uw handtekening.' };
      data = Core.sanitize(Core.chooseOptions(data, input.options));
    }
    const at = now();
    const totals = Core.totals(data);
    const acceptance = {
      answer, name, at, via: who.via, userId: who.userId || null,
      ip: who.ip || '', forwardedFor: String(who.forwardedFor || '').slice(0, 100), userAgent: String(who.userAgent || '').slice(0, 300),
      signature: answer === 'akkoord' ? input.signature : null,
      termsAccepted: answer === 'akkoord',
      options: data.lines.filter((l) => l.optional && l.selected).map((l) => l.id),
      reason: answer === 'afgewezen' ? String(input.reason || '').trim().slice(0, 1000) : '',
      totalExcl: totals.net, totalIncl: totals.total,
      contentHash: sha256(JSON.stringify({ number: r.number, data, totals })),
    };
    return transaction(db, () => {
      const cur = q('SELECT status, acceptance FROM quotes WHERE id = ?').get(r.id);
      if (cur.status !== 'verzonden' || cur.acceptance) return { error: 'answered', status: cur.status };
      const f = fields(data);
      q('UPDATE quotes SET status = ?, data = ?, total_excl = ?, total_incl = ?, acceptance = ?, responded_at = ?, updated_at = ? WHERE id = ?')
        .run(answer, JSON.stringify(data), f.totalExcl, f.totalIncl, JSON.stringify(acceptance), at, at, r.id);
      return { quote: fullRow(r.id), row: q('SELECT * FROM quotes WHERE id = ?').get(r.id) };
    });
  }

  // Klantaccount (in de app).
  function respond(user, id, answer, input = {}, who = {}) {
    const r = q('SELECT * FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND customer_id = ?').get(user.tenant_id, String(id), user.id);
    const out = decide(r, answer, input, { ...who, via: 'account', userId: user.id });
    return out.quote ? { ...out, quote: forCustomer(out.quote) } : out;
  }

  // ---------- Openbare link ----------
  function share(user, id, url) {
    const base = validShareBase(url);
    if (!base) return { error: 'invalid_url' };
    return transaction(db, () => {
      const r = findEditable(user, id);
      if (!r) return { error: 'not_found' };
      if (r.share_hash) {
        // Bestaande link houden (de klant heeft hem misschien al); alleen de basis bijwerken.
        q('UPDATE quotes SET share_url = ? WHERE id = ?').run(base, r.id);
      } else {
        const token = crypto.randomBytes(24).toString('base64url');
        q(`UPDATE quotes SET share_hash = ?, share_token = ?, share_url = ?, shared_at = ?, view_count = 0, viewed_at = NULL, last_viewed_at = NULL,
          status = CASE WHEN status = 'concept' THEN 'verzonden' ELSE status END, updated_at = ? WHERE id = ?`)
          .run(sha256(token), vault.seal(token, tokenCtx(r)), base, now(), now(), r.id);
      }
      return { quote: fullRow(r.id) };
    });
  }

  function unshare(user, id) {
    const r = findEditable(user, id);
    if (!r) return null;
    q('UPDATE quotes SET share_hash = NULL, share_token = NULL, shared_at = NULL WHERE id = ?').run(r.id);
    return fullRow(r.id);
  }

  function markSent(id, to) {
    q("UPDATE quotes SET sent_at = ?, sent_to = ?, status = CASE WHEN status = 'concept' THEN 'verzonden' ELSE status END WHERE id = ?").run(now(), String(to).slice(0, 400), id);
  }

  // Zoeken op token (over alle tenants; het token is het enige geheim).
  function byToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return q('SELECT * FROM quotes WHERE share_hash = ? AND deleted_at IS NULL').get(sha256(token)) || null;
  }

  function markViewed(r) {
    const ts = now();
    q('UPDATE quotes SET viewed_at = COALESCE(viewed_at, ?), last_viewed_at = ?, view_count = view_count + 1 WHERE id = ?').run(ts, ts, r.id);
  }

  // Wat de klant via de link ziet: zoals een klantaccount, zonder interne velden.
  function publicView(r) {
    const { owner, customerId, customerAccount, planId, viewedAt, respondedAt, ...rest } = forCustomer(fullRow(r.id));
    return rest;
  }

  const shareLink = (r) => shareOf(r).url;

  function remove(user, id) {
    const r = findEditable(user, id);
    if (!r) return false;
    q('UPDATE quotes SET deleted_at = ? WHERE id = ?').run(now(), r.id);
    return true;
  }

  // Nummer van een geaccordeerde offerte (null als die niet akkoord is):
  // verwijderen daarvan vraagt een extra bevestiging met het offertenummer.
  function acceptedNumber(tenantId, id) {
    const r = q('SELECT number, status FROM quotes WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    return r && r.status === 'akkoord' ? r.number : null;
  }

  // Definitief wissen (AVG-verzoek): ook al verwijderde offertes.
  function purge(tenantId, id) {
    return q('DELETE FROM quotes WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
  }

  return { list, get, create, update, respond, decide, share, unshare, markSent, byToken, markViewed, publicView, shareLink, remove, purge, acceptedNumber, nextNumber };
}

const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** E-mail in huisstijl: tekst + html met alinea's en optioneel een knop. */
function mailBody(profile, paragraphs, button) {
  const paras = paragraphs.map((t) => String(t || '').trim()).filter(Boolean);
  const sign = [profile.companyName, profile.phone, profile.email, profile.website].filter(Boolean);
  const text = [...paras, button ? `${button.label}: ${button.href}` : '', '', ...sign].filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n\n');
  const href = button && /^https?:\/\//.test(button.href) ? button.href : null;
  const html = `<!doctype html><html lang="nl"><body style="margin:0;background:#f4f6f9;font-family:Montserrat,Arial,sans-serif;color:#1d2733">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#172f5e;color:#ffffff;padding:18px 24px;font-size:18px;font-weight:700">${escHtml(profile.companyName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">
${paras.map((t) => `<p style="margin:0 0 14px">${escHtml(t).replace(/\n/g, '<br>')}</p>`).join('')}
${href ? `<p style="margin:22px 0"><a href="${escHtml(href)}" style="background:#19924f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;display:inline-block">${escHtml(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px;border-top:3px solid #2cb0c0;font-size:12px;color:#6b7785">${sign.map(escHtml).join(' · ')}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
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
  // Openbare link: instellingen van de tenant van de offerte, en geen
  // uitgeschakelde tenants. mailerFor is te vervangen in tests.
  const settingsForTenant = ctx.settingsForTenant;
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const publicLimiter = ctx.publicLimiter || ((req, res, next) => next());
  const who = (req) => ({
    ip: remoteIp(req),
    // Achter Cloudflare/een proxy: het opgegeven adres van de bezoeker (ter informatie).
    forwardedFor: req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || '',
  });
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
    const settings = settingsOf(req);
    res.json({ profile: settings.get('quoteProfile'), canEdit: Roles.can(user, 'beheer'), mail: Roles.can(user, 'offertes') && mailerFor(settings).configured() });
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
    if (quote.locked) return res.status(409).json({ error: 'locked', message: 'Deze offerte is digitaal beantwoord en ligt vast. Maak een kopie om iets te wijzigen.' });
    res.json(quote);
  });

  // Antwoord op een fout bij akkoord of afwijzen (klantaccount en openbare link).
  function decideError(res, out) {
    if (out.error === 'not_found') return notFound(res);
    if (out.error === 'answered') return res.status(409).json({ error: 'answered', message: `Deze offerte is al ${out.status === 'akkoord' ? 'geaccepteerd' : out.status === 'afgewezen' ? 'afgewezen' : 'beantwoord'}.` });
    if (out.error === 'expired') return res.status(409).json({ error: 'expired', message: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.' });
    return res.status(400).json({ error: 'invalid', message: out.message || 'Ongeldige invoer.' });
  }
  const validAnswer = (a) => a === 'akkoord' || a === 'afgewezen';

  // Na een akkoord of afwijzing: bevestiging naar de klant en bericht naar het
  // bedrijf, als er een mailserver is. Mislukt dat, dan blijft het akkoord staan.
  function notifyDecision(settings, row) {
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return Promise.resolve();
    const p = settings.get('quoteProfile');
    const data = JSON.parse(row.data);
    const a = JSON.parse(row.acceptance);
    const link = quotes.shareLink(row);
    const when = new Date(a.at).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
    const total = Number(a.totalIncl || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
    const jobs = [];
    if (a.answer === 'akkoord' && validEmail(data.customer.email)) {
      jobs.push(mailer.send({
        to: data.customer.email, replyTo: p.email,
        subject: `Bevestiging: offerte ${row.number} geaccordeerd`,
        ...mailBody(p, [
          `Beste ${a.name},`,
          `Bedankt voor uw akkoord op offerte ${row.number}${data.title ? ` (${data.title})` : ''} op ${when}, voor ${total} incl. btw.`,
          link ? 'Via de knop hieronder bekijkt u de geaccordeerde offerte met uw handtekening; daar kunt u hem ook als PDF opslaan.' : '',
          'Wij nemen contact met u op om de werkzaamheden in te plannen.',
        ], link ? { label: 'Geaccordeerde offerte bekijken', href: link } : null),
      }));
    }
    if (validEmail(p.email)) {
      const lines = a.answer === 'akkoord'
        ? [`${a.name} heeft offerte ${row.number}${data.customer.name ? ` voor ${data.customer.name}` : ''} geaccordeerd op ${when}, voor ${total} incl. btw.`]
        : [`${a.name || 'De klant'} heeft offerte ${row.number}${data.customer.name ? ` voor ${data.customer.name}` : ''} afgewezen op ${when}.`, a.reason ? `Reden: ${a.reason}` : ''];
      jobs.push(mailer.send({ to: p.email, subject: `Offerte ${row.number} ${a.answer === 'akkoord' ? 'geaccordeerd' : 'afgewezen'}`, ...mailBody(p, lines, link ? { label: 'Offerte bekijken', href: link } : null) }));
    }
    return Promise.allSettled(jobs).then((rs) => {
      for (const r of rs) if (r.status === 'rejected') console.warn(`Bevestiging offerte ${row.number} niet verstuurd: ${r.reason?.message || r.reason}`);
    });
  }

  // De klant (klantaccount) accepteert of wijst af (alleen een verzonden offerte).
  app.post('/api/quotes/:id/respond', requireJson, requireRight('offertes.klant'), (req, res) => {
    const answer = req.body?.answer;
    if (!validAnswer(answer)) return res.status(400).json({ error: 'invalid_answer', message: 'Kies akkoord of afwijzen.' });
    const out = quotes.respond(req.user, req.params.id, answer, req.body || {}, who(req));
    if (out.error) return decideError(res, out);
    audit(req, answer === 'akkoord' ? 'offerte_akkoord' : 'offerte_afgewezen', { quoteId: out.quote.id, number: out.quote.number, via: 'account' });
    notifyDecision(settingsOf(req), out.row);
    res.json(out.quote);
  });

  // ---------- Openbare link (digitale offerte) ----------
  // Link maken (of de bestaande houden): de offerte gaat naar Verzonden.
  app.post('/api/quotes/:id/share', requireJson, requireQuotes, (req, res) => {
    const out = quotes.share(req.user, req.params.id, req.body?.url);
    if (out.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (out.error) return notFound(res);
    audit(req, 'offertelink_gemaakt', { quoteId: out.quote.id, number: out.quote.number });
    res.json(out.quote);
  });

  // Link intrekken: de oude link werkt niet meer.
  app.delete('/api/quotes/:id/share', requireQuotes, (req, res) => {
    const quote = quotes.unshare(req.user, req.params.id);
    if (!quote) return notFound(res);
    audit(req, 'offertelink_ingetrokken', { quoteId: quote.id, number: quote.number });
    res.json(quote);
  });

  // Versturen per e-mail met de link (maakt de link zo nodig aan).
  app.post('/api/quotes/:id/send', requireJson, requireQuotes, wrapAsync(async (req, res) => {
    const { to, subject, message, url } = req.body || {};
    const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
    if (!list.length || list.length > 5 || !list.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Er is geen mailserver ingesteld (Offertes → Bedrijfsgegevens → E-mail).' });
    const shared = quotes.share(req.user, req.params.id, url);
    if (shared.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (shared.error) return notFound(res);
    const quote = shared.quote;
    const p = settings.get('quoteProfile');
    const text = String(message || '').slice(0, 5000);
    try {
      await mailer.send({
        to: list, replyTo: p.email,
        subject: String(subject || `Offerte ${quote.number} van ${p.companyName}`).slice(0, 300),
        ...mailBody(p, text.split(/\n{2,}/), { label: 'Offerte bekijken en accorderen', href: quote.share.url }),
      });
    } catch (err) {
      console.warn(`Offerte ${quote.number} niet verstuurd: ${err.message}`);
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${err.message}` });
    }
    quotes.markSent(quote.id, list.join(', '));
    audit(req, 'offerte_verstuurd', { quoteId: quote.id, number: quote.number, recipients: list.length });
    res.json(quotes.get(req.user, quote.id));
  }));

  // De klant opent de link. Het token komt in een kop mee (niet in de URL van
  // het verzoek, dus niet in logboeken van proxy's).
  const tokenOf = (req) => String(req.headers['x-offerte-token'] || '');
  function publicQuote(req, res) {
    const r = quotes.byToken(tokenOf(req));
    if (!r || r.status === 'concept' || !tenantActive(r.tenant_id)) {
      res.status(404).json({ error: 'not_found', message: 'Deze offerte is niet (meer) beschikbaar. Neem contact op met de afzender.' });
      return null;
    }
    return r;
  }

  app.get('/api/public/quote', publicLimiter, (req, res) => {
    const r = publicQuote(req, res);
    if (!r) return;
    if (req.query.preview !== '1') quotes.markViewed(r);
    const settings = settingsForTenant(r.tenant_id);
    res.json({ quote: quotes.publicView(r), profile: settings.get('quoteProfile') });
  });

  app.post('/api/public/quote/respond', publicLimiter, requireJson, (req, res) => {
    const r = publicQuote(req, res);
    if (!r) return;
    const answer = req.body?.answer;
    if (!validAnswer(answer)) return res.status(400).json({ error: 'invalid_answer', message: 'Kies akkoord of afwijzen.' });
    const out = quotes.decide(r, answer, req.body || {}, { ...who(req), via: 'link' });
    if (out.error) return decideError(res, out);
    audit(req, answer === 'akkoord' ? 'offerte_akkoord' : 'offerte_afgewezen', { quoteId: r.id, number: r.number, via: 'link' }, null, r.tenant_id);
    notifyDecision(settingsForTenant(r.tenant_id), out.row);
    res.json({ quote: quotes.publicView(out.row) });
  });

  // ---------- Mailserver (beheerder) ----------
  const mailView = (settings) => ({ config: settings.get('mailServer'), passwordSet: Boolean(settings.get('mailPassword')) });
  app.get('/api/quote-mail', requireAdmin, (req, res) => res.json(mailView(settingsOf(req))));

  app.put('/api/quote-mail', requireJson, requireAdmin, (req, res) => {
    const settings = settingsOf(req);
    const patch = {};
    if (validData(req.body?.config)) patch.mailServer = { ...settings.get('mailServer'), ...req.body.config };
    if (typeof req.body?.password === 'string') patch.mailPassword = req.body.password;
    try {
      const changed = settings.update(patch, req.user?.id);
      if (changed.length) audit(req, 'instellingen_gewijzigd', { fields: changed });
    } catch (err) {
      return res.status(400).json({ error: 'invalid_setting', message: err.message });
    }
    res.json(mailView(settings));
  });

  app.post('/api/quote-mail/test', requireJson, requireAdmin, wrapAsync(async (req, res) => {
    const settings = settingsOf(req);
    const to = req.body?.to;
    if (!validEmail(to)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een geldig e-mailadres in.' });
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Vul eerst de mailserver en het afzenderadres in.' });
    try {
      await mailer.send({ to, subject: 'Testbericht van de offertemodule', ...mailBody(settings.get('quoteProfile'), ['Dit is een testbericht. De mailserver is goed ingesteld.'], null) });
    } catch (err) {
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${err.message}` });
    }
    res.json({ ok: true });
  }));

  // Een geaccordeerde offerte is een afspraak met de klant: verwijderen of
  // wissen alleen als het offertenummer als { confirm } is meegestuurd.
  const acceptedGuard = (req, res, tenantId) => {
    const number = quotes.acceptedNumber(tenantId, req.params.id);
    if (!number || String(req.body?.confirm ?? '').trim() === number) return false;
    res.status(409).json({ error: 'confirm_required', number, message: `Offerte ${number} is geaccordeerd door de klant. Typ ter bevestiging het offertenummer over.` });
    return true;
  };

  app.delete('/api/quotes/:id', requireQuotes, (req, res) => {
    if (acceptedGuard(req, res, req.user.tenant_id)) return;
    if (!quotes.remove(req.user, req.params.id)) return notFound(res);
    audit(req, 'offerte_verwijderd', { quoteId: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
    if (acceptedGuard(req, res, ctx.tenantOf(req))) return;
    if (!quotes.purge(ctx.tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'offerte_gewist', { quoteId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createQuoteStore, registerQuoteRoutes, sanitizeProfile, PROFILE_DEFAULTS, Core, validShareBase, validSignature, mailBody };
