// Nieuws: berichten van de organisatie (intranet) en het versielogboek in
// gewone taal (frontend/nieuws/releases.js), samen op de pagina Nieuws.
//
// - Een beheerder (recht `nieuws`) plaatst berichten voor de medewerkers of
//   voor iedereen (ook klanten), kan ze vastzetten en desgewenst per e-mail
//   naar de collega's sturen. Klanten krijgen nooit een e-mail (alleen in
//   de app), zodat er geen nieuwsbrief zonder toestemming ontstaat.
// - Berichten horen bij de omgeving (req.tenantId): een testomgeving heeft
//   eigen berichten.
// - "Nieuw sinds je vorige bezoek": de voorkeuren `newsSeenAt` (tijdstip) en
//   `seenRelease` (versie) van het account. /api/me geeft het aantal nieuwe
//   items; daarvoor houdt de server per omgeving de laatste berichten (alleen
//   tijdstip, doelgroep en auteur) 30 s in het geheugen, zodat api/me op elke
//   pagina geen extra query kost.
const crypto = require('crypto');
const path = require('path');
const { validEmail } = require('./mailer');
const { mailBody } = require('./quotes');
const { preferencesOf } = require('./store');

const Releases = require(path.join(__dirname, '..', '..', 'frontend', 'nieuws', 'releases.js'));

const AUDIENCES = ['medewerkers', 'iedereen'];
const MAX = { title: 120, body: 4000 };
const LIST_LIMIT = 50;
const CACHE_MS = 30 * 1000;
const MAIL_LIMIT = 300;
const COLS = 'id, title, body, audience, pinned, author_id, author_name, created_at, updated_at';

const now = () => new Date().toISOString();

/** Schoont een bericht op; geeft { value } of { error, field }. */
function sanitizeNews(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
  // Regels en alinea's blijven staan; geen stuurtekens.
  const body = String(r.body ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!title) return { error: 'Geef het bericht een titel.', field: 'title' };
  if (title.length > MAX.title) return { error: `De titel mag maximaal ${MAX.title} tekens hebben.`, field: 'title' };
  if (!body) return { error: 'Schrijf een bericht.', field: 'body' };
  if (body.length > MAX.body) return { error: `Het bericht mag maximaal ${MAX.body} tekens hebben.`, field: 'body' };
  const audience = AUDIENCES.includes(r.audience) ? r.audience : 'medewerkers';
  return { value: { title, body, audience, pinned: r.pinned === true } };
}

function createNewsStore(db) {
  const q = (sql) => db.prepare(sql);
  const recent = new Map();

  const shape = (r) => ({
    id: r.id, title: r.title, body: r.body, audience: r.audience, pinned: Boolean(r.pinned),
    authorId: r.author_id || null, authorName: r.author_name, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  /** Berichten voor de pagina: vastgezet eerst, dan de nieuwste. Klanten alleen 'iedereen'. */
  function list(tenantId, { customer = false } = {}) {
    const filter = customer ? " AND audience = 'iedereen'" : '';
    return q(`SELECT ${COLS} FROM news WHERE tenant_id = ?${filter} ORDER BY pinned DESC, created_at DESC LIMIT ${LIST_LIMIT}`)
      .all(tenantId).map(shape);
  }

  function get(tenantId, id) {
    const r = q(`SELECT ${COLS} FROM news WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return r ? shape(r) : null;
  }

  // Tijdstip, doelgroep en auteur van de laatste berichten (voor de melding).
  function marks(tenantId) {
    const hit = recent.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = q(`SELECT created_at, audience, author_id FROM news WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`).all(tenantId);
    recent.set(tenantId, { at: Date.now(), rows });
    return rows;
  }
  const forget = (tenantId) => recent.delete(tenantId);

  function create(tenantId, user, raw) {
    const s = sanitizeNews(raw);
    if (s.error) return s;
    const t = now();
    const item = { id: crypto.randomUUID(), ...s.value };
    q(`INSERT INTO news (id, tenant_id, title, body, audience, pinned, author_id, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, tenantId, item.title, item.body, item.audience, item.pinned ? 1 : 0, user.id, user.display_name || '', t, t);
    forget(tenantId);
    return { item: get(tenantId, item.id) };
  }

  function update(tenantId, id, raw) {
    const cur = get(tenantId, id);
    if (!cur) return { error: 'Bericht niet gevonden.', status: 404 };
    const s = sanitizeNews({ title: cur.title, body: cur.body, audience: cur.audience, pinned: cur.pinned, ...raw });
    if (s.error) return s;
    q('UPDATE news SET title = ?, body = ?, audience = ?, pinned = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
      .run(s.value.title, s.value.body, s.value.audience, s.value.pinned ? 1 : 0, now(), tenantId, cur.id);
    forget(tenantId);
    return { item: get(tenantId, cur.id) };
  }

  function remove(tenantId, id) {
    const n = q('DELETE FROM news WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes;
    forget(tenantId);
    return n > 0;
  }

  /** E-mailadressen van actieve medewerkers met een eigen account (niet de afzender). */
  function staffEmails(tenantIds, { exceptId, isCustomerRole }) {
    const ids = [...new Set(tenantIds)];
    return q(`SELECT id, email, role FROM users WHERE tenant_id IN (${ids.map(() => '?').join(', ')})
       AND kind = 'account' AND disabled = 0 AND email IS NOT NULL AND email <> ''`).all(...ids)
      .filter((u) => u.id !== exceptId && !isCustomerRole(u.role) && validEmail(u.email))
      .map((u) => u.email.trim().toLowerCase());
  }

  return { list, get, marks, create, update, remove, staffEmails, forget };
}

/**
 * Aantal nieuwe items voor de melding: berichten na het vorige bezoek (niet
 * de eigen) en nieuwe versies met iets voor deze rechten. Zonder vorig bezoek
 * telt alles vanaf het aanmaken van het account, en van de versies alleen de
 * laatste (geen lange lijst bij de eerste keer).
 */
function unreadCount({ marks, prefs, user, rights, customer }) {
  const since = prefs.newsSeenAt || user.created_at || '';
  const messages = marks.filter((m) => m.created_at > since && m.author_id !== user.id && (!customer || m.audience === 'iedereen')).length;
  const versions = Releases.visibleFor(rights);
  let releases;
  if (prefs.seenRelease) releases = versions.filter((r) => Releases.compare(r.version, prefs.seenRelease) > 0).length;
  else releases = versions.length && versions[0].date >= String(user.created_at || '').slice(0, 10) ? 1 : 0;
  return messages + releases;
}

/**
 * API. ctx: { news, store, requireUser, requireRight, requireJson, audit,
 * identify, isCustomer(req, user), staffTenantsOf(req), settingsOf(req), mailerFor }.
 */
function registerNewsRoutes(app, ctx) {
  const { news, store, requireUser, requireRight, requireJson, audit, isCustomer, staffTenantsOf, settingsOf, mailerFor } = ctx;
  const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));
  const requireNews = requireRight('nieuws');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Bericht niet gevonden.' });
  // Eigen account (geen toegangscode of gast, geen impersonatie): alleen dan
  // wordt het vorige bezoek onthouden.
  const ownAccount = (user) => user.kind === 'account' && !user.impersonation;

  app.get('/api/news', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = req.user;
    const rights = Roles.rightsOf(user);
    const prefs = ownAccount(user) ? preferencesOf(user) : null;
    res.json({
      items: news.list(tid(req), { customer: isCustomer(req, user) }),
      releases: Releases.visibleFor(rights),
      // Vorige bezoek: wat daarna kwam, krijgt op de pagina het label Nieuw.
      seen: prefs ? { at: prefs.newsSeenAt || user.created_at || '', release: prefs.seenRelease || '' } : null,
      canPost: Roles.can(user, 'nieuws'),
      canMail: Roles.can(user, 'nieuws') && mailerFor(settingsOf(req)).configured(),
    });
  });

  // De pagina is bekeken: alles tot nu is gezien (geen auditregel, het is geen wijziging).
  app.post('/api/news/seen', requireJson, requireUser, (req, res) => {
    if (!ownAccount(req.user)) return res.json({ ok: true, unread: 0 });
    const out = store.updateProfile(req.user.id, { preferences: { newsSeenAt: now(), seenRelease: Releases.latest } });
    if (out.error) return res.status(400).json({ error: 'no_account', message: out.error });
    res.json({ ok: true, unread: 0 });
  });

  // Per e-mail naar de collega's (los per ontvanger, zodat niemand andermans adres ziet).
  function mail(req, item) {
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return { sent: 0, error: 'Er is geen mailserver ingesteld.' };
    const to = news.staffEmails(staffTenantsOf(req), {
      exceptId: req.user.id,
      isCustomerRole: (role) => store.roles.get(tid(req), role)?.kind === 'klant',
    }).slice(0, MAIL_LIMIT);
    const p = settings.get('quoteProfile');
    const { text, html } = mailBody(p, [item.title, item.body, `— ${item.authorName}`, 'Dit bericht staat ook in de app onder Nieuws.'], null);
    for (const addr of to) {
      mailer.send({ to: addr, replyTo: req.user.email || p.email, subject: `Nieuws: ${item.title}`, text, html })
        .catch((err) => console.warn(`Nieuwsbericht niet verstuurd: ${err.message}`));
    }
    return { sent: to.length };
  }

  app.post('/api/news', requireJson, requireNews, (req, res) => {
    const out = news.create(tid(req), req.user, req.body);
    if (out.error) return res.status(400).json({ error: 'invalid_news', field: out.field, message: out.error });
    const mailed = req.body?.mail === true ? mail(req, out.item) : null;
    audit(req, 'nieuws_geplaatst', { id: out.item.id, doelgroep: out.item.audience, mail: mailed ? mailed.sent : 0 });
    res.status(201).json({ item: out.item, mailed });
  });

  app.put('/api/news/:id', requireJson, requireNews, (req, res) => {
    const input = {};
    for (const k of ['title', 'body', 'audience', 'pinned']) if (req.body?.[k] !== undefined) input[k] = req.body[k];
    const out = news.update(tid(req), req.params.id, input);
    if (out.status === 404) return notFound(res);
    if (out.error) return res.status(400).json({ error: 'invalid_news', field: out.field, message: out.error });
    audit(req, 'nieuws_gewijzigd', { id: out.item.id, velden: Object.keys(input) });
    res.json({ item: out.item });
  });

  app.delete('/api/news/:id', requireNews, (req, res) => {
    if (!news.remove(tid(req), req.params.id)) return notFound(res);
    audit(req, 'nieuws_verwijderd', { id: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createNewsStore, registerNewsRoutes, sanitizeNews, unreadCount, Releases, AUDIENCES };
