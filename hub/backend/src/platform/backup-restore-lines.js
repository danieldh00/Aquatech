// Orderregels (en offerteregels) afzonderlijk terugzetten uit een back-up. Het hele record terugzetten kan in backup-restore.js;
// hier komt per regel een weergave (gelijk, gewijzigd, ontbreekt) en kan een gekozen regel terug naar de stand van de back-up,
// waarna de totalen opnieuw worden berekend. Een bestelling mag alleen nog worden aangepast zolang er niets mee gebeurd is
// (status nieuw, niets verzonden, geen online betaling); de voorraadreservering wordt daarbij opnieuw gelegd.
const { transaction } = require('../database/db');

const MAX_KEYS = 100;
/**
 * Rondt een bedrag af op centen.
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Leest de JSON-tekst van een record veilig.
 * @param {*} text De tekst uit de database.
 * @returns {object} Het object, of een leeg object.
 */
function parseData(text) {
  try {
    const value = JSON.parse(String(text || '{}'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    return {};
  }
}

/**
 * Een vaste tekstvorm van een waarde, om regels te kunnen vergelijken (de volgorde van de sleutels speelt geen rol).
 * @param {*} value De waarde.
 * @returns {string} De tekst.
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * De soorten records waarvan regels afzonderlijk terug kunnen, met hoe een regel herkend, getoond en geblokkeerd wordt.
 */
const LINE_KINDS = {
  quote: {
    label: 'Offerte', select: 'SELECT id, number, status, title, order_id, CASE WHEN acceptance IS NULL THEN 0 ELSE 1 END AS accepted, data FROM quotes WHERE tenant_id = ? AND id = ?',
    keyOf: (line) => String(line.id || ''),
    describe: (line) => `${line.description || line.code || '(regel)'} · ${line.qty ?? ''} ${line.unit || ''} × € ${Number(line.price || 0).toFixed(2)}`.replace(/\s+/g, ' ').trim(),
    blocked: (row) => (Number(row.accepted) || row.order_id ? 'Deze offerte is geaccordeerd en vergrendeld.' : ''),
  },
  web_order: {
    label: 'Webshopbestelling', select: 'SELECT id, number, status, customer_name, total, data FROM web_orders WHERE tenant_id = ? AND id = ?',
    keyOf: (line) => String(line.code || ''),
    describe: (line) => `${line.name || line.code} · ${line.qty} ${line.unit || ''} × € ${Number(line.unitIncl || 0).toFixed(2)} = € ${Number(line.lineTotal || 0).toFixed(2)}`.replace(/\s+/g, ' ').trim(),
    blocked: (row, data) => {
      if (row.status !== 'nieuw') return 'Alleen een nieuwe bestelling is nog aan te passen.';
      if ((data.shipments || []).length || (data.lines || []).some((line) => Number(line.shippedQty) > 0)) return 'Er is al (deels) geleverd.';
      if (data.payment === 'online') return 'Een bestelling met online betaling past de bedragen niet meer aan.';
      return '';
    },
  },
};

/**
 * Welke soorten records regels afzonderlijk kunnen terugzetten.
 * @returns {string[]} De sleutels.
 */
function lineKinds() {
  return Object.keys(LINE_KINDS);
}

/**
 * Leest het record uit de back-up en uit de actieve database.
 * @param {object} scene { backup, current, context }.
 * @param {string} kind De soort (quote of web_order).
 * @param {string} id Het record.
 * @returns {{ spec: object, before: ?object, now: ?object }} De definitie en beide rijen (leeg als ze er niet zijn).
 */
function rowsOf({ backup, current, context }, kind, id) {
  const spec = LINE_KINDS[kind];
  if (!spec) throw Object.assign(new Error('Van dit soort record zijn de regels niet afzonderlijk terug te zetten.'), { status: 400 });
  return {
    spec,
    before: backup.prepare(spec.select).get(context.tenantId, String(id)) || null,
    now: current.prepare(spec.select).get(context.tenantId, String(id)) || null,
  };
}

/**
 * Het overzicht van de regels: per regel of hij gelijk is, gewijzigd of ontbreekt (die twee zijn terug te zetten), plus de regels
 * die er nu extra bij staan.
 * @param {object} scene { backup, current, context }.
 * @param {{ kind: string, id: string }} target De soort en het record.
 * @returns {{ id: string, label: string, blocked: string, lines: object[] }} De weergave.
 */
function linesView(scene, { kind, id }) {
  const { spec, before, now } = rowsOf(scene, kind, id);
  if (!before) return { id: String(id), label: '', blocked: 'Dit record staat niet in de back-up.', lines: [] };
  const label = `${before.number || before.id}`;
  if (!now) return { id: String(id), label, blocked: 'Het record bestaat niet meer: zet het eerst als geheel terug.', lines: [] };
  const nowData = parseData(now.data);
  const backupLines = parseData(before.data).lines || [];
  const nowLines = nowData.lines || [];
  const nowByKey = new Map(nowLines.map((line) => [spec.keyOf(line), line]));
  const backupKeys = new Set(backupLines.map((line) => spec.keyOf(line)));
  const lines = backupLines.map((line) => {
    const key = spec.keyOf(line);
    const present = nowByKey.get(key);
    const state = !present ? 'ontbreekt' : stable(present) === stable(line) ? 'gelijk' : 'gewijzigd';
    return { key, state, backup: spec.describe(line), current: present ? spec.describe(present) : '' };
  });
  for (const line of nowLines) {
    if (!backupKeys.has(spec.keyOf(line))) lines.push({ key: spec.keyOf(line), state: 'extra', backup: '', current: spec.describe(line) });
  }
  return { id: String(id), label, blocked: spec.blocked(now, nowData), lines };
}

/**
 * De btw-regel voor de verzendkosten van een bestelling, zoals bij het plaatsen (alleen als ze niet gratis zijn).
 * @param {object} data De gegevens van de bestelling.
 * @returns {object[]} De regel (of niets) voor de totalen.
 */
function shippingLineOf(data) {
  const shipping = data.shipping;
  if (!shipping || !(Number(shipping.price) > 0)) return [];
  const rate = Number(shipping.vatRate) || 0;
  if (data.customerGroup === 'zakelijk') {
    const shifted = Boolean(data.vat && data.vat.shifted);
    return [{ vatRate: rate, lineExcl: Number(shipping.priceExcl), lineTotal: shifted ? Number(shipping.priceExcl) : round2(Number(shipping.priceExcl) * (1 + rate / 100)) }];
  }
  return [{ vatRate: rate, lineTotal: Number(shipping.price) }];
}

/**
 * Zet de gekozen regels terug en rekent de totalen opnieuw. Alles of niets, in één transactie. Een bestelling wordt alleen
 * aangepast als de huidige totalen nog bij de regels passen en er voldoende voorraad is voor de teruggezette aantallen.
 * @param {object} scene { backup, current, context }.
 * @param {{ kind: string, id: string, keys: string[] }} target Het record en de sleutels van de regels die terug moeten.
 * @param {{ QuoteCore: object, totalsOf: Function, stockLinesOf: Function, stock: object }} deps De rekenkern van offertes, de totalen en de voorraad van de bestelling.
 * @returns {{ id: string, label: string, status: string, message: string, restored: number }} De uitkomst.
 */
function applyLines(scene, { kind, id, keys }, deps) {
  const { current, context } = scene;
  const view = linesView(scene, { kind, id });
  if (view.blocked) throw Object.assign(new Error(view.blocked), { status: 409 });
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, MAX_KEYS);
  if (!wanted.length) throw Object.assign(new Error('Kies minstens één regel.'), { status: 400 });
  const restorable = new Map(view.lines.filter((line) => line.state === 'ontbreekt' || line.state === 'gewijzigd').map((line) => [line.key, line]));
  const chosen = wanted.filter((key) => restorable.has(key));
  if (!chosen.length) throw Object.assign(new Error('Die regels zijn niet terug te zetten (ze zijn al gelijk).'), { status: 409 });
  const { spec, before, now } = rowsOf(scene, kind, id);
  const backupLines = parseData(before.data).lines || [];
  const nowData = parseData(now.data);
  const lines = [...(nowData.lines || [])];
  for (const key of chosen) {
    const source = backupLines.find((line) => spec.keyOf(line) === key);
    const at = lines.findIndex((line) => spec.keyOf(line) === key);
    if (at >= 0) lines[at] = source; else lines.splice(Math.min(backupLines.indexOf(source), lines.length), 0, source);
  }
  const timestamp = new Date().toISOString();
  return transaction(current, () => {
    if (kind === 'quote') {
      const data = { ...nowData, lines };
      const totals = deps.QuoteCore.totals(data);
      current.prepare('UPDATE quotes SET total_excl = ?, total_incl = ?, data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(totals.net, totals.total, JSON.stringify(data), timestamp, context.tenantId, String(id));
      return { id: String(id), label: view.label, status: 'bijgewerkt', message: `${chosen.length} regel${chosen.length === 1 ? '' : 's'} teruggezet; nieuw totaal € ${totals.total.toFixed(2)} incl. btw.`, restored: chosen.length };
    }
    // Webshopbestelling: eerst controleren dat de huidige totalen bij de huidige regels horen, anders rekenen we op een onbekende basis.
    const extra = shippingLineOf(nowData);
    const stored = nowData.totals && Number(nowData.totals.total);
    const recomputed = deps.totalsOf([...(nowData.lines || []), ...extra]).total;
    if (!(Math.abs(stored - recomputed) <= 0.005)) throw Object.assign(new Error('De totalen van deze bestelling kloppen niet met de regels; die zijn niet automatisch aan te passen.'), { status: 409 });
    const stockLines = deps.stockLinesOf(lines.filter((line) => line.itemId));
    if (!nowData.reservationReleasedAt && stockLines.length) {
      const short = deps.stock.shortageFor(context.tenantId, stockLines, `order:${id}`);
      if (short.length) throw Object.assign(new Error(`Te weinig voorraad voor: ${short.map((item) => item.name).join(', ')}. Er is niets teruggezet.`), { status: 409 });
    }
    const totals = deps.totalsOf([...lines, ...extra]);
    const data = { ...nowData, lines, totals, history: [...(nowData.history || []), { at: timestamp, status: now.status, by: 'Terugzetten uit back-up', note: `${chosen.length} regel(s) teruggezet` }] };
    current.prepare('UPDATE web_orders SET total = ?, data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(totals.total, JSON.stringify(data), timestamp, context.tenantId, String(id));
    if (!nowData.reservationReleasedAt) {
      deps.stock.releaseOrder(context.tenantId, String(id));
      if (stockLines.length) deps.stock.reserveOrder(context.tenantId, String(id), stockLines);
    }
    return { id: String(id), label: view.label, status: 'bijgewerkt', message: `${chosen.length} regel${chosen.length === 1 ? '' : 's'} teruggezet; nieuw totaal € ${totals.total.toFixed(2)} incl. btw.`, restored: chosen.length };
  });
}

module.exports = { lineKinds, linesView, applyLines, LINE_KINDS };
