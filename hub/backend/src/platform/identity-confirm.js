// Herbevestiging van de identiteit voor gevaarlijke beheeracties (terugzetten, back-ups verwijderen, de Drive-koppeling
// verbreken): eigen wachtwoord en, bij tweestapsverificatie, de code opnieuw, binnen dezelfde bewaking als inloggen
// (oplopende vertraging en blokkade). Gedeeld door de routes voor terugzetten (backup-restore-routes.js) en de back-uproutes.
const { verifyPassword } = require('./store');

/**
 * Maakt de controle die het wachtwoord (en de tweestapscode) uit de aanvraag opnieuw nakijkt.
 * @param {{ store: object, loginGuard: object, twoFactor: object, audit: Function, auditAction: string }} deps De store, de inlogbewaking, de tweestapscontrole, het auditlog en de auditactie bij een foute poging.
 * @returns {Function} (req, res) → Promise<boolean>: true als de identiteit klopt; anders staat het antwoord al klaar.
 */
function createIdentityConfirm({ store, loginGuard, twoFactor, audit, auditAction }) {
  /**
   * Vraagt het wachtwoord (en bij tweestapsverificatie de code) opnieuw. Zet bij een fout het antwoord al klaar.
   * @param {object} req Het verzoek (body.password, body.totp).
   * @param {object} res Het antwoord.
   * @returns {Promise<boolean>} true als de identiteit klopt.
   */
  return async function confirmIdentity(req, res) {
    const guardKey = `terugzetten:${req.user.id}`;
    const totpKey = `totp:${req.user.id}`;
    if (loginGuard.blocked(req, guardKey, 10, 10) || loginGuard.blocked(req, totpKey, 10, 10)) {
      res.status(429).json({ error: 'locked', message: 'Te veel verkeerde pogingen. Probeer het over een kwartier opnieuw.' });
      return false;
    }
    await loginGuard.wait(req, guardKey);
    const account = store.getUser(req.user.id);
    const password = String(req.body?.password ?? '').slice(0, 200);
    if (!account || !account.password_hash || !(await verifyPassword(password, account.password_hash))) {
      loginGuard.fail(req, guardKey);
      audit(req, auditAction, {});
      res.status(401).json({ error: 'wrong_password', message: 'Je wachtwoord klopt niet.' });
      return false;
    }
    const second = twoFactor.check(account, String(req.body?.totp ?? '').slice(0, 40));
    if (!second.ok) {
      if (second.missing) {
        res.status(401).json({ error: 'totp_required', message: 'Vul de code uit je authenticator-app in.' });
        return false;
      }
      loginGuard.fail(req, totpKey);
      audit(req, auditAction, { via: 'tweestaps' });
      res.status(401).json({ error: 'totp_wrong', message: 'De code klopt niet. Gebruik de nieuwste code uit de app of een herstelcode.' });
      return false;
    }
    loginGuard.clear(req, guardKey);
    if (second.required) loginGuard.clear(req, totpKey);
    return true;
  };
}

module.exports = { createIdentityConfirm };
