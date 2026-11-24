// Routes voor het eigen account: wachtwoord wijzigen (/api/account/password) en Mijn profiel (/api/account/profile).
const { preferencesOf } = require('./store');

/**
 * Registreert de routes onder /api/account (wachtwoord en profiel).
 * @param {import('express').Express} app De app.
 * @param {object} ctx store, auth, identify (uit server.js), audit (req, actie, detail, gebruiker, tenant), requireJson, wrap, en de inlogtelling lockedOut/failed/failures.
 * @returns {void}
 */
function registerAccountRoutes(app, { store, auth, identify, audit, requireJson, wrap, lockedOut, failed, failures }) {
  // ---------- Eigen wachtwoord wijzigen ----------
  // Met het huidige wachtwoord ter controle; daarna is de gebruiker op alle
  // andere toestellen uitgelogd en krijgt dit toestel een nieuwe sessie.
  app.post('/api/account/password', requireJson, wrap(async (req, res) => {
    const session = auth.session(req);
    if (session?.via !== 'user') return res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je wachtwoord te wijzigen.' });
    const active = identify(req);
    if (!active) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (active.impersonation) return res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' });
    const key = `wachtwoord:${session.user.id}`;
    if (lockedOut(key)) return res.status(429).json({ error: 'locked', message: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
    const out = await store.changeOwnPassword(session.user.id, String(req.body?.currentPassword ?? '').slice(0, 1024), String(req.body?.newPassword ?? '').slice(0, 1024));
    if (out.error) {
      if (out.wrong) failed(key);
      return res.status(out.status || 400).json({ error: out.wrong ? 'wrong_password' : 'invalid_password', message: out.error });
    }
    failures.delete(key);
    auth.setCookie(req, res, out.user.id);
    audit(req, 'wachtwoord_gewijzigd', { door: 'gebruiker' }, out.user.id, out.user.tenant_id);
    res.json({ ok: true, user: store.publicUser(out.user) });
  }));

  // ---------- Mijn profiel ----------
  // Naam, e-mail, telefoon en persoonlijke voorkeuren van het eigen account
  // (niet met de toegangscode, niet tijdens een impersonatie).
  /**
   * Het eigen account voor Mijn profiel; stuurt zelf een fout als dat er niet is.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De gebruiker, of null (antwoord al verstuurd).
   */
  function profileOwner(req, res) {
    const session = auth.session(req);
    if (session?.via !== 'user') { res.status(400).json({ error: 'no_account', message: 'Log in met je eigen account om je profiel te bekijken.' }); return null; }
    const active = identify(req);
    if (!active) { res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' }); return null; }
    if (active.impersonation) { res.status(409).json({ error: 'impersonating', message: 'Ga eerst terug naar je eigen account.' }); return null; }
    return session.user;
  }
  /**
   * Het profiel voor de API.
   * @param {object} user De gebruiker.
   * @returns {{ user: object, preferences: object }} Gegevens en voorkeuren.
   */
  const profileOf = (user) => ({ user: store.publicUser(user), preferences: preferencesOf(user) });

  app.get('/api/account/profile', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const owner = profileOwner(req, res);
    // s.user is in dit verzoek net uit de database gelezen.
    if (owner) res.json(profileOf(owner));
  });

  app.put('/api/account/profile', requireJson, (req, res) => {
    const owner = profileOwner(req, res);
    if (!owner) return;
    const input = {};
    for (const field of ['displayName', 'email', 'phone', 'preferences']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    const out = store.updateProfile(owner.id, input);
    if (out.error) return res.status(400).json({ error: 'invalid_profile', field: out.field, message: out.error });
    // Welke velden, nooit de waarden (persoonsgegevens horen niet in het logboek).
    if (out.changed.length) audit(req, 'profiel_gewijzigd', { velden: out.changed }, owner.id, owner.tenant_id);
    res.json(profileOf(out.user));
  });
}

module.exports = { registerAccountRoutes };
