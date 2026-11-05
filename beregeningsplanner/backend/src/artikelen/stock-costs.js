// Inkoopprijzen en voorraadlagen (FIFO) van de artikelen (tabellen stock_cost_prices,
// stock_layers en stock_cost_entries, migratie 45). Wordt gebruikt door stock.js:
// elke mutatie (book) gaat hier langs, binnen de transactie van de aanroeper.
//
// - Inkoopprijs: elke nieuwe prijs is een eigen regel met een datum (geldig vanaf).
//   Een oude prijs blijft staan; stock_items.cost_price is de actuele prijs (de
//   laatste die vandaag geldt).
// - Lagen: elke ontvangst (of retour, of correctie erbij) wordt een laag met de
//   inkoopprijs van dat moment. Een afboeking gebruikt eerst de oudste laag (FIFO):
//   per gebruikte laag komt er een regel in stock_cost_entries met het aantal en de
//   prijs van die laag. De kostprijs van een verkoop blijft zo de prijs waarvoor de
//   artikelen ooit zijn ingekocht, ook als de inkoopprijs later stijgt.
// - Onbekend: een laag zonder prijs (unit_cost leeg) blijft onbekend; er wordt niets
//   geraden. De beheerder kan de prijs van zo'n laag (of van de beginstand) achteraf
//   invullen; de kostprijs van wat al uit die laag verkocht is, gaat dan mee.
// - Meer afboeken dan er in de lagen zit (negatieve voorraad): het tekort krijgt de
//   actuele inkoopprijs (zonder laag, layer_id leeg), want er is geen ontvangst.
// - De lagen volgen altijd de stand: zit er minder in de lagen dan op voorraad (een
//   oude stand van voor migratie 45 of een rechtstreeks ingevoerde stand), dan komt
//   het verschil er als beginstand bij; zit er meer in, dan gaat dat van de oudste af.
const crypto = require('crypto');

/**
 * Afronden op drie decimalen (aantallen).
 * @param {*} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
/**
 * Afronden op vier decimalen (prijs per eenheid).
 * @param {*} value De prijs.
 * @returns {number} De afgeronde prijs.
 */
const round4 = (value) => Math.round((Number(value) || 0) * 10000) / 10000;
/**
 * Afronden op twee decimalen (bedragen).
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * De datum van vandaag (UTC).
 * @returns {string} Bijv. '2026-11-05'.
 */
const today = () => currentTimestamp().slice(0, 10);
/**
 * Is dit een datum als JJJJ-MM-DD die echt bestaat?
 * @param {*} value De invoer.
 * @returns {boolean} true als het een geldige datum is.
 */
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/**
 * Maakt een tekst schoon (geen stuurtekens) en begrenst de lengte.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De schone tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
/** Hoogste inkoopprijs per eenheid die we aannemen. */
const MAX_PRICE = 1e6;
/** Kleine afwijking die we als nul zien (aantallen). */
const EPSILON = 0.0005;
/** Hoeveel prijsregels en lagen het artikel toont. */
const HISTORY_LIMIT = 100;
/** Waar een laag vandaan komt, in gewone woorden. */
const LAYER_SOURCES = { ontvangst: 'Ontvangst', retour: 'Retour', correctie: 'Correctie', telling: 'Telling', beginstand: 'Beginstand' };

/**
 * Controleert een inkoopprijs uit de invoer.
 * @param {*} value De invoer.
 * @returns {{ value?: number, error?: string }} De prijs (vier decimalen) of een foutmelding.
 */
function parsePrice(value) {
  const price = value === '' || value == null ? NaN : Number(value);
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) return { error: 'Vul een geldige inkoopprijs in (0 of hoger).' };
  return { value: round4(price) };
}

/**
 * Maakt de opslag voor inkoopprijzen en voorraadlagen.
 * @param {object} db De database (SQLite of PostgreSQL).
 * @returns {object} De functies (zie hieronder); de schrijvende lopen binnen de transactie van de aanroeper.
 */
function createStockCosts(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Legt een kostregel vast: welk deel van een mutatie tegen welke prijs ging.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ movementId: string, itemId: string, layerId: ?string, qty: number, unitCost: ?number, at: string }} entry De regel (qty met het teken van de mutatie).
   * @returns {void}
   */
  function addEntry(tenantId, { movementId, itemId, layerId, qty, unitCost, at }) {
    prepare(`INSERT INTO stock_cost_entries (id, tenant_id, movement_id, item_id, layer_id, qty, unit_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), tenantId, movementId, itemId, layerId, round3(qty), unitCost == null ? null : round4(unitCost), at);
  }

  /**
   * Laat de lagen weer kloppen met de stand vóór een mutatie: wat er te weinig in
   * zit komt erbij als beginstand (tegen de huidige inkoopprijs, leeg = onbekend),
   * wat er te veel in zit gaat van de oudste lagen af.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, cost_price: ?number, created_at: string }} item Het artikel.
   * @param {number} onHandBefore De stand vóór de mutatie.
   * @returns {void}
   */
  function alignLayers(tenantId, item, onHandBefore) {
    const inLayers = Number(prepare('SELECT COALESCE(SUM(remaining), 0) AS qty FROM stock_layers WHERE tenant_id = ? AND item_id = ? AND remaining > 0').get(tenantId, item.id).qty);
    const wanted = Math.max(0, round3(onHandBefore));
    const difference = round3(wanted - inLayers);
    if (difference > EPSILON) {
      const at = currentTimestamp();
      prepare(`INSERT INTO stock_layers (id, tenant_id, item_id, movement_id, received_at, qty, remaining, unit_cost, source, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'beginstand', ?)`)
        .run(crypto.randomUUID(), tenantId, item.id, item.created_at || at, difference, difference, item.cost_price == null ? null : round4(item.cost_price), at);
    } else if (difference < -EPSILON) {
      takeFromLayers(tenantId, item.id, -difference, () => {});
    }
  }

  /**
   * Haalt een aantal uit de lagen, oudste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {number} qty Het aantal (positief).
   * @param {Function} onTake Wordt per gebruikte laag aangeroepen met (laag, aantal).
   * @returns {number} Wat er niet in de lagen zat (tekort).
   */
  function takeFromLayers(tenantId, itemId, qty, onTake) {
    let rest = round3(qty);
    const layers = prepare(`SELECT id, remaining, unit_cost FROM stock_layers WHERE tenant_id = ? AND item_id = ? AND remaining > 0
      ORDER BY received_at, created_at, id`).all(tenantId, itemId);
    const update = prepare('UPDATE stock_layers SET remaining = ? WHERE tenant_id = ? AND id = ?');
    for (const layer of layers) {
      if (rest <= EPSILON) break;
      const taken = Math.min(rest, Number(layer.remaining));
      update.run(round3(Number(layer.remaining) - taken), tenantId, layer.id);
      onTake(layer, taken);
      rest = round3(rest - taken);
    }
    return Math.max(0, rest);
  }

  /**
   * De gemiddelde kostprijs waartegen eerder is afgeboekt, om een retour tegen
   * dezelfde prijs terug te nemen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ source?: string, workOrderId?: ?string }} basis De werkorder van de oorspronkelijke afboeking, of anders de bron (bijv. 'bestelling:W2026-0001').
   * @returns {number|null|undefined} De prijs per eenheid, null als die onbekend was, undefined als er geen afboeking is gevonden.
   */
  function issuedCost(tenantId, itemId, { source = '', workOrderId = null }) {
    if (!source && !workOrderId) return undefined;
    const conditions = [];
    const args = [tenantId, itemId];
    // Een werkorder is specifieker dan een algemene bron zoals 'handmatig' of 'gereed'.
    if (workOrderId) { conditions.push('m.work_order_id = ?'); args.push(String(workOrderId)); } else { conditions.push('m.source = ?'); args.push(String(source)); }
    const row = prepare(`SELECT SUM(-e.qty) AS qty, SUM(CASE WHEN e.unit_cost IS NULL THEN 0 ELSE -e.qty END) AS known_qty,
        SUM(CASE WHEN e.unit_cost IS NULL THEN 0 ELSE -e.qty * e.unit_cost END) AS cost
      FROM stock_cost_entries e JOIN stock_movements m ON m.tenant_id = e.tenant_id AND m.id = e.movement_id
      WHERE e.tenant_id = ? AND e.item_id = ? AND e.qty < 0 AND (${conditions.join(' OR ')})`).get(...args);
    if (!row || !(Number(row.qty) > 0)) return undefined;
    if (!(Number(row.known_qty) > 0)) return null;
    return round4(Number(row.cost) / Number(row.known_qty));
  }

  /**
   * Verwerkt een mutatie in de lagen (aangeroepen door stock.book, na het bijwerken
   * van de stand en het logboek).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, cost_price: ?number, created_at: string }} item Het artikel zoals het vóór de mutatie was.
   * @param {{ movementId: string, delta: number, onHandBefore: number, kind: string, at: string, unitCost?: number|null, costBasis?: object }} movement
   *   De mutatie: id, wijziging, stand ervoor, soort, tijdstip, een opgegeven inkoopprijs (ontvangst) en waar een retour vandaan komt (costBasis: source en/of workOrderId).
   * @returns {{ cost: number, unknownQty: number }} Kostprijs van wat eraf ging (positief) en het aantal zonder bekende prijs; bij erbij beide 0.
   */
  function record(tenantId, item, { movementId, delta, onHandBefore, kind, at, unitCost, costBasis }) {
    alignLayers(tenantId, item, onHandBefore);
    const qty = round3(delta);
    if (qty > 0) {
      let cost = unitCost;
      if (cost === undefined && kind === 'retour' && costBasis) cost = issuedCost(tenantId, item.id, costBasis);
      if (cost === undefined) cost = item.cost_price == null ? null : Number(item.cost_price);
      // Bij een negatieve stand vult de ontvangst eerst het tekort aan; alleen de rest komt in de laag.
      const remaining = Math.max(0, round3(qty - Math.max(0, -round3(onHandBefore))));
      const layerId = crypto.randomUUID();
      prepare(`INSERT INTO stock_layers (id, tenant_id, item_id, movement_id, received_at, qty, remaining, unit_cost, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(layerId, tenantId, item.id, movementId, at, qty, remaining, cost == null ? null : round4(cost), LAYER_SOURCES[kind] ? kind : 'ontvangst', at);
      addEntry(tenantId, { movementId, itemId: item.id, layerId, qty, unitCost: cost, at });
      return { cost: 0, unknownQty: 0 };
    }
    if (qty < 0) {
      let cost = 0;
      let unknownQty = 0;
      const shortage = takeFromLayers(tenantId, item.id, -qty, (layer, taken) => {
        addEntry(tenantId, { movementId, itemId: item.id, layerId: layer.id, qty: -taken, unitCost: layer.unit_cost, at });
        if (layer.unit_cost == null) unknownQty += taken; else cost += taken * Number(layer.unit_cost);
      });
      if (shortage > EPSILON) {
        const current = item.cost_price == null ? null : Number(item.cost_price);
        addEntry(tenantId, { movementId, itemId: item.id, layerId: null, qty: -shortage, unitCost: current, at });
        if (current == null) unknownQty += shortage; else cost += shortage * current;
      }
      return { cost: round2(cost), unknownQty: round3(unknownQty) };
    }
    return { cost: 0, unknownQty: 0 };
  }

  /**
   * De inkoopprijs die op een datum gold.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {string} date Datum (JJJJ-MM-DD).
   * @returns {number|null} De prijs, of null als er toen nog geen was.
   */
  function priceOn(tenantId, itemId, date) {
    const row = prepare(`SELECT price FROM stock_cost_prices WHERE tenant_id = ? AND item_id = ? AND valid_from <= ?
      ORDER BY valid_from DESC, created_at DESC LIMIT 1`).get(tenantId, itemId, date);
    return row ? Number(row.price) : null;
  }

  /**
   * Legt een nieuwe inkoopprijs vast (de oude blijft in de historie) en zet de
   * actuele prijs van het artikel als die nu geldt. Binnen de transactie van de aanroeper.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, cost_price: ?number }} item Het artikel.
   * @param {{ price: number, validFrom?: string, note?: string, user?: object|null }} change De prijs, vanaf wanneer (standaard vandaag, niet in de toekomst), toelichting en wie.
   * @returns {{ costPrice?: number|null, error?: string, field?: string }} De actuele prijs na de wijziging, of een foutmelding.
   */
  function addPrice(tenantId, item, { price, validFrom = '', note = '', user = null }) {
    const checked = parsePrice(price);
    if (checked.error) return { error: checked.error, field: 'price' };
    const date = validFrom ? String(validFrom) : today();
    if (!isDate(date)) return { error: 'Vul een geldige datum in.', field: 'validFrom' };
    if (date > today()) return { error: 'Een inkoopprijs geldt vanaf vandaag of eerder; een prijs voor later kun je op die dag invoeren.', field: 'validFrom' };
    const at = currentTimestamp();
    prepare(`INSERT INTO stock_cost_prices (id, tenant_id, item_id, price, valid_from, note, user_id, user_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), tenantId, item.id, checked.value, date, cleanText(note, 200), user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', at);
    const current = priceOn(tenantId, item.id, today());
    prepare('UPDATE stock_items SET cost_price = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(current, at, tenantId, item.id);
    return { costPrice: current };
  }

  /**
   * Na het opslaan van het artikelformulier: een andere inkoopprijs komt als nieuwe
   * regel (vandaag) in de historie. Een lege prijs wist niets uit de historie.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {?number} before De prijs vóór het opslaan.
   * @param {?number} after De prijs na het opslaan.
   * @param {object|null} user Wie het deed.
   * @returns {void}
   */
  function noteFormPrice(tenantId, itemId, before, after, user) {
    if (after == null || (before != null && round4(before) === round4(after))) return;
    prepare(`INSERT INTO stock_cost_prices (id, tenant_id, item_id, price, valid_from, note, user_id, user_name, created_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`)
      .run(crypto.randomUUID(), tenantId, itemId, round4(after), today(), user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', currentTimestamp());
  }

  /**
   * Zet een laagrij om naar het formaat van de API.
   * @param {object} row Rij met id, received_at, source, qty, remaining en unit_cost.
   * @returns {{ id: string, receivedAt: string, source: string, qty: number, remaining: number, unitCost: ?number, value: ?number, editable: boolean }} De laag.
   */
  const shapeLayer = (row) => ({
    id: row.id, receivedAt: row.received_at, source: row.source, qty: round3(row.qty), remaining: round3(row.remaining),
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    value: row.unit_cost == null ? null : round2(Number(row.remaining) * Number(row.unit_cost)),
    editable: row.unit_cost == null || row.source === 'beginstand',
  });

  /**
   * De prijshistorie (nieuwste eerst) en de voorraadlagen (oudste eerst, zoals ze
   * gebruikt worden) van een artikel, in één query: lagen waar nog iets in zit, en
   * lege lagen met een onbekende prijs (zodat die prijs nog in te vullen is).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ prices: object[], layers: object[] }} prices: id, price, validFrom, note, userName, createdAt; layers: zie shapeLayer.
   */
  function historyOf(tenantId, itemId) {
    const rows = prepare(`SELECT 'prijs' AS part, id, valid_from AS moment, note AS label, 0 AS qty, 0 AS remaining, price AS amount, user_name, created_at FROM (
        SELECT id, valid_from, note, price, user_name, created_at FROM stock_cost_prices WHERE tenant_id = ? AND item_id = ?
        ORDER BY valid_from DESC, created_at DESC LIMIT ${HISTORY_LIMIT}) AS price_rows
      UNION ALL
      SELECT 'laag' AS part, id, received_at AS moment, source AS label, qty, remaining, unit_cost AS amount, '' AS user_name, created_at FROM (
        SELECT id, received_at, source, qty, remaining, unit_cost, created_at FROM stock_layers WHERE tenant_id = ? AND item_id = ? AND (remaining > 0 OR unit_cost IS NULL)
        ORDER BY received_at, created_at, id LIMIT ${HISTORY_LIMIT}) AS layer_rows`).all(tenantId, itemId, tenantId, itemId);
    const prices = rows.filter((row) => row.part === 'prijs')
      .sort((left, right) => String(right.moment).localeCompare(String(left.moment)) || String(right.created_at).localeCompare(String(left.created_at)))
      .map((row) => ({ id: row.id, price: Number(row.amount), validFrom: row.moment, note: row.label, userName: row.user_name, createdAt: row.created_at }));
    const layers = rows.filter((row) => row.part === 'laag')
      .sort((left, right) => String(left.moment).localeCompare(String(right.moment)) || String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)))
      .map((row) => shapeLayer({ id: row.id, received_at: row.moment, source: row.label, qty: row.qty, remaining: row.remaining, unit_cost: row.amount }));
    return { prices, layers };
  }

  /**
   * Vult de inkoopprijs in van een laag waarvan hij onbekend was (of corrigeert de
   * beginstand). Wat al uit die laag is afgeboekt, krijgt dezelfde prijs.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {string} layerId Id van de laag.
   * @param {*} unitCost De prijs per eenheid.
   * @returns {{ ok?: boolean, error?: string, field?: string, status?: number }} ok, of een foutmelding.
   */
  function setLayerCost(tenantId, itemId, layerId, unitCost) {
    const checked = parsePrice(unitCost);
    if (checked.error) return { error: checked.error, field: 'unitCost', status: 400 };
    const layer = prepare('SELECT id, source, unit_cost FROM stock_layers WHERE tenant_id = ? AND item_id = ? AND id = ?').get(tenantId, String(itemId), String(layerId));
    if (!layer) return { error: 'not_found', status: 404 };
    if (layer.unit_cost != null && layer.source !== 'beginstand') {
      return { error: 'De inkoopprijs van een ontvangst ligt vast. Alleen een onbekende prijs of de beginstand kun je invullen.', status: 409 };
    }
    prepare('UPDATE stock_layers SET unit_cost = ? WHERE tenant_id = ? AND id = ?').run(checked.value, tenantId, layer.id);
    prepare('UPDATE stock_cost_entries SET unit_cost = ? WHERE tenant_id = ? AND layer_id = ?').run(checked.value, tenantId, layer.id);
    return { ok: true };
  }

  /**
   * De voorraadwaarde op inkoop volgens de lagen (FIFO) van alle artikelen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ value: number, unknownQty: number, unknownItems: number }} Waarde van de lagen met een prijs, aantal zonder prijs en het aantal artikelen daarmee.
   */
  function stockValue(tenantId) {
    const row = prepare(`SELECT SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE remaining * unit_cost END) AS value,
        SUM(CASE WHEN unit_cost IS NULL THEN remaining ELSE 0 END) AS unknown_qty,
        COUNT(DISTINCT CASE WHEN unit_cost IS NULL THEN item_id END) AS unknown_items
      FROM stock_layers WHERE tenant_id = ? AND remaining > 0`).get(tenantId);
    return { value: round2(row && row.value), unknownQty: round3(row && row.unknown_qty), unknownItems: Number(row && row.unknown_items) || 0 };
  }

  /**
   * Wist de prijzen en lagen van een artikel dat echt verwijderd wordt (zonder mutaties).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {void}
   */
  function removeItem(tenantId, itemId) {
    prepare('DELETE FROM stock_cost_entries WHERE tenant_id = ? AND item_id = ?').run(tenantId, itemId);
    prepare('DELETE FROM stock_layers WHERE tenant_id = ? AND item_id = ?').run(tenantId, itemId);
    prepare('DELETE FROM stock_cost_prices WHERE tenant_id = ? AND item_id = ?').run(tenantId, itemId);
  }

  return { record, addPrice, noteFormPrice, priceOn, historyOf, setLayerCost, stockValue, removeItem };
}

module.exports = { createStockCosts, parsePrice, LAYER_SOURCES };
