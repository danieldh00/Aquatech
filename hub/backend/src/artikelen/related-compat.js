// Vaste regels voor "past bij": welke artikelen op elkaar aansluiten, op basis van opgezochte specificaties (zie related-research.js).
//
// De AI leest alleen specificaties uit een bron (met webadres en letterlijke zin). Of twee artikelen bij elkaar passen bepaalt
// deze code met vaste regels, zodat de reden controleerbaar is en niet op een inschatting berust:
// - draadaansluitingen passen als de maat gelijk is en de een binnendraad en de ander buitendraad heeft;
// - buis- en slangaansluitingen passen als de maat gelijk is;
// - de werkdrukken (als beide bekend zijn) moeten overlappen;
// - twee artikelen met dezelfde functie (twee sproeikoppen) passen niet "bij" elkaar.
// Ontbreekt een gegeven (geen aansluiting, geen bron), dan is er geen koppeling: er wordt nooit geraden.

/** Soorten aansluiting. */
const KINDS = ['draad', 'buis', 'slang'];
/** Geslacht van een draadaansluiting. */
const GENDERS = ['binnen', 'buiten', 'geen'];
/** Hoeveel bronnen een koppeling hoogstens meekrijgt. */
const MAX_EVIDENCE = 4;

/**
 * Brengt een maataanduiding naar één vaste schrijfwijze: 3/4" voor inch, 25mm voor millimeter.
 * @param {*} value De maat zoals in de bron ("3/4 inch", 'G3/4', 'R 3/4"', "Ø 25 mm", "25mm").
 * @returns {string} De vaste schrijfwijze, of leeg als de maat niet te lezen is.
 */
function normalizeSize(value) {
  const text = String(value || '').toLowerCase().replace(/[“”″']/g, '"').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const millimeters = text.match(/^(?:ø|⌀|dn)?\s*(\d{1,3}(?:[.,]\d)?)\s*mm$/);
  if (millimeters) return `${Number(millimeters[1].replace(',', '.'))}mm`;
  const inch = text.match(/^(?:g|r|rp|rc|bsp|npt|bspp)?\s*(\d{1,2}\/\d{1,2}|\d{1,2}(?:\s\d\/\d)?|\d{1,2}[.,]\d)\s*(?:"|inch|inches|duim|in)?$/);
  if (inch && (/["]|inch|duim|in\b/.test(text) || /^(g|r|rp|rc|bsp|npt|bspp)/.test(text) || inch[1].includes('/'))) return `${inch[1].replace(/\s+/g, ' ').replace(',', '.')}"`;
  return '';
}

/**
 * Het getal of de breuk uit een vaste maat ("3/4" of "25"), om een bronzin mee te controleren.
 * @param {string} size Een maat uit normalizeSize.
 * @returns {string} Het deel dat in de bronzin moet staan.
 */
const sizeNumber = (size) => String(size).replace(/mm$|"$/, '');

/**
 * Controleert of een bronzin de maat echt noemt (tegen verzonnen maten).
 * @param {string} quote De letterlijke zin uit de bron.
 * @param {string} size Een maat uit normalizeSize.
 * @returns {boolean} true als de zin de maat bevat.
 */
function quoteSupportsSize(quote, size) {
  const text = String(quote || '').toLowerCase().replace(/¾/g, '3/4').replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/,/g, '.');
  const number = sizeNumber(size).toLowerCase();
  if (!number) return false;
  return new RegExp(`(^|[^0-9/.])${number.replace(/[./]/g, '\\$&')}($|[^0-9/])`).test(text);
}

/**
 * Een getal of null.
 * @param {*} value De waarde.
 * @returns {?number} Het getal, of null als het geen eindig getal is.
 */
const numberOrNull = (value) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * Een bereik {min, max} of null.
 * @param {*} value Het bereik uit de AI.
 * @param {number} limit Het hoogste getal dat redelijk is.
 * @returns {?{ min: number, max: number }} Het bereik, of null bij onbruikbare waarden.
 */
function rangeOf(value, limit) {
  if (!value || typeof value !== 'object') return null;
  const min = numberOrNull(value.min);
  const max = numberOrNull(value.max);
  if (min === null || max === null || min < 0 || max < min || max > limit) return null;
  return { min, max };
}

/**
 * Controleert en schoont de specificaties die de AI uit een bron las. Alleen wat met een bron (adres uit de zoekresultaten en een zin die het
 * getal bevat) is onderbouwd, blijft over; de rest vervalt.
 * @param {object} raw Het JSON-antwoord van de AI.
 * @param {Set<string>} allowedUrls De adressen die de zoekopdracht echt teruggaf.
 * @returns {{ role: string, connections: object[], pressureBar: ?object, flowLh: ?object, evidence: object[] }|null} De specificaties, of null als er niets onderbouwds is.
 */
function validateSpecs(raw, allowedUrls) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .map((entry) => ({ field: String((entry && entry.field) || '').slice(0, 40), url: String((entry && entry.url) || '').slice(0, 500), quote: String((entry && entry.quote) || '').replace(/\s+/g, ' ').trim().slice(0, 300) }))
    .filter((entry) => entry.field && entry.quote && /^https:\/\//.test(entry.url) && allowedUrls.has(entry.url));
  const connectionEvidence = evidence.filter((entry) => entry.field === 'aansluiting');
  const connections = (Array.isArray(source.connections) ? source.connections : []).map((connection) => {
    const kind = KINDS.includes(connection && connection.kind) ? connection.kind : '';
    const size = normalizeSize(connection && connection.size);
    const gender = GENDERS.includes(connection && connection.gender) ? connection.gender : kind === 'draad' ? '' : 'geen';
    return { kind, size, gender };
  }).filter((connection) => connection.kind && connection.size && connection.gender
    && (connection.kind !== 'draad' || connection.gender !== 'geen')
    && connectionEvidence.some((entry) => quoteSupportsSize(entry.quote, connection.size)));
  const pressureBar = evidence.some((entry) => entry.field === 'druk') ? rangeOf(source.pressureBar, 50) : null;
  const flowLh = evidence.some((entry) => entry.field === 'debiet') ? rangeOf(source.flowLh, 1000000) : null;
  const role = String(source.role || '').toLowerCase().replace(/[^a-zà-ÿ -]/g, '').trim().slice(0, 30);
  if (!connections.length) return null;
  return { role: role || 'overig', connections, pressureBar, flowLh, evidence: evidence.slice(0, 12) };
}

/**
 * Of twee bereiken elkaar overlappen (een ontbrekend bereik telt als verenigbaar: er is niets om op af te keuren).
 * @param {?{ min: number, max: number }} left Het ene bereik.
 * @param {?{ min: number, max: number }} right Het andere bereik.
 * @returns {boolean} false alleen als beide bekend zijn en niet overlappen.
 */
const rangesMeet = (left, right) => !left || !right || (left.min <= right.max && right.min <= left.max);

/**
 * Of twee aansluitingen op elkaar passen.
 * @param {{ kind: string, size: string, gender: string }} left De ene aansluiting.
 * @param {{ kind: string, size: string, gender: string }} right De andere aansluiting.
 * @returns {boolean} true bij dezelfde soort en maat (bij draad: binnen op buiten).
 */
function connectionsFit(left, right) {
  if (left.kind !== right.kind || left.size !== right.size) return false;
  if (left.kind !== 'draad') return true;
  return (left.gender === 'binnen' && right.gender === 'buiten') || (left.gender === 'buiten' && right.gender === 'binnen');
}

/**
 * Beschrijft een aansluiting in gewone taal.
 * @param {{ kind: string, size: string, gender: string }} connection De aansluiting.
 * @returns {string} Bijvoorbeeld 'binnendraad 3/4"' of 'buis 25mm'.
 */
const connectionText = (connection) => (connection.kind === 'draad' ? `${connection.gender}draad ${connection.size}` : `${connection.kind} ${connection.size}`);

/**
 * Bepaalt of twee artikelen bij elkaar passen, met de reden en de bronnen.
 * @param {{ name: string, specs: object }} left Het ene artikel (naam + gevalideerde specificaties).
 * @param {{ name: string, specs: object }} right Het andere artikel.
 * @returns {?{ reason: string, evidence: object[] }} De reden en bronnen, of null als ze niet aantoonbaar passen.
 */
function compatible(left, right) {
  if (!left.specs || !right.specs || left.specs.role === right.specs.role) return null;
  if (!rangesMeet(left.specs.pressureBar, right.specs.pressureBar)) return null;
  for (const leftConnection of left.specs.connections) {
    const match = right.specs.connections.find((rightConnection) => connectionsFit(leftConnection, rightConnection));
    if (!match) continue;
    /**
     * De bronregel die de maat van een aansluiting onderbouwt.
     * @param {object} specs De specificaties van een artikel.
     * @param {object} connection De aansluiting.
     * @returns {object[]} Hoogstens één bronregel.
     */
    const pick = (specs, connection) => specs.evidence.filter((entry) => entry.field === 'aansluiting' && quoteSupportsSize(entry.quote, connection.size)).slice(0, 1);
    const evidence = [...pick(left.specs, leftConnection), ...pick(right.specs, match)].slice(0, MAX_EVIDENCE)
      .map((entry, index) => ({ ...entry, of: index === 0 ? left.name : right.name }));
    if (!evidence.length) return null;
    return { reason: `${left.name} heeft ${connectionText(leftConnection)}, ${right.name} heeft ${connectionText(match)}: dat sluit op elkaar aan.`, evidence };
  }
  return null;
}

/**
 * Zoekt voor elk artikel de artikelen die aantoonbaar bij het artikel passen.
 * @param {{ id: string, name: string, specs: object, rank?: number }[]} items De artikelen met gevalideerde specificaties (rank: hoger = eerder tonen, bijvoorbeeld de score van vaak samen besteld).
 * @param {{ perItem?: number }} [options] Hoeveel koppelingen per artikel hoogstens.
 * @returns {Map<string, { relatedId: string, reason: string, evidence: object[] }[]>} Per artikel-id de koppelingen, beste eerst.
 */
function suggestLinks(items, { perItem = 6 } = {}) {
  const byConnection = new Map();
  for (const item of items) {
    for (const connection of item.specs.connections) {
      const key = `${connection.kind}|${connection.size}`;
      if (!byConnection.has(key)) byConnection.set(key, []);
      byConnection.get(key).push(item);
    }
  }
  const result = new Map();
  for (const item of items) {
    const found = new Map();
    for (const connection of item.specs.connections) {
      for (const other of byConnection.get(`${connection.kind}|${connection.size}`) || []) {
        if (other.id === item.id || found.has(other.id)) continue;
        const fit = compatible(item, other);
        if (fit) found.set(other.id, { relatedId: other.id, rank: other.rank || 0, ...fit });
      }
    }
    // Eerst wat vaak samen wordt besteld, daarna op naam, zodat de volgorde bij elke run gelijk is.
    const sorted = [...found.values()].sort((left, right) => right.rank - left.rank || left.reason.localeCompare(right.reason, 'nl')).slice(0, perItem);
    if (sorted.length) result.set(item.id, sorted.map(({ relatedId, reason, evidence }) => ({ relatedId, reason, evidence })));
  }
  return result;
}

module.exports = { normalizeSize, quoteSupportsSize, validateSpecs, compatible, suggestLinks, connectionsFit, KINDS, GENDERS };
