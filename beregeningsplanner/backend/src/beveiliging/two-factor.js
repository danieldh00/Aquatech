// Tweestapsverificatie per account (5 uit de audit van 1.7.3): opslag in users (migratie 51) en de API op het
// profiel. Het geheim staat versleuteld in users.totp_secret (vault, AAD `<tenant>:totp:<gebruiker>`); zolang
// totp_enabled_at leeg is, is het een nog niet bevestigde instelling. users.totp_last_step voorkomt dat dezelfde
// code twee keer werkt, users.totp_recovery bewaart alleen de SHA-256 van de herstelcodes.
// Inloggen (server.js) vraagt de code met `check`; een beheerder kan de tweestapsverificatie van een collega
// uitzetten als diens telefoon kwijt is (`/api/admin/users/:id/totp`).
const Totp = require('./totp');

/** Naam van de uitgever in de authenticator-app. */
const ISSUER = 'AquaTech';

/**
 * Maakt de opslag voor tweestapsverificatie.
 * @param {object} db De database.
 * @param {{ vault: object }} deps De kluis (seal/open).
 * @returns {{ stateOf: Function, startSetup: Function, confirm: Function, disable: Function, check: Function }} De functies.
 */
function createTwoFactor(db, { vault }) {
  /**
   * Bereidt een query voor.
   * @param {string} sql De SQL.
   * @returns {object} Het statement.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * De context waarmee het geheim versleuteld wordt.
   * @param {string} tenantId Id van de tenant van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {string} De AAD.
   */
  const contextOf = (tenantId, userId) => `${tenantId}:totp:${userId}`;
  /**
   * De rij met de tweestapsgegevens van een gebruiker.
   * @param {string} tenantId Id van de tenant van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {object|undefined} totp_secret, totp_enabled_at, totp_last_step en totp_recovery.
   */
  const rowOf = (tenantId, userId) => prepare('SELECT totp_secret, totp_enabled_at, totp_last_step, totp_recovery FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, userId);
  /**
   * Leest de bewaarde hashes van de herstelcodes.
   * @param {object} row De rij.
   * @returns {string[]} De hashes.
   */
  const recoveryOf = (row) => { try { const list = JSON.parse(row.totp_recovery || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };

  /**
   * Of tweestapsverificatie aan staat en hoeveel herstelcodes er nog zijn.
   * @param {string} tenantId Id van de tenant van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {{ enabled: boolean, enabledAt: string|null, recoveryLeft: number }} De stand.
   */
  function stateOf(tenantId, userId) {
    const row = rowOf(tenantId, userId);
    const enabled = Boolean(row && row.totp_enabled_at && row.totp_secret);
    return { enabled, enabledAt: enabled ? row.totp_enabled_at : null, recoveryLeft: enabled ? recoveryOf(row).length : 0 };
  }

  /**
   * Begint met aanzetten: een nieuw geheim (nog niet actief) en het adres voor de app. Staat het al aan, dan niet.
   * @param {{ id: string, tenant_id: string, username: string }} user De gebruiker.
   * @returns {{ secret?: string, uri?: string, error?: string, status?: number }} Het geheim en het otpauth-adres, of een fout.
   */
  function startSetup(user) {
    if (stateOf(user.tenant_id, user.id).enabled) return { error: 'Tweestapsverificatie staat al aan.', status: 409 };
    const secret = Totp.newSecret();
    prepare('UPDATE users SET totp_secret = ?, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = ? WHERE tenant_id = ? AND id = ?')
      .run(vault.seal(secret, contextOf(user.tenant_id, user.id)), '[]', user.tenant_id, user.id);
    return { secret, uri: Totp.otpauthUri({ secret, account: user.username, issuer: ISSUER }) };
  }

  /**
   * Bevestigt het aanzetten met een code uit de app; daarna staat het aan en krijgt de gebruiker zijn herstelcodes (één keer).
   * @param {{ id: string, tenant_id: string }} user De gebruiker.
   * @param {*} code De code uit de app.
   * @returns {{ recoveryCodes?: string[], error?: string, status?: number }} De herstelcodes, of een fout.
   */
  function confirm(user, code) {
    const row = rowOf(user.tenant_id, user.id);
    if (!row || !row.totp_secret) return { error: 'Begin opnieuw met aanzetten.', status: 409 };
    if (row.totp_enabled_at) return { error: 'Tweestapsverificatie staat al aan.', status: 409 };
    const secret = vault.open(row.totp_secret, contextOf(user.tenant_id, user.id));
    const checked = Totp.verify(secret, code);
    if (!checked.ok) return { error: 'De code klopt niet. Controleer de tijd op je telefoon en probeer de nieuwste code.', status: 400 };
    const recovery = Totp.newRecoveryCodes();
    prepare('UPDATE users SET totp_enabled_at = ?, totp_last_step = ?, totp_recovery = ? WHERE tenant_id = ? AND id = ?')
      .run(new Date().toISOString(), checked.step, JSON.stringify(recovery.hashes), user.tenant_id, user.id);
    return { recoveryCodes: recovery.codes };
  }

  /**
   * Zet tweestapsverificatie uit (de gebruiker zelf, na controle door de aanroeper, of een beheerder).
   * @param {string} tenantId Id van de tenant van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {boolean} true als er iets uitgezet is.
   */
  function disable(tenantId, userId) {
    const out = prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = '[]' WHERE tenant_id = ? AND id = ? AND totp_secret IS NOT NULL").run(tenantId, userId);
    return Number(out.changes) > 0;
  }

  /**
   * De tweede stap bij inloggen: staat tweestapsverificatie aan, dan moet er een geldige code of herstelcode bij.
   * Een gebruikte code werkt niet nog eens; een herstelcode vervalt na gebruik.
   * @param {{ id: string, tenant_id: string }} user De gebruiker (wachtwoord al gecontroleerd).
   * @param {*} code De ingevoerde code (leeg = nog niet gevraagd).
   * @returns {{ ok: boolean, required?: boolean, missing?: boolean, recoveryUsed?: boolean }} ok = mag inloggen; missing = er moet nog een code komen; anders een verkeerde code.
   */
  function check(user, code) {
    const row = rowOf(user.tenant_id, user.id);
    if (!row || !row.totp_enabled_at || !row.totp_secret) return { ok: true, required: false };
    const typed = String(code ?? '').trim();
    if (!typed) return { ok: false, required: true, missing: true };
    const secret = vault.open(row.totp_secret, contextOf(user.tenant_id, user.id));
    const checked = Totp.verify(secret, typed, { lastStep: row.totp_last_step == null ? null : Number(row.totp_last_step) });
    if (checked.ok) {
      // Alleen een latere stap overschrijft de vorige (twee gelijktijdige aanmeldingen met dezelfde code: één wint).
      const saved = prepare('UPDATE users SET totp_last_step = ? WHERE tenant_id = ? AND id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)').run(checked.step, user.tenant_id, user.id, checked.step);
      return Number(saved.changes) > 0 ? { ok: true, required: true } : { ok: false, required: true };
    }
    const hashes = recoveryOf(row);
    const index = Totp.matchRecovery(hashes, typed);
    if (index < 0) return { ok: false, required: true };
    const rest = hashes.filter((_, position) => position !== index);
    const saved = prepare('UPDATE users SET totp_recovery = ? WHERE tenant_id = ? AND id = ? AND totp_recovery = ?').run(JSON.stringify(rest), user.tenant_id, user.id, row.totp_recovery);
    return Number(saved.changes) > 0 ? { ok: true, required: true, recoveryUsed: true } : { ok: false, required: true };
  }

  return { stateOf, startSetup, confirm, disable, check };
}

/**
 * Registreert de routes op het profiel en in Beheer.
 * @param {object} app De Express-app.
 * @param {{ twoFactor: object, auth: object, store: object, identify: Function, requireJson: Function, requireRight: Function, usersTenantOf: Function, audit: Function, guard: { blocked: Function, fail: Function, clear: Function } }} ctx De opslag en hulpfuncties van de server (guard = de telling van mislukte pogingen).
 * @returns {void}
 */
function registerTwoFactorRoutes(app, { twoFactor, auth, store, identify, requireJson, requireRight, usersTenantOf, audit, guard }) {
  /**
   * Het eigen account van het verzoek (niet bij de toegangscode, een gast of als iemand anders bekeken wordt).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De gebruiker uit de sessie, of null (het antwoord is dan al verstuurd).
   */
  const ownAccount = (req, res) => {
    const session = auth.session(req);
    if (session?.via !== 'user') { res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account.' }); return null; }
    if (identify(req)?.impersonation) { res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' }); return null; }
    return session.user;
  };

  app.get('/api/account/totp', (req, res) => {
    const user = ownAccount(req, res);
    if (!user) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(twoFactor.stateOf(user.tenant_id, user.id));
  });

  app.post('/api/account/totp/setup', requireJson, (req, res) => {
    const user = ownAccount(req, res);
    if (!user) return;
    const out = twoFactor.startSetup(user);
    if (out.error) return res.status(out.status).json({ error: 'totp_state', message: out.error });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  app.post('/api/account/totp/confirm', requireJson, (req, res) => {
    const user = ownAccount(req, res);
    if (!user) return;
    const key = `totp-instellen:${user.id}`;
    if (guard.blocked(req, key)) return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
    const out = twoFactor.confirm(user, req.body?.code);
    if (out.error) {
      if (out.status === 400) guard.fail(req, key);
      return res.status(out.status).json({ error: 'totp_wrong', message: out.error });
    }
    guard.clear(req, key);
    audit(req, 'tweestaps_aan', {}, user.id, user.tenant_id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, recoveryCodes: out.recoveryCodes, ...twoFactor.stateOf(user.tenant_id, user.id) });
  });

  // Uitzetten door de gebruiker zelf: met het wachtwoord én een code (of herstelcode), zodat een open sessie op een
  // gedeelde computer niet genoeg is.
  app.post('/api/account/totp/disable', requireJson, async (req, res) => {
    const user = ownAccount(req, res);
    if (!user) return;
    const key = `totp-uit:${user.id}`;
    if (guard.blocked(req, key)) return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
    const checked = await store.authenticate(user.tenant_id, user.username, String(req.body?.password ?? '').slice(0, 1024));
    const second = checked && checked.id === user.id ? twoFactor.check(user, req.body?.code) : { ok: false };
    if (!checked || checked.id !== user.id || !second.ok || second.missing) {
      guard.fail(req, key);
      return res.status(400).json({ error: 'wrong_login', message: 'Wachtwoord of code klopt niet.' });
    }
    guard.clear(req, key);
    twoFactor.disable(user.tenant_id, user.id);
    audit(req, 'tweestaps_uit', { door: 'gebruiker' }, user.id, user.tenant_id);
    res.json({ ok: true, ...twoFactor.stateOf(user.tenant_id, user.id) });
  });

  // Een beheerder zet de tweestapsverificatie van een collega uit (telefoon kwijt); die logt daarna in met alleen het wachtwoord.
  app.delete('/api/admin/users/:id/totp', requireRight('beheer'), (req, res) => {
    const tenantId = usersTenantOf(req);
    const target = store.getUser(req.params.id);
    if (!target || target.tenant_id !== tenantId) return res.status(404).json({ error: 'not_found', message: 'Gebruiker niet gevonden.' });
    if (target.platform_admin && !req.user.platform_admin) return res.status(403).json({ error: 'forbidden', message: 'Alleen een hoofdbeheerder kan dit bij een hoofdbeheerder.' });
    const changed = twoFactor.disable(tenantId, target.id);
    if (changed) audit(req, 'tweestaps_uit', { door: 'beheerder', gebruiker: target.username }, req.user.id, tenantId);
    res.json({ ok: true, changed });
  });
}

module.exports = { createTwoFactor, registerTwoFactorRoutes, ISSUER };
