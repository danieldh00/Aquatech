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
const { FRONTEND_DIR } = require('../paths');
const { validEmail } = require('./mailer');
const { mailBody } = require('../verkoop/quotes');
const { preferencesOf } = require('./store');

const Releases = require(path.join(FRONTEND_DIR, 'nieuws', 'releases.js'));

const AUDIENCES = ['medewerkers', 'iedereen'];
const MAX = { title: 120, body: 4000 };
const LIST_LIMIT = 50;
const CACHE_MS = 30 * 1000;
const MAIL_LIMIT = 300;
const COLS = 'id, title, body, audience, pinned, author_id, author_name, created_at, updated_at';

/**
 * Huidig tijdstip als ISO-tekst.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Schoont een nieuwsbericht op: titel op één regel, tekst met regels en
 * alinea's maar zonder stuurtekens, doelgroep medewerkers of iedereen.
 * @param {object} raw De ruwe invoer.
 * @returns {{ value: { title: string, body: string, audience: string, pinned: boolean } }|{ error: string, field: string }} Het bericht of een foutmelding.
 */
function sanitizeNews(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim();
  // Regels en alinea's blijven staan; geen stuurtekens.
  const body = String(input.body ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!title) return { error: 'Geef het bericht een titel.', field: 'title' };
  if (title.length > MAX.title) return { error: `De titel mag maximaal ${MAX.title} tekens hebben.`, field: 'title' };
  if (!body) return { error: 'Schrijf een bericht.', field: 'body' };
  if (body.length > MAX.body) return { error: `Het bericht mag maximaal ${MAX.body} tekens hebben.`, field: 'body' };
  const audience = AUDIENCES.includes(input.audience) ? input.audience : 'medewerkers';
  return { value: { title, body, audience, pinned: input.pinned === true } };
}

/**
 * Maakt de opslag voor nieuwsberichten (tabel news), met per omgeving een korte cache voor de melding.
 * @param {object} db Databaseverbinding.
 * @returns {object} list, get, marks, create, update, remove, staffEmails en forget.
 */
function createNewsStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);
  const recent = new Map();

  /**
   * Zet een databaserij om naar een bericht voor de API.
   * @param {object} row Rij uit de tabel news.
   * @returns {object} Het bericht.
   */
  const toNewsItem = (row) => ({
    id: row.id, title: row.title, body: row.body, audience: row.audience, pinned: Boolean(row.pinned),
    authorId: row.author_id || null, authorName: row.author_name, createdAt: row.created_at, updatedAt: row.updated_at,
  });

  /**
   * Berichten voor de pagina: vastgezet eerst, dan de nieuwste. Klanten zien alleen 'iedereen'.
   * @param {string} tenantId De omgeving.
   * @param {{ customer?: boolean }} [options] customer = de lezer is een klant.
   * @returns {object[]} De berichten.
   */
  function list(tenantId, { customer = false } = {}) {
    const filter = customer ? " AND audience = 'iedereen'" : '';
    return prepare(`SELECT ${COLS} FROM news WHERE tenant_id = ?${filter} ORDER BY pinned DESC, created_at DESC LIMIT ${LIST_LIMIT}`)
      .all(tenantId).map(toNewsItem);
  }

  /**
   * Haalt één bericht op.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van het bericht.
   * @returns {object|null} Het bericht, of null.
   */
  function get(tenantId, id) {
    const row = prepare(`SELECT ${COLS} FROM news WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return row ? toNewsItem(row) : null;
  }

  /**
   * Tijdstip, doelgroep en auteur van de laatste berichten (voor de melding), 30 s in het geheugen.
   * @param {string} tenantId De omgeving.
   * @returns {object[]} De rijen (created_at, audience, author_id).
   */
  function marks(tenantId) {
    const hit = recent.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = prepare(`SELECT created_at, audience, author_id FROM news WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`).all(tenantId);
    recent.set(tenantId, { at: Date.now(), rows });
    return rows;
  }
  /**
   * Vergeet de cache van een omgeving (na een wijziging).
   * @param {string} tenantId De omgeving.
   * @returns {boolean} Of er iets in de cache stond.
   */
  const forget = (tenantId) => recent.delete(tenantId);

  /**
   * Plaatst een nieuw bericht.
   * @param {string} tenantId De omgeving.
   * @param {object} user De auteur.
   * @param {object} raw De invoer.
   * @returns {{ item: object }|{ error: string, field: string }} Het bericht of een foutmelding.
   */
  function create(tenantId, user, raw) {
    const cleaned = sanitizeNews(raw);
    if (cleaned.error) return cleaned;
    const timestamp = currentTimestamp();
    const item = { id: crypto.randomUUID(), ...cleaned.value };
    prepare(`INSERT INTO news (id, tenant_id, title, body, audience, pinned, author_id, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, tenantId, item.title, item.body, item.audience, item.pinned ? 1 : 0, user.id, user.display_name || '', timestamp, timestamp);
    forget(tenantId);
    return { item: get(tenantId, item.id) };
  }

  /**
   * Wijzigt een bericht; ontbrekende velden blijven gelijk.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van het bericht.
   * @param {object} raw De gewijzigde velden.
   * @returns {{ item: object }|{ error: string, field?: string, status?: number }} Het bericht of een foutmelding (status 404 als het niet bestaat).
   */
  function update(tenantId, id, raw) {
    const current = get(tenantId, id);
    if (!current) return { error: 'Bericht niet gevonden.', status: 404 };
    const cleaned = sanitizeNews({ title: current.title, body: current.body, audience: current.audience, pinned: current.pinned, ...raw });
    if (cleaned.error) return cleaned;
    prepare('UPDATE news SET title = ?, body = ?, audience = ?, pinned = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
      .run(cleaned.value.title, cleaned.value.body, cleaned.value.audience, cleaned.value.pinned ? 1 : 0, currentTimestamp(), tenantId, current.id);
    forget(tenantId);
    return { item: get(tenantId, current.id) };
  }

  /**
   * Verwijdert een bericht.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van het bericht.
   * @returns {boolean} true als het bestond.
   */
  function remove(tenantId, id) {
    const deleted = prepare('DELETE FROM news WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes;
    forget(tenantId);
    return deleted > 0;
  }

  /**
   * E-mailadressen van actieve medewerkers met een eigen account (niet de afzender, geen klanten).
   * @param {string[]} tenantIds De omgevingen van de organisatie.
   * @param {{ exceptId: string, isCustomerRole: Function }} options Id van de afzender en de functie (rol) => is klantrol.
   * @returns {string[]} De e-mailadressen, in kleine letters.
   */
  function staffEmails(tenantIds, { exceptId, isCustomerRole }) {
    const ids = [...new Set(tenantIds)];
    return prepare(`SELECT id, email, role FROM users WHERE tenant_id IN (${ids.map(() => '?').join(', ')})
       AND kind = 'account' AND disabled = 0 AND email IS NOT NULL AND email <> ''`).all(...ids)
      .filter((user) => user.id !== exceptId && !isCustomerRole(user.role) && validEmail(user.email))
      .map((user) => user.email.trim().toLowerCase());
  }

  return { list, get, marks, create, update, remove, staffEmails, forget };
}

/**
 * Aantal nieuwe items voor de melding: berichten na het vorige bezoek (niet de
 * eigen) en nieuwe versies met iets voor deze rechten. Zonder vorig bezoek telt
 * alles vanaf het aanmaken van het account, en van de versies alleen de laatste
 * (geen lange lijst bij de eerste keer).
 * @param {{ marks: object[], prefs: object, user: object, rights: string[], customer: boolean }} input Laatste berichten, voorkeuren, gebruiker, rechten en of het een klant is.
 * @returns {number} Aantal nieuwe items.
 */
function unreadCount({ marks, prefs, user, rights, customer }) {
  const since = prefs.newsSeenAt || user.created_at || '';
  const messages = marks.filter((mark) => mark.created_at > since && mark.author_id !== user.id && (!customer || mark.audience === 'iedereen')).length;
  const versions = Releases.visibleFor(rights);
  let releases;
  if (prefs.seenRelease) releases = versions.filter((release) => Releases.compare(release.version, prefs.seenRelease) > 0).length;
  else releases = versions.length && versions[0].date >= String(user.created_at || '').slice(0, 10) ? 1 : 0;
  return messages + releases;
}

/**
 * Registreert de routes /api/news (lezen, plaatsen, wijzigen, verwijderen) en /api/news/seen.
 * @param {object} app De Express-app.
 * @param {object} context news, store, requireUser, requireRight, requireJson, audit, isCustomer(req, user), staffTenantsOf(req), settingsOf(req) en mailerFor.
 * @returns {void}
 */
function registerNewsRoutes(app, context) {
  const { news, store, requireUser, requireRight, requireJson, audit, isCustomer, staffTenantsOf, settingsOf, mailerFor } = context;
  const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
  const requireNews = requireRight('nieuws');
  /**
   * Omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de actieve omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 'bericht niet gevonden'.
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Bericht niet gevonden.' });
  /**
   * Eigen account (geen toegangscode of gast, geen impersonatie): alleen dan wordt het vorige bezoek onthouden.
   * @param {object} user De gebruiker.
   * @returns {boolean} true bij een eigen account.
   */
  const ownAccount = (user) => user.kind === 'account' && !user.impersonation;

  app.get('/api/news', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = req.user;
    const rights = Roles.rightsOf(user);
    const prefs = ownAccount(user) ? preferencesOf(user) : null;
    res.json({
      items: news.list(tenantOf(req), { customer: isCustomer(req, user) }),
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
    const out = store.updateProfile(req.user.id, { preferences: { newsSeenAt: currentTimestamp(), seenRelease: Releases.latest } });
    if (out.error) return res.status(400).json({ error: 'no_account', message: out.error });
    res.json({ ok: true, unread: 0 });
  });

  /**
   * Stuurt een bericht per e-mail naar de collega's (los per ontvanger, zodat niemand andermans adres ziet).
   * @param {object} req Het Express-verzoek.
   * @param {object} item Het bericht.
   * @returns {{ sent: number, error?: string }} Aantal ontvangers, of een foutmelding als er geen mailserver is.
   */
  function mail(req, item) {
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return { sent: 0, error: 'Er is geen mailserver ingesteld.' };
    const to = news.staffEmails(staffTenantsOf(req), {
      exceptId: req.user.id,
      isCustomerRole: (role) => store.roles.get(tenantOf(req), role)?.kind === 'klant',
    }).slice(0, MAIL_LIMIT);
    const profile = settings.get('quoteProfile');
    const { text, html } = mailBody(profile, [item.title, item.body, `— ${item.authorName}`, 'Dit bericht staat ook in de app onder Nieuws.'], null);
    for (const address of to) {
      mailer.send({ to: address, replyTo: req.user.email || profile.email, subject: `Nieuws: ${item.title}`, text, html })
        .catch((err) => console.warn(`Nieuwsbericht niet verstuurd: ${err.message}`));
    }
    return { sent: to.length };
  }

  app.post('/api/news', requireJson, requireNews, (req, res) => {
    const out = news.create(tenantOf(req), req.user, req.body);
    if (out.error) return res.status(400).json({ error: 'invalid_news', field: out.field, message: out.error });
    const mailed = req.body?.mail === true ? mail(req, out.item) : null;
    audit(req, 'nieuws_geplaatst', { id: out.item.id, doelgroep: out.item.audience, mail: mailed ? mailed.sent : 0 });
    res.status(201).json({ item: out.item, mailed });
  });

  app.put('/api/news/:id', requireJson, requireNews, (req, res) => {
    const input = {};
    for (const field of ['title', 'body', 'audience', 'pinned']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    const out = news.update(tenantOf(req), req.params.id, input);
    if (out.status === 404) return notFound(res);
    if (out.error) return res.status(400).json({ error: 'invalid_news', field: out.field, message: out.error });
    audit(req, 'nieuws_gewijzigd', { id: out.item.id, velden: Object.keys(input) });
    res.json({ item: out.item });
  });

  app.delete('/api/news/:id', requireNews, (req, res) => {
    if (!news.remove(tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'nieuws_verwijderd', { id: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createNewsStore, registerNewsRoutes, sanitizeNews, unreadCount, Releases, AUDIENCES };
