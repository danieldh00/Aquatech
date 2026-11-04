// Winkelwagen van de eigen webshop: een cookie (zonder script) met de
// artikelcodes en aantallen. De cookie is alleen een wensenlijst; prijzen,
// btw en voorraad komen bij elke pagina en bij het afrekenen opnieuw uit de
// database (web-orders.js, priceCart).
const { parseCookies } = require('../beveiliging/auth');
const { MAX_LINES, MAX_QTY } = require('./web-orders');

/** Naam van de cookie. */
const CART_COOKIE = 'aquatech_winkelwagen';
/** Hoe lang (s) de winkelwagen bewaard blijft. */
const CART_MAX_AGE = 30 * 24 * 60 * 60;
/** Grootste cookie (tekens, na base64) dat de winkelwagen mag worden; de browser staat 4096 bytes per cookie toe. */
const MAX_COOKIE_CHARS = 3600;

/**
 * Leest de winkelwagen uit de cookie. Ongeldige of te grote inhoud geeft een lege wagen.
 * @param {object} req Het verzoek.
 * @returns {{ code: string, qty: number }[]} De regels.
 */
function readCart(req) {
  const raw = parseCookies(req.headers.cookie)[CART_COOKIE];
  if (!raw || raw.length > MAX_COOKIE_CHARS) return [];
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
 * Zet de regels om naar de tekst in de cookie.
 * @param {{ code: string, qty: number }[]} lines De regels.
 * @returns {string} De tekst (leeg bij een lege wagen).
 */
function encodeCart(lines) {
  return lines.length ? Buffer.from(JSON.stringify(lines.map((line) => [line.code, line.qty])), 'utf8').toString('base64url') : '';
}

/**
 * Houdt van de regels zoveel over als in de cookie passen (vanaf het begin).
 * @param {{ code: string, qty: number }[]} lines De regels.
 * @returns {{ lines: { code: string, qty: number }[], dropped: string[] }} De regels die passen en de codes die niet pasten.
 */
function fitCart(lines) {
  const kept = lines.slice(0, MAX_LINES);
  while (kept.length && encodeCart(kept).length > MAX_COOKIE_CHARS) kept.pop();
  return { lines: kept, dropped: lines.filter((line) => !kept.includes(line)).map((line) => line.code) };
}

/**
 * Voegt een lijst regels bij de winkelwagen: bestaande regels krijgen het aantal erbij, nieuwe komen achteraan.
 * Wat niet meer in de wagen past (te veel regels of een te grote cookie) wordt niet toegevoegd.
 * @param {{ code: string, qty: number }[]} current De huidige regels.
 * @param {{ code: string, qty: number }[]} additions De regels om bij te voegen (al genormaliseerde codes).
 * @returns {{ lines: { code: string, qty: number }[], skipped: string[] }} De nieuwe wagen en de codes die niet pasten.
 */
function addCartLines(current, additions) {
  const next = current.map((line) => ({ ...line }));
  const skipped = [];
  for (const addition of additions) {
    const existing = next.find((line) => line.code === addition.code);
    if (existing) {
      // Een hoger aantal kan het cijfer langer maken: alleen toepassen als de cookie nog past.
      const raised = next.map((line) => (line === existing ? { ...line, qty: Math.min(MAX_QTY, line.qty + addition.qty) } : line));
      if (encodeCart(raised).length > MAX_COOKIE_CHARS) skipped.push(addition.code);
      else existing.qty = Math.min(MAX_QTY, existing.qty + addition.qty);
      continue;
    }
    const candidate = [...next, { code: addition.code, qty: Math.min(MAX_QTY, addition.qty) }];
    if (candidate.length > MAX_LINES || encodeCart(candidate).length > MAX_COOKIE_CHARS) { skipped.push(addition.code); continue; }
    next.push(candidate[candidate.length - 1]);
  }
  return { lines: next, skipped };
}

/**
 * Bewaart de winkelwagen in de cookie (een lege wagen wist de cookie).
 * @param {object} req Het verzoek (voor https-detectie).
 * @param {object} res Het antwoord.
 * @param {{ code: string, qty: number }[]} lines De regels.
 * @returns {void}
 */
function writeCart(req, res, lines) {
  const value = encodeCart(fitCart(lines).lines);
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
    return encodeCart(next).length > MAX_COOKIE_CHARS ? lines.map((line) => ({ ...line })) : next;
  }
  if (fields.action === 'remove' || (fields.action === 'set' && !(qty >= 1))) return next.filter((line) => line.code !== code);
  if (fields.action === 'set' && existing) existing.qty = Math.min(MAX_QTY, qty);
  return encodeCart(next).length > MAX_COOKIE_CHARS ? lines.map((line) => ({ ...line })) : next;
}

module.exports = { readCart, writeCart, applyCartAction, addCartLines, CART_COOKIE, MAX_QTY };
