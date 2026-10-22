// Impersonatie: een hoofdbeheerder werkt tijdelijk als een andere gebruiker,
// om mee te kijken of te helpen. In een testomgeving mag dat zonder
// goedkeuring; in live alleen zolang de gebruiker zelf supporttoegang heeft
// verleend (Dashboard > Support op afstand), en nooit langer dan die
// toestemming geldt. Elke start en elk einde staat in het auditlog, en wat er
// tijdens de impersonatie gebeurt krijgt in het auditlog de naam van de
// hoofdbeheerder erbij.
//
// De keuze staat in een ondertekende cookie (`<beheerder-id>:<impersonatie-id>`)
// naast de gewone sessie van de hoofdbeheerder; bij elk verzoek wordt de rij in
// `impersonations` opnieuw gecontroleerd (niet beëindigd, niet verlopen,
// toestemming nog geldig). Terug naar het eigen account = die rij beëindigen.
const crypto = require('crypto');
const { parseCookies } = require('./auth');

const IMP_COOKIE = 'aquatech_imp';
const IMP_HINT = 'aquatech_imp_hint';
const HOUR_MS = 60 * 60 * 1000;
// Hoe lang een gebruiker supporttoegang kan geven (uren), en de standaard.
const GRANT_HOURS = [1, 4, 24, 72];
const DEFAULT_GRANT_HOURS = 4;
// Een impersonatie duurt hoogstens zo lang (daarna opnieuw starten).
const MAX_IMPERSONATION_MS = 8 * HOUR_MS;

/**
 * Huidig tijdstip als ISO-tekst.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Nieuw willekeurig id (UUID).
 * @returns {string} Het id.
 */
const newId = () => crypto.randomUUID();

/**
 * Maakt de opslag voor supporttoegang (tabel support_grants) en impersonaties (tabel impersonations).
 * @param {object} db Databaseverbinding.
 * @returns {object} activeGrant, activeGrants, grant, revoke, start, get, end, openFor en recentFor.
 */
function createImpersonationStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * De lopende (niet ingetrokken, niet verlopen) supporttoegang van een gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {object|null} De rij uit support_grants die het laatst verloopt, of null.
   */
  function activeGrant(userId) {
    return prepare('SELECT id, tenant_id, user_id, created_at, expires_at, revoked_at FROM support_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1')
      .get(String(userId), currentTimestamp()) || null;
  }

  /**
   * De lopende supporttoegang van meerdere gebruikers in één query.
   * @param {string[]} userIds Id's van gebruikers.
   * @returns {Object<string, object>} Per gebruikers-id de rij die het laatst verloopt (zoals activeGrant).
   */
  function activeGrants(userIds) {
    const out = {};
    if (!userIds.length) return out;
    const rows = prepare(`SELECT id, user_id, created_at, expires_at FROM support_grants WHERE user_id IN (${userIds.map(() => '?').join(', ')}) AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at`).all(...userIds.map(String), currentTimestamp());
    for (const row of rows) out[row.user_id] = row; // de laatst verlopende wint, zoals in activeGrant
    return out;
  }

  /**
   * Geeft supporttoegang; een nieuwe toestemming vervangt de vorige.
   * @param {{ id: string, tenant_id: string }} user De gebruiker die toestemming geeft (met zijn eigen tenant).
   * @param {number} hours Hoe lang de toestemming geldt.
   * @returns {object} De nieuwe rij uit support_grants.
   */
  function grant(user, hours) {
    const timestamp = currentTimestamp();
    prepare('UPDATE support_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(timestamp, user.id);
    const row = { id: newId(), tenant_id: user.tenant_id, user_id: user.id, created_at: timestamp,
      expires_at: new Date(Date.now() + hours * HOUR_MS).toISOString(), revoked_at: null };
    prepare('INSERT INTO support_grants (id, tenant_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.tenant_id, row.user_id, row.created_at, row.expires_at);
    return row;
  }

  /**
   * Trekt de lopende supporttoegang van een gebruiker in.
   * @param {string} userId Id van de gebruiker.
   * @returns {number} Aantal ingetrokken toestemmingen.
   */
  function revoke(userId) {
    return prepare('UPDATE support_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').run(currentTimestamp(), userId, currentTimestamp()).changes;
  }

  /**
   * Legt het begin van een impersonatie vast.
   * @param {object} details tenantId (omgeving), adminId (hoofdbeheerder), userId (overgenomen gebruiker), grantId (toestemming, in live), reason en expiresAt.
   * @returns {object} De nieuwe rij uit impersonations.
   */
  function start({ tenantId, adminId, userId, grantId = null, reason = '', expiresAt }) {
    const row = { id: newId(), tenant_id: tenantId, admin_id: adminId, user_id: userId, grant_id: grantId, reason,
      started_at: currentTimestamp(), expires_at: expiresAt, ended_at: null, ended_reason: null };
    prepare(`INSERT INTO impersonations (id, tenant_id, admin_id, user_id, grant_id, reason, started_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, tenantId, adminId, userId, grantId, reason, row.started_at, expiresAt);
    return row;
  }

  const IMP_COLS = 'id, tenant_id, admin_id, user_id, grant_id, started_at, expires_at, ended_at';
  /**
   * Haalt één impersonatie op.
   * @param {string} id Id van de impersonatie.
   * @returns {object|null} De rij, of null.
   */
  const get = (id) => prepare(`SELECT ${IMP_COLS} FROM impersonations WHERE id = ?`).get(String(id)) || null;

  /**
   * Beëindigt een lopende impersonatie.
   * @param {string} id Id van de impersonatie.
   * @param {string} reason Reden ('gestopt', 'verlopen', 'toestemming_ingetrokken', ...).
   * @returns {boolean} true als hij nog liep en nu is beëindigd.
   */
  function end(id, reason) {
    return prepare('UPDATE impersonations SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL').run(currentTimestamp(), reason, id).changes > 0;
  }

  /**
   * Lopende impersonaties van een gebruiker (bijv. om ze te beëindigen bij het intrekken).
   * @param {string} userId Id van de overgenomen gebruiker.
   * @returns {object[]} De lopende rijen.
   */
  const openFor = (userId) => prepare(`SELECT ${IMP_COLS} FROM impersonations WHERE user_id = ? AND ended_at IS NULL`).all(String(userId));

  /**
   * Wie heeft er (onlangs) als deze gebruiker gewerkt? Voor de gebruiker zelf.
   * @param {string} userId Id van de gebruiker.
   * @param {number} [limit] Maximaal aantal regels.
   * @returns {object[]} Begin, einde, naam van de hoofdbeheerder en de omgeving, nieuwste eerst.
   */
  function recentFor(userId, limit = 10) {
    return prepare(`SELECT i.started_at, i.expires_at, i.ended_at, a.display_name AS admin_name, t.name AS tenant_name, t.environment AS environment
      FROM impersonations i LEFT JOIN users a ON a.id = i.admin_id LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.user_id = ? ORDER BY i.started_at DESC LIMIT ?`).all(String(userId), limit);
  }

  return { activeGrant, activeGrants, grant, revoke, start, get, end, openFor, recentFor };
}

/**
 * Routes voor supporttoegang en impersonatie, en de koppeling met identify() in server.js.
 * @param {object} deps store, impersonations (opslag van createImpersonationStore), auth, audit en mainTenantId.
 * @returns {{ resolve: Function, stop: Function, syncHint: Function, register: Function, activeGrant: Function, activeGrants: Function }} De functies voor server.js.
 */
function createImpersonation({ store, imp: impersonations, auth, audit, mainTenantId }) {
  /**
   * Mag deze gebruiker in deze omgeving worden overgenomen?
   * @param {object} admin De hoofdbeheerder.
   * @param {object|null} target De gebruiker die wordt overgenomen.
   * @param {object|null} envTenant De omgeving waarin gewerkt wordt.
   * @returns {string|null} Een foutmelding, of null als het mag.
   */
  function targetProblem(admin, target, envTenant) {
    if (!target || target.kind !== 'account') return 'Alleen gebruikers met een account kunnen worden overgenomen.';
    if (target.id === admin.id) return 'Je kunt niet als jezelf inloggen.';
    if (target.platform_admin) return 'Een hoofdbeheerder kan niet worden overgenomen.';
    if (target.disabled) return 'Deze gebruiker is uitgeschakeld.';
    if (!envTenant) return 'Omgeving niet gevonden.';
    const inHome = envTenant.id === target.tenant_id;
    const inTest = envTenant.environment === 'test' && envTenant.parent_id === target.tenant_id;
    if (!inHome && !inTest) return 'Deze omgeving hoort niet bij de organisatie van de gebruiker.';
    if (inTest && envTenant.disabled) return 'Deze testomgeving is uitgeschakeld.';
    return null;
  }

  /**
   * Of een omgeving live is (geen testomgeving).
   * @param {object|null} tenant De omgeving.
   * @returns {boolean} true bij een live-omgeving.
   */
  const isLive = (tenant) => tenant && tenant.environment !== 'test';

  /**
   * Beëindigt een impersonatie en schrijft een auditregel (in de omgeving en, als dat een andere is, in de hoofdtenant).
   * @param {object} req Het Express-verzoek.
   * @param {object} row De impersonatie.
   * @param {string} reason Reden van het einde.
   * @returns {boolean} true als hij nog liep.
   */
  function finish(req, row, reason) {
    if (!impersonations.end(row.id, reason)) return false;
    const target = store.getUser(row.user_id);
    const detail = { impersonatieId: row.id, gebruiker: target ? target.username : row.user_id, reden: reason };
    audit(req, 'impersonatie_beeindigd', detail, row.admin_id, row.tenant_id);
    if (row.tenant_id !== mainTenantId) audit(req, 'impersonatie_beeindigd', detail, row.admin_id, mainTenantId);
    return true;
  }

  /**
   * Werkt deze hoofdbeheerder nu als iemand anders? Controleert de cookie en de
   * impersonatie (niet beëindigd, niet verlopen, toestemming nog geldig) en
   * beëindigt hem als dat niet meer klopt.
   * @param {object} req Het Express-verzoek.
   * @param {object} admin De ingelogde hoofdbeheerder.
   * @returns {object|null} De gebruiker zoals die in de omgeving van de impersonatie werkt (met impersonator en impersonation), of null.
   */
  function resolve(req, admin) {
    const raw = auth.readSigned(req, IMP_COOKIE, 'imp');
    if (!raw) return null;
    const [adminId, id] = raw.split(':');
    if (adminId !== admin.id || !id) return null;
    const row = impersonations.get(id);
    if (!row || row.admin_id !== admin.id || row.ended_at) return null;
    const target = store.getUser(row.user_id);
    const envTenant = store.getTenant(row.tenant_id);
    let reason = null;
    if (Date.parse(row.expires_at) <= Date.now()) reason = 'verlopen';
    else if (targetProblem(admin, target, envTenant)) reason = 'niet_meer_toegestaan';
    else if (isLive(envTenant)) {
      const activeGrant = row.grant_id && impersonations.activeGrant(target.id);
      if (!activeGrant || activeGrant.id !== row.grant_id) reason = 'toestemming_ingetrokken';
    }
    if (reason) {
      finish(req, row, reason);
      return null;
    }
    return {
      ...target,
      tenant_id: row.tenant_id,
      home_tenant_id: target.tenant_id,
      impersonator: { id: admin.id, username: admin.username, display_name: admin.display_name },
      impersonation: { id: row.id, expiresAt: row.expires_at, live: isLive(envTenant), tenantName: envTenant.name },
    };
  }

  /**
   * Waarde van de leesbare hint-cookie: naam, eindtijd en live/test.
   * @param {object} user De overgenomen gebruiker (met impersonation).
   * @returns {string} 'naam|eindtijd|live' of 'naam|eindtijd|test'.
   */
  const hintValue = (user) => {
    const impersonation = user.impersonation;
    return `${user.display_name}|${impersonation.expiresAt}|${impersonation.live ? 'live' : 'test'}`;
  };

  /**
   * Laat de leesbare hint-cookie (voor de balk in shared/env.js) de werkelijke toestand volgen.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {object|null} user De gebruiker van dit verzoek.
   * @returns {void}
   */
  function syncHint(req, res, user) {
    const current = parseCookies(req.headers.cookie)[IMP_HINT] || null;
    const wanted = user && user.impersonation ? hintValue(user) : null;
    if (current === wanted) return;
    if (wanted) auth.setPlain(req, res, IMP_HINT, wanted, { httpOnly: false });
    else auth.clearNamed(res, IMP_HINT);
    if (!wanted && parseCookies(req.headers.cookie)[IMP_COOKIE]) auth.clearNamed(res, IMP_COOKIE);
  }

  /**
   * Wist de impersonatiecookies van deze browser.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @returns {void}
   */
  function clearCookies(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[IMP_COOKIE]) auth.clearNamed(res, IMP_COOKIE);
    if (cookies[IMP_HINT]) auth.clearNamed(res, IMP_HINT);
  }

  /**
   * Bij uitloggen of stoppen: beëindigt de lopende impersonatie van deze browser en wist de cookies.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {string} [reason] Reden van het einde.
   * @returns {boolean} true als er een impersonatie is beëindigd.
   */
  function stop(req, res, reason = 'gestopt') {
    const raw = auth.readSigned(req, IMP_COOKIE, 'imp');
    let ended = false;
    if (raw) {
      const [adminId, id] = raw.split(':');
      const row = id && impersonations.get(id);
      if (row && row.admin_id === adminId && !row.ended_at) ended = finish(req, row, reason);
    }
    clearCookies(req, res);
    return ended;
  }

  /**
   * Supporttoegang zoals de frontend hem ziet (alleen begin en einde).
   * @param {object|null} grantRow Rij uit support_grants.
   * @returns {{ createdAt: string, expiresAt: string }|null} De toestemming, of null.
   */
  function publicGrant(grantRow) {
    return grantRow ? { createdAt: grantRow.created_at, expiresAt: grantRow.expires_at } : null;
  }

  /**
   * Registreert de routes /api/support (de gebruiker zelf), /api/platform/impersonate en /api/impersonation/stop.
   * @param {object} app De Express-app.
   * @param {object} deps identify, requireJson, clearEnvironment en wrap uit server.js.
   * @returns {void}
   */
  function register(app, { identify, requireJson, clearEnvironment, wrap }) {
    // ---------- Supporttoegang (de gebruiker zelf) ----------
    /**
     * De ingelogde gebruiker zelf (geen toegangscode, gast of impersonatie); stuurt anders 401/403.
     * @param {object} req Het Express-verzoek.
     * @param {object} res Het Express-antwoord.
     * @returns {object|null} De gebruiker, of null als er al een foutantwoord is verstuurd.
     */
    const ownAccount = (req, res) => {
      const user = identify(req);
      if (!user || user.kind !== 'account') { res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in met je account.' }); return null; }
      if (user.impersonator) { res.status(403).json({ error: 'impersonating', message: 'Alleen de gebruiker zelf kan supporttoegang geven of intrekken.' }); return null; }
      return user;
    };

    app.get('/api/support', (req, res) => {
      const user = ownAccount(req, res);
      if (!user) return;
      res.json({
        grant: publicGrant(impersonations.activeGrant(user.id)),
        options: GRANT_HOURS,
        defaultHours: DEFAULT_GRANT_HOURS,
        // Een hoofdbeheerder kan zelf niet worden overgenomen, en voor een
        // testaccount is geen toestemming nodig.
        applicable: !user.platform_admin && isLive(store.getTenant(user.home_tenant_id || user.tenant_id)),
        recent: impersonations.recentFor(user.id).map((row) => ({
          by: row.admin_name || 'Hoofdbeheerder', environment: row.environment === 'test' ? `test: ${row.tenant_name}` : 'live',
          startedAt: row.started_at, endedAt: row.ended_at, expiresAt: row.expires_at,
        })),
      });
    });

    app.post('/api/support', requireJson, (req, res) => {
      const user = ownAccount(req, res);
      if (!user) return;
      if (user.platform_admin) return res.status(409).json({ error: 'not_applicable', message: 'Een hoofdbeheerder kan niet worden overgenomen.' });
      if (!isLive(store.getTenant(user.home_tenant_id || user.tenant_id))) return res.status(409).json({ error: 'not_applicable', message: 'Voor een testaccount is geen toestemming nodig.' });
      const hours = Number(req.body?.hours ?? DEFAULT_GRANT_HOURS);
      if (!GRANT_HOURS.includes(hours)) return res.status(400).json({ error: 'invalid_hours', message: `Kies ${GRANT_HOURS.join(', ')} uur.` });
      const newGrant = impersonations.grant({ ...user, tenant_id: user.home_tenant_id || user.tenant_id }, hours);
      audit(req, 'support_toegang_verleend', { uren: hours, tot: newGrant.expires_at }, user.id, user.home_tenant_id);
      res.status(201).json({ grant: publicGrant(newGrant) });
    });

    app.delete('/api/support', (req, res) => {
      const user = ownAccount(req, res);
      if (!user) return;
      const revokedCount = impersonations.revoke(user.id);
      // Lopende live-impersonaties stoppen meteen (bij het volgende verzoek
      // zou resolve() dat ook doen; zo staat het einde direct in het log).
      for (const row of impersonations.openFor(user.id)) {
        const tenant = store.getTenant(row.tenant_id);
        if (isLive(tenant)) finish(req, row, 'toestemming_ingetrokken');
      }
      if (revokedCount) audit(req, 'support_toegang_ingetrokken', {}, user.id, user.home_tenant_id);
      res.json({ ok: true });
    });

    // ---------- Starten (hoofdbeheerder) en stoppen ----------
    // Valt onder /api/platform, dus alleen voor een hoofdbeheerder die niet al
    // als iemand anders werkt (die is dan geen hoofdbeheerder).
    app.post('/api/platform/impersonate', requireJson, (req, res) => {
      const admin = req.user;
      const target = store.getUser(String(req.body?.userId || ''));
      const envTenant = store.getTenant(String(req.body?.tenantId || (target ? target.tenant_id : '')));
      const problem = targetProblem(admin, target, envTenant);
      if (problem) return res.status(target && envTenant ? 409 : 404).json({ error: 'not_allowed', message: problem });
      const live = isLive(envTenant);
      const reason = String(req.body?.reason || '').trim().slice(0, 200);
      let expires = Date.now() + MAX_IMPERSONATION_MS;
      let grantRow = null;
      if (live) {
        grantRow = impersonations.activeGrant(target.id);
        if (!grantRow) {
          return res.status(403).json({ error: 'consent_required', message: `${target.display_name} heeft geen supporttoegang gegeven. In live kan dat alleen met toestemming; de gebruiker geeft die op het dashboard bij Support op afstand.` });
        }
        expires = Math.min(expires, Date.parse(grantRow.expires_at));
      }
      // Een eventuele vorige impersonatie in deze browser eerst afsluiten.
      stop(req, res, 'vervangen');
      clearEnvironment(req, res);
      const row = impersonations.start({ tenantId: envTenant.id, adminId: admin.id, userId: target.id, grantId: grantRow ? grantRow.id : null,
        reason, expiresAt: new Date(expires).toISOString() });
      auth.setSigned(req, res, IMP_COOKIE, `${admin.id}:${row.id}`, 'imp');
      const acting = { ...target, impersonation: { expiresAt: row.expires_at, live } };
      auth.setPlain(req, res, IMP_HINT, hintValue(acting), { httpOnly: false });
      if (!live) auth.setPlain(req, res, 'aquatech_env_hint', `${envTenant.slug}|${envTenant.name}`, { httpOnly: false });
      const detail = { impersonatieId: row.id, gebruiker: target.username, omgeving: live ? 'live' : `test: ${envTenant.name}`,
        toestemming: live ? 'ja' : 'niet nodig (test)', tot: row.expires_at, ...(reason ? { reden: reason } : {}) };
      audit(req, 'impersonatie_gestart', detail, admin.id, envTenant.id);
      if (envTenant.id !== mainTenantId) audit(req, 'impersonatie_gestart', detail, admin.id, mainTenantId);
      console.log(`${admin.display_name} werkt nu als ${target.display_name} in ${envTenant.name} (${envTenant.environment})`);
      res.status(201).json({ ok: true, expiresAt: row.expires_at, live });
    });

    app.post('/api/impersonation/stop', (req, res) => {
      const user = identify(req);
      const ended = stop(req, res, 'gestopt');
      clearEnvironment(req, res);
      if (user && user.impersonator) console.log(`${user.impersonator.display_name} werkt weer als zichzelf`);
      res.json({ ok: true, ended });
    });
  }

  return {
    resolve,
    stop,
    syncHint,
    register,
    /**
     * Lopende supporttoegang van een gebruiker, zoals de frontend hem ziet.
     * @param {string} id Id van de gebruiker.
     * @returns {object|null} De toestemming, of null.
     */
    activeGrant: (id) => publicGrant(impersonations.activeGrant(id)),
    /**
     * Lopende supporttoegang van meerdere gebruikers, zoals de frontend hem ziet.
     * @param {string[]} ids Id's van gebruikers.
     * @returns {Object<string, object>} Per gebruikers-id de toestemming.
     */
    activeGrants: (ids) => Object.fromEntries(Object.entries(impersonations.activeGrants(ids)).map(([userId, grantRow]) => [userId, publicGrant(grantRow)])),
  };
}

module.exports = { createImpersonationStore, createImpersonation, IMP_COOKIE, IMP_HINT, GRANT_HOURS, MAX_IMPERSONATION_MS };
