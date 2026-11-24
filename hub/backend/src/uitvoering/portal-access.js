// Toegangspoort voor schrijfacties in het klantportaal (gedeeld door portal.js en service-requests.js).

/**
 * Middleware: schrijfacties in het klantportaal alleen voor echte accounts; een
 * gast (anonieme bezoeker met gasttoegang) mag het portaal alleen lezen, anders
 * zijn meldingen, mails en foto's goedkoop in massa te maken (audit B-08).
 * @param {object} req Het Express-verzoek.
 * @param {object} res Het Express-antwoord.
 * @param {Function} next Volgende stap.
 * @returns {void}
 */
function requireAccount(req, res, next) {
  if (req.user && req.user.kind === 'gast') return res.status(403).json({ error: 'account_required', message: 'Maak een account aan en log in om dit te doen.' });
  return next();
}

module.exports = { requireAccount };
