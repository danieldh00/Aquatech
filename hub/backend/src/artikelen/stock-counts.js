// Voorraadtelling (jaartelling voor de boekhouding en tussentijdse tellingen): een telling bevriest de tellijst op een peildatum, de tellers tellen
// blind (geen verwachte aantallen, geen prijzen), de beheerder controleert de verschillen en sluit af. Afsluiten boekt alle verschillen in één
// transactie als `telling`-mutaties via `stock.book` en vergrendelt de telling. Het verschil wordt gerekend ten opzichte van de stand op het
// telmoment, dus een pick of ontvangst tijdens het tellen geeft nooit een vals verschil. Een ingave mag het tijdstip van de teller meesturen
// (`countedAt`, nodig voor een ingave die later aankomt, zoals een latere offlinewachtrij); een tijdstip vóór het bevriezen of in de toekomst telt
// als servertijd. Een afsluiting die tegelijk met een andere wijziging botst, geeft 409 en boekt niets. Alles loopt per omgeving (tenant).

const crypto = require('crypto');
const express = require('express');
const { transaction } = require('../database/db');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { verifyPassword } = require('../platform/store');

const KINDS = ['jaar', 'tussentijds'];
const MAX_QTY = 1e6;
const MAX_LOCATIONS = 50;
const MAX_LINES = 20000;
const PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 2000;
const INSERT_BATCH = 200;
const DEFAULT_THRESHOLD = { amount: 50, pct: 10 };

/**
 * Rondt een aantal af op drie decimalen (zoals de voorraad rekent).
 * @param {number} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

/**
 * Rondt een bedrag af op centen.
 * @param {number} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Maakt van tekst een korte, veilige regel (stuurtekens weg, ingekort).
 * @param {*} value De tekst.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De opgeschoonde tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);

/**
 * Controleert een datum JJJJ-MM-DD (bestaat echt).
 * @param {*} value De datum.
 * @returns {boolean} true als het een geldige datum is.
 */
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Sorteert locaties in natuurlijke volgorde; "geen locatie" (leeg) komt als laatste.
 * @param {string} left De ene locatie.
 * @param {string} right De andere locatie.
 * @returns {number} Negatief, nul of positief.
 */
function byLocation(left, right) {
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right, 'nl', { numeric: true });
}

/**
 * Maakt de drempel voor verplicht hertellen veilig: bedrag (euro) en percentage, 0 = uit.
 * @param {*} raw De ingevoerde drempel.
 * @returns {{ amount: number, pct: number }} De drempel.
 */
function sanitizeThreshold(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const amount = Number(input.amount);
  const pct = Number(input.pct);
  return {
    amount: Number.isFinite(amount) && amount >= 0 && amount <= 1e6 ? round2(amount) : DEFAULT_THRESHOLD.amount,
    pct: Number.isFinite(pct) && pct >= 0 && pct <= 1000 ? round2(pct) : DEFAULT_THRESHOLD.pct,
  };
}

/**
 * Of een verschil boven de drempel valt (bedrag of percentage van de verwachte stand; 0 = die drempel staat uit).
 * @param {{ difference: number, differenceValue: number, expectedAtCount: number }} line De regel met verschil.
 * @param {{ amount: number, pct: number }} threshold De drempel.
 * @returns {boolean} true als de regel herteld moet worden.
 */
function exceedsThreshold(line, threshold) {
  if (!line.difference) return false;
  if (threshold.amount > 0 && Math.abs(line.differenceValue) >= threshold.amount) return true;
  if (threshold.pct > 0) {
    const base = Math.abs(line.expectedAtCount);
    return base === 0 ? true : Math.abs(line.difference) / base * 100 >= threshold.pct;
  }
  return false;
}

/**
 * Het moment waarop de teller telde: het tijdstip van de client als dat een geldige tijd is, niet in de toekomst en niet vóór het bevriezen
 * (een ingave die later aankomt, bijvoorbeeld na een trage verbinding, telt dan toch voor het juiste moment); anders de servertijd.
 * @param {*} claimed Het tijdstip van de client (ISO-tekst).
 * @param {string} frozenAt Het bevriezingsmoment van de telling.
 * @param {string} now De servertijd nu (ISO-tekst).
 * @returns {string} Het tijdstip (ISO-tekst) dat wordt vastgelegd.
 */
function countMoment(claimed, frozenAt, now) {
  if (typeof claimed !== 'string' || claimed.length > 40) return now;
  const parsed = new Date(claimed);
  if (Number.isNaN(parsed.getTime())) return now;
  const iso = parsed.toISOString();
  return iso > now || iso < frozenAt ? now : iso;
}

/**
 * Maakt de opslag voor voorraadtellingen.
 * @param {object} db De database.
 * @param {{ stock: object }} deps De voorraad (artikelen/stock.js): `book` en `stockValue`.
 * @returns {object} De functies van de voorraadtelling.
 */
function createStockCounts(db, { stock }) {
  /**
   * Bereidt een query voor.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Zet een telling uit de database om naar de vorm voor de API.
   * @param {object} row De rij uit stock_counts.
   * @returns {object} De telling.
   */
  function countOf(row) {
    let scope = [];
    let threshold = DEFAULT_THRESHOLD;
    let summary = {};
    try { scope = JSON.parse(row.scope); } catch { scope = []; }
    try { threshold = sanitizeThreshold(JSON.parse(row.threshold)); } catch { threshold = DEFAULT_THRESHOLD; }
    try { summary = JSON.parse(row.summary); } catch { summary = {}; }
    return {
      id: row.id, number: row.number, kind: row.kind, status: row.status, referenceDate: row.reference_date, frozenAt: row.frozen_at,
      locations: Array.isArray(scope) ? scope : [], threshold, note: row.note, summary,
      createdAt: row.created_at, createdBy: row.created_by_name, closedAt: row.closed_at, closedBy: row.closed_by_name,
    };
  }

  const COUNT_COLS = 'id, number, kind, status, reference_date, frozen_at, scope, threshold, note, summary, created_by_name, closed_at, closed_by_name, created_at';
  const LINE_COLS = `id, item_id, code, name, unit, ean, location, expected_qty, unit_cost, cost_source, counted_qty, counted_at, counted_by_name, status,
    resolution, expected_at_count, moved_since, difference, movement_id`;

  /**
   * Haalt een telling van deze omgeving op.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @returns {object|null} De rij of null.
   */
  function findCount(tenantId, id) {
    return prepare(`SELECT ${COUNT_COLS} FROM stock_counts WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id || '')) || null;
  }

  /**
   * Alle tellingen van de omgeving, nieuwste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De tellingen (zonder regels).
   */
  function list(tenantId) {
    return prepare(`SELECT ${COUNT_COLS} FROM stock_counts WHERE tenant_id = ? ORDER BY created_at DESC, id`).all(tenantId).map(countOf);
  }

  /**
   * De prijs per eenheid van alle artikelen bij de bevriezing: het gewogen gemiddelde van de FIFO-lagen met een bekende prijs, anders de
   * inkoopprijs van het artikel, anders onbekend (nooit raden).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, number>} Per artikel-id het gemiddelde van de lagen met prijs.
   */
  function layerAverages(tenantId) {
    const rows = prepare(`SELECT item_id, SUM(remaining) AS known_qty, SUM(remaining * unit_cost) AS value
      FROM stock_layers WHERE tenant_id = ? AND remaining > 0 AND unit_cost IS NOT NULL GROUP BY item_id`).all(tenantId);
    const averages = new Map();
    for (const row of rows) {
      if (Number(row.known_qty) > 0) averages.set(row.item_id, Number(row.value) / Number(row.known_qty));
    }
    return averages;
  }

  /**
   * Maakt het volgende telnummer van een kalenderjaar (VT2026-01).
   * @param {string} tenantId Id van de omgeving.
   * @param {number} year Het jaar van de peildatum.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, year) {
    const prefix = `VT${year}-`;
    const used = prepare('SELECT COUNT(*) AS n FROM stock_counts WHERE tenant_id = ? AND number LIKE ?').get(tenantId, `${prefix}%`).n;
    return `${prefix}${String(Number(used) + 1).padStart(2, '0')}`;
  }

  /**
   * Start een telling: bevriest de tellijst met de verwachte aantallen en de prijs per eenheid.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie de telling start.
   * @param {{ kind?: string, referenceDate?: string, locations?: string[], threshold?: object, note?: string }} raw De invoer.
   * @returns {{ count: object }|{ error: string, code: string, status: number }} De nieuwe telling of een fout.
   */
  function start(tenantId, user, raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const kind = input.kind === undefined ? 'jaar' : input.kind;
    if (!KINDS.includes(kind)) return { error: 'Kies een jaartelling of een tussentijdse telling.', code: 'invalid', status: 400 };
    const today = new Date().toISOString().slice(0, 10);
    const referenceDate = input.referenceDate === undefined ? today : input.referenceDate;
    if (!isDate(referenceDate) || referenceDate < '2000-01-01') return { error: 'Vul de peildatum in als JJJJ-MM-DD.', code: 'invalid', status: 400 };
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (referenceDate > tomorrow) return { error: 'De peildatum mag niet in de toekomst liggen.', code: 'invalid', status: 400 };
    let locations = [];
    if (input.locations !== undefined && input.locations !== null) {
      if (!Array.isArray(input.locations) || input.locations.length > MAX_LOCATIONS) return { error: 'Kies hoogstens 50 locaties.', code: 'invalid', status: 400 };
      locations = [...new Set(input.locations.map((location) => cleanText(location, 60)))];
    }
    if (kind === 'jaar' && locations.length) return { error: 'Een jaartelling omvat alle locaties.', code: 'invalid', status: 400 };
    const year = Number(referenceDate.slice(0, 4));
    const threshold = sanitizeThreshold(input.threshold);
    const note = cleanText(input.note, 300);
    return transaction(db, () => {
      const averages = layerAverages(tenantId);
      const open = prepare("SELECT number FROM stock_counts WHERE tenant_id = ? AND status = 'tellen'").get(tenantId);
      if (open) return { error: `Telling ${open.number} loopt nog; sluit die eerst af of annuleer hem.`, code: 'count_open', status: 409 };
      if (kind === 'jaar') {
        const done = prepare("SELECT number FROM stock_counts WHERE tenant_id = ? AND kind = 'jaar' AND status = 'afgesloten' AND reference_year = ?").get(tenantId, year);
        if (done) return { error: `Voor ${year} is al een jaartelling afgesloten (${done.number}).`, code: 'year_done', status: 409 };
      }
      let items = prepare(`SELECT id, code, name, unit, ean, location, on_hand, cost_price FROM stock_items
        WHERE tenant_id = ? AND has_variants = 0 AND stock_managed = 1 AND (archived = 0 OR on_hand <> 0) ORDER BY location, code`).all(tenantId);
      if (locations.length) items = items.filter((item) => locations.includes(item.location));
      if (!items.length) return { error: 'Er zijn geen artikelen om te tellen.', code: 'empty', status: 409 };
      if (items.length > MAX_LINES) return { error: `Een telling omvat hoogstens ${MAX_LINES} artikelen; kies minder locaties.`, code: 'too_large', status: 409 };
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const number = nextNumber(tenantId, year);
      prepare(`INSERT INTO stock_counts (id, tenant_id, number, kind, status, reference_date, reference_year, frozen_at, scope, threshold, note, created_by, created_by_name, created_at)
        VALUES (?, ?, ?, ?, 'tellen', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, number, kind, referenceDate, year, now, JSON.stringify(locations), JSON.stringify(threshold), note, user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', now);
      for (let from = 0; from < items.length; from += INSERT_BATCH) {
        const part = items.slice(from, from + INSERT_BATCH);
        const params = [];
        const placeholders = part.map((item) => {
          let cost = null;
          let source = 'onbekend';
          if (averages.has(item.id)) { cost = averages.get(item.id); source = 'fifo'; } else if (item.cost_price != null) { cost = Number(item.cost_price); source = 'inkoopprijs'; }
          params.push(crypto.randomUUID(), tenantId, id, item.id, item.code, item.name, item.unit, item.ean || '', item.location || '', round3(item.on_hand), cost == null ? null : Math.round(cost * 10000) / 10000, source);
          return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        });
        prepare(`INSERT INTO stock_count_lines (id, tenant_id, count_id, item_id, code, name, unit, ean, location, expected_qty, unit_cost, cost_source) VALUES ${placeholders.join(', ')}`).run(...params);
      }
      return { count: countOf(findCount(tenantId, id)), lines: items.length };
    });
  }

  /**
   * Zet de regels van een telling om naar de API-vorm en rekent de verschillen uit ten opzichte van de stand op het telmoment (voor een
   * lopende telling live uit de mutaties sinds het bevriezen; voor een afgesloten telling zoals bewaard).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} countRow De telling.
   * @param {object[]} rows De regels uit de database.
   * @param {{ amount: number, pct: number }} threshold De drempel voor hertellen.
   * @returns {object[]} De regels met verschil, waarde en of ze herteld moeten worden.
   */
  function computeLines(tenantId, countRow, rows, threshold) {
    const closed = countRow.status !== 'tellen';
    const movedByItem = new Map();
    if (!closed && rows.some((row) => row.counted_at)) {
      const moves = prepare(`SELECT item_id, qty, created_at FROM stock_movements WHERE tenant_id = ? AND created_at > ?
        AND item_id IN (SELECT item_id FROM stock_count_lines WHERE tenant_id = ? AND count_id = ?)`).all(tenantId, countRow.frozen_at, tenantId, countRow.id);
      for (const move of moves) {
        if (!movedByItem.has(move.item_id)) movedByItem.set(move.item_id, []);
        movedByItem.get(move.item_id).push(move);
      }
    }
    return rows.map((row) => {
      const counted = row.counted_qty == null ? null : round3(row.counted_qty);
      let expectedAtCount = null;
      let movedSince = null;
      let difference = null;
      if (closed) {
        expectedAtCount = row.expected_at_count == null ? null : round3(row.expected_at_count);
        movedSince = row.moved_since == null ? null : round3(row.moved_since);
        difference = row.difference == null ? null : round3(row.difference);
      } else if (counted != null && row.counted_at) {
        movedSince = round3((movedByItem.get(row.item_id) || []).filter((move) => move.created_at <= row.counted_at).reduce((sum, move) => sum + Number(move.qty), 0));
        expectedAtCount = round3(Number(row.expected_qty) + movedSince);
        difference = round3(counted - expectedAtCount);
      }
      const unitCost = row.unit_cost == null ? null : Number(row.unit_cost);
      const line = {
        id: row.id, itemId: row.item_id, code: row.code, name: row.name, unit: row.unit, ean: row.ean, location: row.location,
        expectedQty: round3(row.expected_qty), unitCost, costSource: row.cost_source, countedQty: counted, countedAt: row.counted_at, countedBy: row.counted_by_name,
        status: row.status, resolution: row.resolution, expectedAtCount, movedSince, difference,
        differenceValue: difference == null || unitCost == null ? 0 : round2(difference * unitCost),
        valueCounted: counted == null || unitCost == null ? 0 : round2(counted * unitCost),
        valueBefore: unitCost == null ? 0 : round2(Number(row.expected_qty) * unitCost), movementId: row.movement_id,
      };
      line.recountNeeded = !closed && difference != null && exceedsThreshold({ difference, differenceValue: line.differenceValue, expectedAtCount }, threshold);
      return line;
    });
  }

  /**
   * Leest alle regels van een telling.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} countId Id van de telling.
   * @param {string|null} [location] Alleen deze locatie (leeg = "geen locatie"); null = alle.
   * @returns {object[]} De regels uit de database.
   */
  function lineRows(tenantId, countId, location = null) {
    if (location === null) return prepare(`SELECT ${LINE_COLS} FROM stock_count_lines WHERE tenant_id = ? AND count_id = ? ORDER BY location, code`).all(tenantId, countId);
    return prepare(`SELECT ${LINE_COLS} FROM stock_count_lines WHERE tenant_id = ? AND count_id = ? AND location = ? ORDER BY code`).all(tenantId, countId, location);
  }

  /**
   * Telt de regels per locatie: aantal, geteld en te hertellen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} countId Id van de telling.
   * @returns {{ location: string, total: number, counted: number, recount: number }[]} Per locatie de voortgang, in natuurlijke volgorde.
   */
  function locations(tenantId, countId) {
    return prepare(`SELECT location, COUNT(*) AS total, SUM(CASE WHEN status = 'geteld' THEN 1 ELSE 0 END) AS counted,
        SUM(CASE WHEN status = 'hertellen' THEN 1 ELSE 0 END) AS recount
      FROM stock_count_lines WHERE tenant_id = ? AND count_id = ? GROUP BY location`).all(tenantId, countId)
      .map((row) => ({ location: row.location, total: Number(row.total), counted: Number(row.counted), recount: Number(row.recount) }))
      .sort((left, right) => byLocation(left.location, right.location));
  }

  /**
   * Totalen van een telling: voortgang, voorraadwaarde vóór en na de telling en het verschil, aantallen zonder prijs.
   * @param {object[]} lines De regels met verschil (computeLines).
   * @returns {object} De samenvatting.
   */
  function totalsOf(lines) {
    const totals = { lines: lines.length, counted: 0, open: 0, recount: 0, withDifference: 0, recountNeeded: 0, valueBefore: 0, valueCounted: 0, differenceValue: 0, noCostLines: 0, noCostWithStock: 0 };
    for (const line of lines) {
      if (line.status === 'geteld') totals.counted += 1; else if (line.status === 'hertellen') totals.recount += 1; else totals.open += 1;
      if (line.difference) totals.withDifference += 1;
      if (line.recountNeeded) totals.recountNeeded += 1;
      totals.valueBefore += line.valueBefore;
      if (line.countedQty != null) { totals.valueCounted += line.valueCounted; totals.differenceValue += line.differenceValue; }
      if (line.unitCost == null) {
        totals.noCostLines += 1;
        if ((line.countedQty != null ? line.countedQty : line.expectedQty) > 0) totals.noCostWithStock += 1;
      }
    }
    totals.valueBefore = round2(totals.valueBefore);
    totals.valueCounted = round2(totals.valueCounted);
    totals.differenceValue = round2(totals.differenceValue);
    return totals;
  }

  /**
   * De telling met voortgang per locatie en totalen (voor de beheerder).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @returns {object|null} De telling met `locationsProgress` en `totals`, of null.
   */
  function get(tenantId, id) {
    const row = findCount(tenantId, id);
    if (!row) return null;
    const count = countOf(row);
    const lines = computeLines(tenantId, row, lineRows(tenantId, row.id), count.threshold);
    return { ...count, progress: locations(tenantId, row.id), totals: row.status === 'afgesloten' && count.summary.totals ? count.summary.totals : totalsOf(lines) };
  }

  /**
   * De regels van een telling voor de beheerder (met verwachte aantallen, verschillen en waarden), met filter en paginering.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @param {{ location?: string, filter?: string, limit?: number, offset?: number }} [options] Locatie, filter (alle|open|verschillen|hertellen) en pagina.
   * @returns {{ lines: object[], total: number }|null} De regels en het totaal na filteren, of null.
   */
  function lines(tenantId, id, { location, filter = 'alle', limit = PAGE_SIZE, offset = 0 } = {}) {
    const row = findCount(tenantId, id);
    if (!row) return null;
    const threshold = countOf(row).threshold;
    let result = computeLines(tenantId, row, lineRows(tenantId, row.id, location === undefined ? null : String(location)), threshold);
    if (filter === 'open') result = result.filter((line) => line.status === 'open');
    else if (filter === 'verschillen') result = result.filter((line) => line.difference);
    else if (filter === 'hertellen') result = result.filter((line) => line.status === 'hertellen' || line.recountNeeded);
    result.sort((left, right) => byLocation(left.location, right.location) || left.code.localeCompare(right.code, 'nl', { numeric: true }));
    const size = Math.min(Math.max(1, Number(limit) || PAGE_SIZE), MAX_PAGE_SIZE);
    const start = Math.max(0, Number(offset) || 0);
    return { lines: result.slice(start, start + size), total: result.length };
  }

  /**
   * De open telling voor de tellers: nummer, peildatum en de locaties met voortgang (zonder aantallen of prijzen).
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ id: string, number: string, referenceDate: string, locations: object[] }|null} De open telling of null.
   */
  function openCount(tenantId) {
    const row = prepare("SELECT id, number, reference_date FROM stock_counts WHERE tenant_id = ? AND status = 'tellen'").get(tenantId);
    if (!row) return null;
    return { id: row.id, number: row.number, referenceDate: row.reference_date, locations: locations(tenantId, row.id) };
  }

  /**
   * Een regel zoals de teller hem ziet: zonder verwacht aantal en zonder prijs; een regel die herteld moet worden toont het eerdere aantal niet.
   * @param {object} row De regel uit de database.
   * @returns {object} De blinde regel.
   */
  function blindOf(row) {
    return {
      id: row.id, code: row.code, name: row.name, unit: row.unit, ean: row.ean, location: row.location, status: row.status,
      countedQty: row.status === 'geteld' && row.counted_qty != null ? round3(row.counted_qty) : null,
    };
  }

  /**
   * De regels van één locatie voor de tellers (blind), van een lopende telling.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @param {string} location De locatie (leeg = "geen locatie").
   * @returns {{ lines: object[] }|{ error: string, code: string, status: number }} De regels of een fout.
   */
  function blindLines(tenantId, id, location) {
    const row = findCount(tenantId, id);
    if (!row) return { error: 'Telling niet gevonden.', code: 'not_found', status: 404 };
    if (row.status !== 'tellen') return { error: 'Deze telling loopt niet meer.', code: 'closed', status: 409 };
    return { lines: lineRows(tenantId, row.id, cleanText(location, 60)).map(blindOf) };
  }

  /**
   * Legt een getelde hoeveelheid vast. Dezelfde `clientId` boekt nooit twee keer (herhaalde tik of oude wachtrij); een regel mag opnieuw geteld
   * worden, de laatste telling geldt en elke ingave blijft bewaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @param {string} lineId Id van de regel.
   * @param {{ qty?: number, clientId?: string, countedAt?: string }} body De ingave (met optioneel het tijdstip waarop de teller telde).
   * @param {object} user De teller.
   * @returns {{ line: object, repeated?: boolean }|{ error: string, code: string, status: number }} De blinde regel of een fout.
   */
  function record(tenantId, id, lineId, body, user) {
    const input = body && typeof body === 'object' ? body : {};
    if (typeof input.qty !== 'number' || !Number.isFinite(input.qty) || input.qty < 0 || input.qty > MAX_QTY) return { error: 'Vul het getelde aantal in (0 of meer).', code: 'invalid', status: 400 };
    const clientId = cleanText(input.clientId, 64);
    if (clientId.length < 8) return { error: 'Een ingave heeft een eigen sleutel nodig.', code: 'invalid', status: 400 };
    const qty = round3(input.qty);
    try {
      return transaction(db, () => {
        const row = findCount(tenantId, id);
        if (!row) return { error: 'Telling niet gevonden.', code: 'not_found', status: 404 };
        const line = prepare(`SELECT ${LINE_COLS} FROM stock_count_lines WHERE tenant_id = ? AND count_id = ? AND id = ?`).get(tenantId, row.id, String(lineId || ''));
        if (!line) return { error: 'Regel niet gevonden.', code: 'not_found', status: 404 };
        const earlier = prepare('SELECT line_id FROM stock_count_entries WHERE tenant_id = ? AND client_id = ?').get(tenantId, clientId);
        if (earlier) {
          if (earlier.line_id !== line.id) return { error: 'Deze ingave hoort bij een andere regel.', code: 'client_id_used', status: 409 };
          return { line: blindOf(line), repeated: true };
        }
        if (row.status !== 'tellen') return { error: 'Deze telling loopt niet meer.', code: 'closed', status: 409 };
        const now = new Date().toISOString();
        const countedAt = countMoment(input.countedAt, row.frozen_at, now);
        const userName = user ? cleanText(user.display_name || user.displayName, 120) : '';
        prepare('INSERT INTO stock_count_entries (id, tenant_id, count_id, line_id, client_id, qty, counted_at, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), tenantId, row.id, line.id, clientId, qty, countedAt, user ? user.id : null, userName);
        prepare("UPDATE stock_count_lines SET counted_qty = ?, counted_at = ?, counted_by = ?, counted_by_name = ?, status = 'geteld' WHERE tenant_id = ? AND id = ?")
          .run(qty, countedAt, user ? user.id : null, userName, tenantId, line.id);
        return { line: blindOf({ ...line, counted_qty: qty, status: 'geteld' }) };
      });
    } catch (error) {
      if (error && error.code === '23505') return { error: 'Deze ingave is al verwerkt.', code: 'client_id_used', status: 409 };
      throw error;
    }
  }

  /**
   * Zet regels terug naar "hertellen": de opgegeven regels, of alle regels boven de drempel. De teller ziet het eerdere aantal dan niet meer.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @param {{ lineIds?: string[], overThreshold?: boolean }} body Welke regels.
   * @returns {{ marked: number }|{ error: string, code: string, status: number }} Het aantal gemarkeerde regels of een fout.
   */
  function requestRecount(tenantId, id, body) {
    const input = body && typeof body === 'object' ? body : {};
    return transaction(db, () => {
      const row = findCount(tenantId, id);
      if (!row) return { error: 'Telling niet gevonden.', code: 'not_found', status: 404 };
      if (row.status !== 'tellen') return { error: 'Deze telling loopt niet meer.', code: 'closed', status: 409 };
      const rows = lineRows(tenantId, row.id).filter((line) => line.status === 'geteld');
      let chosen = [];
      if (input.overThreshold === true) {
        chosen = computeLines(tenantId, row, rows, countOf(row).threshold).filter((line) => line.recountNeeded).map((line) => line.id);
      } else if (Array.isArray(input.lineIds) && input.lineIds.length) {
        const wanted = new Set(input.lineIds.map(String));
        chosen = rows.filter((line) => wanted.has(line.id)).map((line) => line.id);
      } else {
        return { error: 'Kies regels of de regels boven de drempel.', code: 'invalid', status: 400 };
      }
      const update = prepare("UPDATE stock_count_lines SET status = 'hertellen' WHERE tenant_id = ? AND count_id = ? AND id = ? AND status = 'geteld'");
      for (const lineId of chosen) update.run(tenantId, row.id, lineId);
      return { marked: chosen.length };
    });
  }

  /**
   * Sluit een telling af: valideert eerst alles, rekent de verschillen uit ten opzichte van de stand op het telmoment, boekt ze als
   * `telling`-mutaties en vergrendelt de telling. Alles of niets in één transactie. Regels die niet geteld zijn vragen een expliciete keuze
   * (`open`: `nul` of `ongewijzigd`); regels die nog herteld moeten worden vragen `acceptRecounts: true` (het eerdere aantal geldt dan).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @param {object} user De beheerder.
   * @param {{ open?: string, acceptRecounts?: boolean }} body De keuzes.
   * @returns {{ count: object }|{ error: string, code: string, status: number, details?: object }} De afgesloten telling of een fout.
   */
  function close(tenantId, id, user, body) {
    const input = body && typeof body === 'object' ? body : {};
    return transaction(db, () => {
      const row = findCount(tenantId, id);
      if (!row) return { error: 'Telling niet gevonden.', code: 'not_found', status: 404 };
      if (row.status !== 'tellen') return { error: 'Deze telling is al afgesloten of geannuleerd.', code: 'closed', status: 409 };
      const count = countOf(row);
      const computed = computeLines(tenantId, row, lineRows(tenantId, row.id), count.threshold);
      const untouched = computed.filter((line) => line.countedQty == null);
      const pendingRecount = computed.filter((line) => line.status === 'hertellen');
      if (untouched.length && !['nul', 'ongewijzigd'].includes(input.open)) {
        return { error: `${untouched.length} regels zijn niet geteld: kies of ze als 0 tellen of ongewijzigd blijven.`, code: 'open_lines', status: 409, details: { open: untouched.length } };
      }
      if (pendingRecount.length && input.acceptRecounts !== true) {
        return { error: `${pendingRecount.length} regels moeten nog worden herteld: tel ze opnieuw of accepteer het eerdere aantal.`, code: 'recount_open', status: 409, details: { recount: pendingRecount.length } };
      }
      const now = new Date().toISOString();
      const note = `Voorraadtelling ${row.number} (peildatum ${row.reference_date})`;
      // Mutaties sinds het bevriezen per artikel in één query (alleen nodig voor regels die niet geteld zijn).
      const movedSinceFreeze = new Map();
      if (untouched.length) {
        for (const moved of prepare(`SELECT item_id, SUM(qty) AS qty FROM stock_movements WHERE tenant_id = ? AND created_at > ?
          AND item_id IN (SELECT item_id FROM stock_count_lines WHERE tenant_id = ? AND count_id = ? AND counted_qty IS NULL) GROUP BY item_id`).all(tenantId, row.frozen_at, tenantId, row.id)) {
          movedSinceFreeze.set(moved.item_id, round3(moved.qty));
        }
      }
      const resolvedAll = [];
      for (const line of computed) {
        let counted = line.countedQty;
        let resolution = 'geteld';
        let expectedAtCount = line.expectedAtCount;
        let movedSince = line.movedSince;
        let difference = line.difference;
        if (counted == null) {
          // Niet geteld: de stand op dit moment is het uitgangspunt (verwacht + alle mutaties sinds het bevriezen).
          const sinceFreeze = movedSinceFreeze.get(line.itemId) || 0;
          movedSince = sinceFreeze;
          expectedAtCount = round3(line.expectedQty + sinceFreeze);
          if (input.open === 'nul') { counted = 0; resolution = 'nul'; difference = round3(0 - expectedAtCount); } else { counted = expectedAtCount; resolution = 'ongewijzigd'; difference = 0; }
        }
        resolvedAll.push({ line, counted, resolution, expectedAtCount, movedSince, difference });
      }
      const update = prepare(`UPDATE stock_count_lines SET counted_qty = ?, resolution = ?, expected_at_count = ?, moved_since = ?, difference = ?, movement_id = ?
        WHERE tenant_id = ? AND id = ?`);
      let booked = 0;
      let bookedValue = 0;
      for (const entry of resolvedAll) {
        let movementId = null;
        if (entry.difference) {
          movementId = stock.book(tenantId, entry.line.itemId, entry.difference, {
            kind: 'telling', source: `telling:${row.number}`, note, user, at: now, unitCost: entry.difference > 0 && entry.line.unitCost != null ? entry.line.unitCost : undefined,
          });
          booked += 1;
          bookedValue += entry.line.unitCost == null ? 0 : entry.difference * entry.line.unitCost;
        }
        update.run(entry.counted, entry.resolution, entry.expectedAtCount, entry.movedSince, entry.difference, movementId, tenantId, entry.line.id);
      }
      const finalLines = computeLines(tenantId, { ...row, status: 'afgesloten' }, lineRows(tenantId, row.id), count.threshold);
      const totals = { ...totalsOf(finalLines), booked, bookedValue: round2(bookedValue) };
      const valueAfter = stock.stockValue(tenantId);
      const summary = { totals, stockValueAfter: valueAfter, closedWith: { open: input.open || null, acceptRecounts: input.acceptRecounts === true } };
      const closed = prepare("UPDATE stock_counts SET status = 'afgesloten', closed_at = ?, closed_by = ?, closed_by_name = ?, summary = ? WHERE tenant_id = ? AND id = ? AND status = 'tellen'")
        .run(now, user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', JSON.stringify(summary), tenantId, row.id);
      if (!closed.changes) throw Object.assign(new Error('De telling is intussen gewijzigd.'), { code: 'count_changed' });
      return { count: get(tenantId, row.id), booked };
    });
  }

  /**
   * Annuleert een lopende telling (er wordt niets geboekt; de regels en ingaven blijven bewaard).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @returns {{ count: object }|{ error: string, code: string, status: number }} De telling of een fout.
   */
  function cancel(tenantId, id) {
    const changed = prepare("UPDATE stock_counts SET status = 'geannuleerd' WHERE tenant_id = ? AND id = ? AND status = 'tellen'").run(tenantId, String(id || ''));
    if (!changed.changes) {
      return findCount(tenantId, id) ? { error: 'Deze telling loopt niet meer.', code: 'closed', status: 409 } : { error: 'Telling niet gevonden.', code: 'not_found', status: 404 };
    }
    return { count: get(tenantId, id) };
  }

  /**
   * Alle gegevens voor het verslag (Excel en pdf): de telling, alle regels met verschil en waarde en het logboek van alle ingaven.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de telling.
   * @returns {{ count: object, lines: object[], entries: object[] }|null} Het verslag of null.
   */
  function report(tenantId, id) {
    const row = findCount(tenantId, id);
    if (!row) return null;
    const count = get(tenantId, id);
    const result = lines(tenantId, id, { limit: MAX_PAGE_SIZE * 10 });
    const entries = prepare(`SELECT e.line_id, l.code, l.location, e.qty, e.counted_at, e.user_name FROM stock_count_entries e
        JOIN stock_count_lines l ON l.tenant_id = e.tenant_id AND l.id = e.line_id
      WHERE e.tenant_id = ? AND e.count_id = ? ORDER BY e.counted_at, e.id`).all(tenantId, row.id)
      .map((entry) => ({ lineId: entry.line_id, code: entry.code, location: entry.location, qty: round3(entry.qty), countedAt: entry.counted_at, countedBy: entry.user_name }));
    return { count, lines: result.lines, entries };
  }

  return { list, start, get, lines, openCount, blindLines, record, requestRecount, close, cancel, report };
}

/**
 * Hangt de routes van de voorraadtelling aan de app. Beheer onder /api/stock-counts (recht `voorraad`); tellen onder /api/orderpick/counts
 * (de poort voor het recht `orderpick` staat al op /api/orderpick) en altijd blind.
 * @param {object} app De Express-app.
 * @param {{ counts: object, getUser: Function, requireRight: Function, requireJson: Function, audit: Function }} deps De opslag, het opzoeken van een account (voor het wachtwoord), de rechtencontrole, de JSON-controle en het auditlogboek.
 * @returns {void}
 */
function registerStockCountRoutes(app, { counts, getUser, requireRight, requireJson, audit }) {
  const requireStock = requireRight('voorraad');
  /**
   * Stuurt de uitkomst van de opslag als antwoord: een fout met status en melding, anders de gegevens.
   * @param {object} res Het Express-antwoord.
   * @param {object} out De uitkomst (met `error`, `code`, `status` bij een fout).
   * @param {number} [status] De status bij succes.
   * @returns {object} Het antwoord.
   */
  const send = (res, out, status = 200) => (out.error ? res.status(out.status || 400).json({ error: out.code || 'invalid', message: out.error, ...(out.details || {}) }) : res.status(status).json(out));
  const countLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 600, keyFn: (req) => `telling-ingave:${req.tenantId}:${req.user && req.user.id}` });
  const changeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60, keyFn: (req) => `telling-wijzigen:${req.tenantId}:${req.user && req.user.id}` });
  const closeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyFn: (req) => `telling-afsluiten:${req.tenantId}:${req.user && req.user.id}` });
  /**
   * Zet de kop die caching van tellingen voorkomt.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  app.use('/api/stock-counts', express.json({ limit: '16kb' }), noStore);

  app.get('/api/stock-counts', requireStock, (req, res) => {
    res.json({ counts: counts.list(req.tenantId) });
  });

  app.post('/api/stock-counts', requireJson, requireStock, changeLimiter, (req, res) => {
    const out = counts.start(req.tenantId, req.user, req.body);
    if (out.error) return send(res, out);
    audit(req, 'voorraadtelling_gestart', { number: out.count.number, kind: out.count.kind, referenceDate: out.count.referenceDate, lines: out.lines });
    res.status(201).json({ count: counts.get(req.tenantId, out.count.id) });
  });

  app.get('/api/stock-counts/:id', requireStock, (req, res) => {
    const count = counts.get(req.tenantId, req.params.id);
    if (!count) return res.status(404).json({ error: 'not_found', message: 'Telling niet gevonden.' });
    res.json({ count });
  });

  app.get('/api/stock-counts/:id/lines', requireStock, (req, res) => {
    const out = counts.lines(req.tenantId, req.params.id, {
      location: typeof req.query.location === 'string' ? req.query.location.slice(0, 60) : undefined,
      filter: String(req.query.filter || 'alle'), limit: req.query.limit, offset: req.query.offset,
    });
    if (!out) return res.status(404).json({ error: 'not_found', message: 'Telling niet gevonden.' });
    res.json(out);
  });

  app.get('/api/stock-counts/:id/report', requireStock, (req, res) => {
    const out = counts.report(req.tenantId, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found', message: 'Telling niet gevonden.' });
    audit(req, 'voorraadtelling_verslag', { number: out.count.number });
    res.json(out);
  });

  app.post('/api/stock-counts/:id/recount', requireJson, requireStock, changeLimiter, (req, res) => {
    const out = counts.requestRecount(req.tenantId, req.params.id, req.body);
    if (out.error) return send(res, out);
    audit(req, 'voorraadtelling_hertellen', { id: req.params.id, marked: out.marked });
    res.json(out);
  });

  app.post('/api/stock-counts/:id/close', requireJson, requireStock, closeLimiter, async (req, res, next) => {
    try {
      const account = getUser(req.user.id);
      const password = String(req.body && req.body.password !== undefined ? req.body.password : '').slice(0, 200);
      if (!account || !account.password_hash || !(await verifyPassword(password, account.password_hash))) {
        audit(req, 'voorraadtelling_wachtwoord_fout', { id: req.params.id });
        return res.status(401).json({ error: 'wrong_password', message: 'Je wachtwoord klopt niet.' });
      }
      const out = counts.close(req.tenantId, req.params.id, req.user, req.body);
      if (out.error) return send(res, out);
      audit(req, 'voorraadtelling_afgesloten', { number: out.count.number, referenceDate: out.count.referenceDate, booked: out.booked, totals: out.count.totals });
      res.json({ count: out.count, booked: out.booked });
    } catch (error) {
      if (error && (error.code === 'count_changed' || error.code === 'item_missing')) {
        return res.status(409).json({ error: error.code, message: 'De telling of een artikel is intussen gewijzigd; er is niets geboekt. Laad de telling opnieuw en probeer het nog eens.' });
      }
      next(error);
    }
  });

  app.post('/api/stock-counts/:id/cancel', requireJson, requireStock, changeLimiter, (req, res) => {
    const out = counts.cancel(req.tenantId, req.params.id);
    if (out.error) return send(res, out);
    audit(req, 'voorraadtelling_geannuleerd', { number: out.count.number });
    res.json(out);
  });

  // Tellers (recht orderpick): blind, zonder verwachte aantallen of prijzen.
  app.get('/api/orderpick/counts/open', (req, res) => {
    res.json({ count: counts.openCount(req.tenantId) });
  });

  app.get('/api/orderpick/counts/:id/lines', (req, res) => {
    send(res, counts.blindLines(req.tenantId, req.params.id, req.query.location));
  });

  app.post('/api/orderpick/counts/:id/lines/:lineId/count', requireJson, countLimiter, (req, res) => {
    const out = counts.record(req.tenantId, req.params.id, req.params.lineId, req.body, req.user);
    if (out.error) return send(res, out);
    if (!out.repeated) audit(req, 'voorraadtelling_ingave', { id: req.params.id, lineId: req.params.lineId });
    res.json(out);
  });
}

module.exports = { createStockCounts, registerStockCountRoutes, sanitizeThreshold, exceedsThreshold, DEFAULT_THRESHOLD };
