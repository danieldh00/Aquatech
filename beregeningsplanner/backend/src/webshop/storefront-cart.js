// Winkelwagen van de eigen webshop: een cookie (zonder script) met de
// artikelcodes en aantallen. De cookie is alleen een wensenlijst; prijzen,
// btw en voorraad komen bij elke pagina en bij het afrekenen opnieuw uit de
// database (web-orders.js, priceCart).
const { parseCookies } = require('../beveiliging/auth');

/** Naam van de cookie. */
const CART_COOKIE = 'aquatech_winkelwagen';
/** Hoe lang (s) de winkelwagen bewaard blijft. */
const CART_MAX_AGE = 30 * 24 * 60 * 60;
/** Hoogstens zoveel regels in de wagen. */
const MAX_LINES = 40;
/** Hoogstens zoveel stuks per artikel. */
const MAX_QTY = 99;

/**
 * Leest de winkelwagen uit de cookie. Ongeldige of te grote inhoud geeft een lege wagen.
 * @param {object} req Het verzoek.
 * @returns {{ code: string, qty: number }[]} De regels.
 */
function readCart(req) {
  const raw = parseCookies(req.headers.cookie)[CART_COOKIE];
  if (!raw || raw.length > 3000) return [];
  try {
    const list = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(list)) return [];
    const lines = [];
    for (const entry of list.slice(0, MAX_LINES)) {
      const code = Array.isArray(entry) ? String(entry[0] || '').trim().toUpperCase().slice(0, 60) : '';
      const qty = Array.isArray(entry) ? Math.floor(Number(entry[1])) : 0;
      if (code && qty >= 1 && !lines.some((line) => line.code === code)) lines.push({ code, qty: Math.min(MAX_QTY, qty) });
    }
    return lines;
  } catch { return []; }
}

/**
 * Bewaart de winkelwagen in de cookie (een lege wagen wist de cookie).
 * @param {object} req Het verzoek (voor https-detectie).
 * @param {object} res Het antwoord.
 * @param {{ code: string, qty: number }[]} lines De regels.
 * @returns {void}
 */
function writeCart(req, res, lines) {
  const value = lines.length ? Buffer.from(JSON.stringify(lines.map((line) => [line.code, line.qty])), 'utf8').toString('base64url') : '';
  const attrs = [`${CART_COOKIE}=${value}`, 'Path=/', `Max-Age=${value ? CART_MAX_AGE : 0}`, 'HttpOnly', 'SameSite=Lax'];
  if (req.headers['x-forwarded-proto'] === 'https') attrs.push('Secure');
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), attrs.join('; ')]);
}

/**
 * Past de winkelwagen aan met een actie uit een formulier.
 * @param {{ code: string, qty: number }[]} lines De huidige regels.
 * @param {{ action?: string, code?: string, qty?: string }} fields De velden: toevoegen (code, qty), wijzigen (code, qty; 0 = weg), verwijderen (code) of leegmaken.
 * @returns {{ code: string, qty: number }[]} De nieuwe regels.
 */
function applyCartAction(lines, fields) {
  const code = String(fields.code || '').trim().toUpperCase().slice(0, 60);
  const qty = Math.floor(Number(fields.qty));
  const next = lines.map((line) => ({ ...line }));
  const existing = next.find((line) => line.code === code);
  if (fields.action === 'clear') return [];
  if (!code) return next;
  if (fields.action === 'add') {
    const amount = qty >= 1 ? qty : 1;
    if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + amount);
    else if (next.length < MAX_LINES) next.push({ code, qty: Math.min(MAX_QTY, amount) });
    return next;
  }
  if (fields.action === 'remove' || (fields.action === 'set' && !(qty >= 1))) return next.filter((line) => line.code !== code);
  if (fields.action === 'set' && existing) existing.qty = Math.min(MAX_QTY, qty);
  return next;
}

module.exports = { readCart, writeCart, applyCartAction, CART_COOKIE, MAX_QTY };
