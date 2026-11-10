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
      if (existing.qty + addition.qty > MAX_QTY) { skipped.push(addition.code); continue; }
      // Een hoger aantal kan het cijfer langer maken: alleen toepassen als de cookie nog past.
      const raised = next.map((line) => (line === existing ? { ...line, qty: line.qty + addition.qty } : line));
      if (encodeCart(raised).length > MAX_COOKIE_CHARS) skipped.push(addition.code);
      else existing.qty += addition.qty;
      continue;
    }
    const candidate = [...next, { code: addition.code, qty: Math.min(MAX_QTY, addition.qty) }];
    if (candidate.length > MAX_LINES || encodeCart(candidate).length > MAX_COOKIE_CHARS) { skipped.push(addition.code); continue; }
    next.push(candidate[candidate.length - 1]);
  }
  return { lines: next, skipped };
}

/**
 * Zet de hoeveelheden uit een plan in de winkelwagen: een artikel dat er al in zit krijgt het aantal uit het plan (niet erbij,
 * zodat nogmaals klikken niets verdubbelt), nieuwe artikelen komen achteraan. Wat niet meer past (te veel regels of een te grote cookie) blijft weg.
 * @param {{ code: string, qty: number }[]} current De huidige regels.
 * @param {{ code: string, qty: number }[]} planned De regels uit het plan (codes in hoofdletters, aantal van 1 of meer).
 * @returns {{ lines: { code: string, qty: number }[], skipped: string[] }} De nieuwe wagen en de codes die niet pasten.
 */
function setCartLines(current, planned) {
  let next = current.map((line) => ({ ...line }));
  const skipped = [];
  for (const entry of planned) {
    const qty = Math.min(MAX_QTY, Math.max(1, Math.floor(Number(entry.qty)) || 1));
    const existing = next.find((line) => line.code === entry.code);
    const candidate = existing ? next.map((line) => (line === existing ? { ...line, qty } : line)) : [...next, { code: entry.code, qty }];
    if (candidate.length > MAX_LINES || encodeCart(candidate).length > MAX_COOKIE_CHARS) skipped.push(entry.code);
    else next = candidate;
  }
  return { lines: next, skipped };
}

/** Andere schrijfwijzen van dezelfde eenheid (planner en Artikelen gebruiken niet altijd dezelfde afkorting). */
const UNIT_ALIASES = { stuk: 'st', stuks: 'st', stk: 'st', meter: 'm', mtr: 'm', rollen: 'rol' };

/**
 * Maakt een eenheid vergelijkbaar: kleine letters, zonder spaties en punten, en vaste afkortingen.
 * @param {string} unit De eenheid, bijvoorbeeld 'Meter' of 'st.'.
 * @returns {string} De vergelijkbare vorm, bijvoorbeeld 'm' of 'st'.
 */
function unitKey(unit) {
  const text = String(unit || '').toLowerCase().replace(/[\s.]/g, '');
  return UNIT_ALIASES[text] || text;
}

/**
 * Leest de gevraagde artikelen uit het formulier van de planner: velden `q:<code>` met het aantal en `u:<code>` met de eenheid van de planner.
 * @param {object} body De velden van het formulier.
 * @returns {{ code: string, qty: number, planQty: number, unit: string }[]} De regels (hoogstens MAX_LINES, elke code één keer): het naar boven afgeronde aantal, het aantal van het plan en de eenheid.
 */
function plannedLinesFrom(body) {
  const fields = body || {};
  const lines = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('q:')) continue;
    const code = key.slice(2).trim().toUpperCase().slice(0, 60);
    const planQty = Number(value);
    const qty = Math.ceil(planQty);
    const unit = String(fields[`u:${key.slice(2)}`] || '').trim().slice(0, 12);
    if (code && qty >= 1 && !lines.some((line) => line.code === code)) lines.push({ code, qty: Math.min(MAX_QTY, qty), planQty: Math.min(MAX_QTY, planQty), unit });
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/**
 * Rekent het aantal van de planner om naar het aantal van het artikel in de shop (W-10 uit de audit van 1.7.3).
 * Dezelfde eenheid: het aantal blijft. Een andere eenheid met een inhoud per eenheid (bijv. 50 m per rol):
 * delen en naar boven afronden. Een andere eenheid zonder inhoud: niet om te rekenen.
 * @param {{ qty: number, planQty: number, unit: string }} planned De regel uit de planner.
 * @param {{ unit: string, unitContent?: ?number }} article Het artikel in de shop.
 * @returns {?number} Het aantal voor de winkelwagen, of null als de eenheden niet om te rekenen zijn.
 */
function convertPlannedQty(planned, article) {
  if (!planned.unit || unitKey(planned.unit) === unitKey(article.unit)) return planned.qty;
  const content = Number(article.unitContent);
  if (!(content > 0)) return null;
  return Math.max(1, Math.ceil(planned.planQty / content - 1e-9));
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
    if (amount > MAX_QTY - (existing ? existing.qty : 0)) return lines.map((line) => ({ ...line }));
    if (existing) existing.qty += amount;
    else if (next.length < MAX_LINES) next.push({ code, qty: amount });
    return encodeCart(next).length > MAX_COOKIE_CHARS ? lines.map((line) => ({ ...line })) : next;
  }
  if (fields.action === 'remove' || (fields.action === 'set' && !(qty >= 1))) return next.filter((line) => line.code !== code);
  if (fields.action === 'set' && existing) existing.qty = Math.min(MAX_QTY, qty);
  return encodeCart(next).length > MAX_COOKIE_CHARS ? lines.map((line) => ({ ...line })) : next;
}

/**
 * Of een gewone winkelwagenactie (toevoegen of aantal wijzigen) geweigerd is omdat de wagen vol is (te veel regels of een te grote cookie).
 * @param {{ code: string, qty: number }[]} before De regels voor de actie.
 * @param {{ code: string, qty: number }[]} after De regels die applyCartAction teruggaf.
 * @param {object} fields De velden van het formulier (action, code, qty).
 * @returns {boolean} true als de wijziging niet is doorgevoerd.
 */
function cartActionRejected(before, after, fields) {
  const code = String(fields.code || '').trim().toUpperCase().slice(0, 60);
  const qty = Math.floor(Number(fields.qty));
  const previous = before.find((line) => line.code === code);
  const current = after.find((line) => line.code === code);
  if (!code) return false;
  if (fields.action === 'add') {
    const amount = qty >= 1 ? qty : 1;
    return !current || amount > MAX_QTY - (previous ? previous.qty : 0) || Boolean(previous && current.qty === previous.qty);
  }
  if (fields.action === 'set' && qty >= 1) return !current || current.qty !== Math.min(MAX_QTY, qty);
  return false;
}

module.exports = { readCart, writeCart, applyCartAction, cartActionRejected, addCartLines, setCartLines, plannedLinesFrom, convertPlannedQty, unitKey, CART_COOKIE, MAX_QTY };
