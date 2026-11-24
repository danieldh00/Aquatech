// Gedeelde kern van het importeren uit Excel (klanten, artikelen, prijslijst van de leverancier): het Excel-bestand wordt in
// de browser gelezen en komt als kopregel + rijen met gewone waarden naar de server. Hier staat wat alle imports delen:
// de tabel saneren (grenzen), kolomkoppen herkennen (ook zonder hoofdletters, accenten en leestekens, met synoniemen),
// getallen in Nederlandse notatie lezen en de uitkomst per rij samenvatten.

/** Hoeveel rijen een import hoogstens bevat. */
const MAX_ROWS = 1000;
/** Hoeveel kolommen een import hoogstens bevat. */
const MAX_COLUMNS = 40;
/** Hoeveel tekens een cel hoogstens telt. */
const MAX_CELL_LENGTH = 1000;

/**
 * Maakt van een kolomkop een vergelijkbare sleutel: kleine letters, zonder accenten, spaties en leestekens.
 * @param {*} text De kop uit het bestand.
 * @returns {string} Bijv. "E-mailadres" wordt "emailadres".
 */
function normalizeHeader(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Zet een cel om naar nette tekst: getallen zonder staart, tekst ingekort en zonder regeleinden aan de randen.
 * @param {*} value De celwaarde (tekst, getal, waar/onwaar of leeg).
 * @returns {string} De tekst (leeg bij niets).
 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'ja' : 'nee';
  return String(value).replace(/\r/g, '').trim().slice(0, MAX_CELL_LENGTH);
}

/**
 * Leest een getal in Nederlandse of internationale notatie: "12,5", "1.234,56", "€ 12,50", "1,234.56" of een echt getal.
 * @param {*} value De celwaarde.
 * @returns {number|null|undefined} Het getal, null bij een lege cel en undefined als het geen getal is.
 */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = cellText(value).replace(/[€\s]/g, '').replace(/^\+/, '');
  if (!text) return null;
  if (!/^-?[0-9.,]+$/.test(text)) return undefined;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let normalized = text;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = /^-?\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, '');
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Leest een ja/nee-cel.
 * @param {*} value De celwaarde.
 * @returns {boolean|null|undefined} true, false, null bij een lege cel en undefined als het geen ja/nee is.
 */
function parseYesNo(value) {
  const text = cellText(value).toLowerCase();
  if (!text) return null;
  if (['ja', 'j', 'yes', 'y', 'true', 'waar', '1', 'x'].includes(text)) return true;
  if (['nee', 'n', 'no', 'false', 'onwaar', '0'].includes(text)) return false;
  return undefined;
}

/**
 * Controleert de ruwe tabel uit het verzoek en begrenst hem.
 * @param {*} body Het verzoek: { headers: string[], rows: any[][] }.
 * @returns {{ headers: string[], rows: any[][] }|{ error: string }} De tabel, of een melding.
 */
function cleanTable(body) {
  const headers = body && body.headers;
  const rows = body && body.rows;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return { error: 'Het bestand kon niet worden gelezen.' };
  if (!headers.length || headers.length > MAX_COLUMNS) return { error: `Een bestand heeft 1 tot ${MAX_COLUMNS} kolommen.` };
  if (rows.length > MAX_ROWS) return { error: `Hoogstens ${MAX_ROWS} regels per keer; splits het bestand.` };
  /**
   * Maakt één rij schoon: hoogstens zoveel cellen als kolommen, tekst ingekort.
   * @param {*} row De rij.
   * @returns {any[]} De gesaneerde rij.
   */
  const cleanRow = (row) => (Array.isArray(row) ? row.slice(0, headers.length).map((cell) => (typeof cell === 'number' || typeof cell === 'boolean' ? cell : cellText(cell))) : []);
  return { headers: headers.map(cellText), rows: rows.map(cleanRow) };
}

/**
 * Koppelt de kolomkoppen van het bestand aan de velden van de import.
 * @param {string[]} headers De koppen uit het bestand.
 * @param {{ key: string, label: string, aliases?: string[], required?: boolean }[]} fields De velden van de import.
 * @returns {{ columns: Object<string, number>, unknown: string[], missing: string[] }} Veld → kolomnummer, de koppen die niemand herkent en de verplichte velden zonder kolom.
 */
function mapColumns(headers, fields) {
  const byName = new Map();
  for (const field of fields) {
    for (const name of [field.label, field.key, ...(field.aliases || [])]) byName.set(normalizeHeader(name), field.key);
  }
  const columns = {};
  const unknown = [];
  headers.forEach((header, index) => {
    if (!normalizeHeader(header)) return;
    const key = byName.get(normalizeHeader(header));
    if (key && columns[key] === undefined) columns[key] = index;
    else unknown.push(header);
  });
  const missing = fields.filter((field) => field.required && columns[field.key] === undefined).map((field) => field.label);
  return { columns, unknown, missing };
}

/**
 * Zet de tabel om naar rijen met waarden per veld; lege rijen vallen weg.
 * @param {{ headers: string[], rows: any[][] }} table De gesaneerde tabel.
 * @param {Object<string, number>} columns Veld → kolomnummer (mapColumns).
 * @returns {{ line: number, values: Object<string, *> }[]} De rijen; `line` is het regelnummer in Excel (kopregel = 1).
 */
function tableRows(table, columns) {
  const out = [];
  table.rows.forEach((row, index) => {
    const values = {};
    let filled = false;
    for (const [key, column] of Object.entries(columns)) {
      const value = row[column] === undefined ? '' : row[column];
      values[key] = value;
      if (cellText(value)) filled = true;
    }
    if (filled) out.push({ line: index + 2, values });
  });
  return out;
}

/**
 * Telt de uitkomsten per status.
 * @param {{ status: string }[]} results De uitkomst per rij.
 * @returns {{ nieuw: number, wijzigt: number, ongewijzigd: number, fout: number }} De aantallen.
 */
function countStatuses(results) {
  const counts = { nieuw: 0, wijzigt: 0, ongewijzigd: 0, fout: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}

/**
 * Leest de tabel uit een verzoek en koppelt de kolommen; geeft de rijen of een foutmelding voor het antwoord.
 * @param {*} body Het verzoek.
 * @param {{ key: string, label: string, aliases?: string[], required?: boolean }[]} fields De velden van de import.
 * @returns {{ rows: object[], unknown: string[], columns: Object<string, number> }|{ error: string }} Het resultaat.
 */
function readTable(body, fields) {
  const table = cleanTable(body);
  if (table.error) return table;
  const mapped = mapColumns(table.headers, fields);
  if (mapped.missing.length) return { error: `Kolom ontbreekt: ${mapped.missing.join(', ')}. Gebruik het voorbeeldbestand als begin.` };
  const rows = tableRows(table, mapped.columns);
  if (!rows.length) return { error: 'Het bestand bevat geen regels met gegevens.' };
  return { rows, unknown: mapped.unknown, columns: mapped.columns };
}

module.exports = { MAX_ROWS, normalizeHeader, cellText, parseNumber, parseYesNo, cleanTable, mapColumns, tableRows, countStatuses, readTable };
