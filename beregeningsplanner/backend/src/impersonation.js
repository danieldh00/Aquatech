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

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

function createImpersonationStore(db) {
  const q = (sql) => db.prepare(sql);

  function activeGrant(userId) {
    return q('SELECT * FROM support_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1')
      .get(String(userId), now()) || null;
  }

  // De lopende toestemming van meerdere gebruikers in één query: { user-id: rij }.
  function activeGrants(userIds) {
    const out = {};
    if (!userIds.length) return out;
    const rows = q(`SELECT * FROM support_grants WHERE user_id IN (${userIds.map(() => '?').join(', ')}) AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at`).all(...userIds.map(String), now());
    for (const r of rows) out[r.user_id] = r; // de laatst verlopende wint, zoals in activeGrant
    return out;
  }

  // Een nieuwe toestemming vervangt de vorige.
  function grant(user, hours) {
    const ts = now();
    q('UPDATE support_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(ts, user.id);
    const row = { id: newId(), tenant_id: user.tenant_id, user_id: user.id, created_at: ts,
      expires_at: new Date(Date.now() + hours * HOUR_MS).toISOString(), revoked_at: null };
    q('INSERT INTO support_grants (id, tenant_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.tenant_id, row.user_id, row.created_at, row.expires_at);
    return row;
  }

  function revoke(userId) {
    return q('UPDATE support_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').run(now(), userId, now()).changes;
  }

  function start({ tenantId, adminId, userId, grantId = null, reason = '', expiresAt }) {
    const row = { id: newId(), tenant_id: tenantId, admin_id: adminId, user_id: userId, grant_id: grantId, reason,
      started_at: now(), expires_at: expiresAt, ended_at: null, ended_reason: null };
    q(`INSERT INTO impersonations (id, tenant_id, admin_id, user_id, grant_id, reason, started_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, tenantId, adminId, userId, grantId, reason, row.started_at, expiresAt);
    return row;
  }

  const get = (id) => q('SELECT * FROM impersonations WHERE id = ?').get(String(id)) || null;

  function end(id, reason) {
    return q('UPDATE impersonations SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL').run(now(), reason, id).changes > 0;
  }

  // Lopende impersonaties van een gebruiker (bijv. om ze te beëindigen bij het intrekken).
  const openFor = (userId) => q('SELECT * FROM impersonations WHERE user_id = ? AND ended_at IS NULL').all(String(userId));

  // Wie heeft er (onlangs) als deze gebruiker gewerkt? Voor de gebruiker zelf.
  function recentFor(userId, limit = 10) {
    return q(`SELECT i.*, a.display_name AS admin_name, t.name AS tenant_name, t.environment AS environment
      FROM impersonations i LEFT JOIN users a ON a.id = i.admin_id LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.user_id = ? ORDER BY i.started_at DESC LIMIT ?`).all(String(userId), limit);
  }

  return { activeGrant, activeGrants, grant, revoke, start, get, end, openFor, recentFor };
}

/**
 * Routes en de koppeling met identify() in server.js.
 * deps: { store, imp, auth, audit, identify, requireJson, mainTenantId, clearEnvironment, wrap }
 */
function createImpersonation({ store, imp, auth, audit, mainTenantId }) {
  // Mag deze gebruiker in deze omgeving worden overgenomen? Geeft een
  // foutmelding (string) of null. `envTenant` is de omgeving waarin gewerkt wordt.
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

  const isLive = (t) => t && t.environment !== 'test';

  // Beëindigen + auditregel (in de omgeving en, als dat een andere is, in de hoofdtenant).
  function finish(req, row, reason) {
    if (!imp.end(row.id, reason)) return false;
    const target = store.getUser(row.user_id);
    const detail = { impersonatieId: row.id, gebruiker: target ? target.username : row.user_id, reden: reason };
    audit(req, 'impersonatie_beeindigd', detail, row.admin_id, row.tenant_id);
    if (row.tenant_id !== mainTenantId) audit(req, 'impersonatie_beeindigd', detail, row.admin_id, mainTenantId);
    return true;
  }

  /**
   * Werkt deze hoofdbeheerder nu als iemand anders? Geeft de gebruiker zoals
   * die in de omgeving van de impersonatie werkt, of null.
   */
  function resolve(req, admin) {
    const raw = auth.readSigned(req, IMP_COOKIE, 'imp');
    if (!raw) return null;
    const [adminId, id] = raw.split(':');
    if (adminId !== admin.id || !id) return null;
    const row = imp.get(id);
    if (!row || row.admin_id !== admin.id || row.ended_at) return null;
    const target = store.getUser(row.user_id);
    const envTenant = store.getTenant(row.tenant_id);
    let reason = null;
    if (Date.parse(row.expires_at) <= Date.now()) reason = 'verlopen';
    else if (targetProblem(admin, target, envTenant)) reason = 'niet_meer_toegestaan';
    else if (isLive(envTenant)) {
      const g = row.grant_id && imp.activeGrant(target.id);
      if (!g || g.id !== row.grant_id) reason = 'toestemming_ingetrokken';
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

  const hintValue = (user) => {
    const i = user.impersonation;
    return `${user.display_name}|${i.expiresAt}|${i.live ? 'live' : 'test'}`;
  };

  // De leesbare hint-cookie (voor de balk in shared/env.js) volgt de werkelijke toestand.
  function syncHint(req, res, user) {
    const have = parseCookies(req.headers.cookie)[IMP_HINT] || null;
    const want = user && user.impersonation ? hintValue(user) : null;
    if (have === want) return;
    if (want) auth.setPlain(req, res, IMP_HINT, want, { httpOnly: false });
    else auth.clearNamed(res, IMP_HINT);
    if (!want && parseCookies(req.headers.cookie)[IMP_COOKIE]) auth.clearNamed(res, IMP_COOKIE);
  }

  function clearCookies(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[IMP_COOKIE]) auth.clearNamed(res, IMP_COOKIE);
    if (cookies[IMP_HINT]) auth.clearNamed(res, IMP_HINT);
  }

  // Bij uitloggen of stoppen: de lopende impersonatie van deze browser beëindigen.
  function stop(req, res, reason = 'gestopt') {
    const raw = auth.readSigned(req, IMP_COOKIE, 'imp');
    let ended = false;
    if (raw) {
      const [adminId, id] = raw.split(':');
      const row = id && imp.get(id);
      if (row && row.admin_id === adminId && !row.ended_at) ended = finish(req, row, reason);
    }
    clearCookies(req, res);
    return ended;
  }

  function publicGrant(g) {
    return g ? { createdAt: g.created_at, expiresAt: g.expires_at } : null;
  }

  function register(app, { identify, requireJson, clearEnvironment, wrap }) {
    // ---------- Supporttoegang (de gebruiker zelf) ----------
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
        grant: publicGrant(imp.activeGrant(user.id)),
        options: GRANT_HOURS,
        defaultHours: DEFAULT_GRANT_HOURS,
        // Een hoofdbeheerder kan zelf niet worden overgenomen, en voor een
        // testaccount is geen toestemming nodig.
        applicable: !user.platform_admin && isLive(store.getTenant(user.home_tenant_id || user.tenant_id)),
        recent: imp.recentFor(user.id).map((r) => ({
          by: r.admin_name || 'Hoofdbeheerder', environment: r.environment === 'test' ? `test: ${r.tenant_name}` : 'live',
          startedAt: r.started_at, endedAt: r.ended_at, expiresAt: r.expires_at,
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
      const g = imp.grant({ ...user, tenant_id: user.home_tenant_id || user.tenant_id }, hours);
      audit(req, 'support_toegang_verleend', { uren: hours, tot: g.expires_at }, user.id, user.home_tenant_id);
      res.status(201).json({ grant: publicGrant(g) });
    });

    app.delete('/api/support', (req, res) => {
      const user = ownAccount(req, res);
      if (!user) return;
      const n = imp.revoke(user.id);
      // Lopende live-impersonaties stoppen meteen (bij het volgende verzoek
      // zou resolve() dat ook doen; zo staat het einde direct in het log).
      for (const row of imp.openFor(user.id)) {
        const t = store.getTenant(row.tenant_id);
        if (isLive(t)) finish(req, row, 'toestemming_ingetrokken');
      }
      if (n) audit(req, 'support_toegang_ingetrokken', {}, user.id, user.home_tenant_id);
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
        grantRow = imp.activeGrant(target.id);
        if (!grantRow) {
          return res.status(403).json({ error: 'consent_required', message: `${target.display_name} heeft geen supporttoegang gegeven. In live kan dat alleen met toestemming; de gebruiker geeft die op het dashboard bij Support op afstand.` });
        }
        expires = Math.min(expires, Date.parse(grantRow.expires_at));
      }
      // Een eventuele vorige impersonatie in deze browser eerst afsluiten.
      stop(req, res, 'vervangen');
      clearEnvironment(req, res);
      const row = imp.start({ tenantId: envTenant.id, adminId: admin.id, userId: target.id, grantId: grantRow ? grantRow.id : null,
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
    resolve, stop, syncHint, register, activeGrant: (id) => publicGrant(imp.activeGrant(id)),
    activeGrants: (ids) => Object.fromEntries(Object.entries(imp.activeGrants(ids)).map(([k, g]) => [k, publicGrant(g)])),
  };
}

module.exports = { createImpersonationStore, createImpersonation, IMP_COOKIE, IMP_HINT, GRANT_HOURS, MAX_IMPERSONATION_MS };
