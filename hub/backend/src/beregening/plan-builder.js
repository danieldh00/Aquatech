// Bouwt een beregeningsplan zonder browser en zonder AI: uit vlakken in meters (gazon, border, haag, plantenbak, droog, nat) plaatst het
// de sproeiers, deelt de zones in en maakt de stuklijst, met dezelfde rekenkern als de planner (frontend/beregening/js). De herkenning van
// een tekening doet de AI-app zelf; deze module controleert die invoer, rekent en geeft aandachtspunten terug.
// Elke bouw draait in een eigen sandbox met het assortiment, de prijzen en de sproeierbibliotheek van de organisatie, zodat niets
// tussen organisaties blijft hangen.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FRONTEND_DIR } = require('../paths');

const LIB_DIR = path.join(FRONTEND_DIR, 'beregening', 'js');
const LIB_FILES = ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'planner.js', 'hydraulics.js', 'bom.js', 'concept.js'];
/** Gecompileerde scripts (één keer), in een nieuwe sandbox per bouw uitgevoerd. */
let scripts = null;

/** Welke soorten vlak de bouwer kent (zoals Catalog.areaTypes). */
const AREA_TYPES = ['lawn', 'bed', 'hedge', 'planter', 'wet', 'dry'];
/** Soorten element (zoals Catalog.elementTypes). */
const ELEMENT_KINDS = ['source', 'controller', 'valvebox', 'outlet'];
/** Beregeningsmethodes per soort vlak die de bouwer toestaat. */
const DRIP_METHODS = { bed: ['dripline', 'drippers', 'none'], hedge: ['dripline', 'drippers', 'none'], planter: ['drippers', 'dripline', 'none'] };
/** Grenzen: genoeg voor elke woontuin, maar geen rekentijd die de server vastzet. */
const LIMITS = { areas: 40, points: 60, coordinate: 500, minAreaM2: 0.5, lawnM2: 2500, lawns: 8, elements: 12 };
/** Standaardwaarden die als aanname worden gemeld als de gebruiker ze niet gaf. */
const DEFAULT_PRESSURE = 3.5;
const DEFAULT_FLOW = 2.0;

/**
 * Laadt de plannerbibliotheken in een nieuwe sandbox en past het assortiment van de organisatie toe.
 * @param {{ catalog?: object|null, library?: object|null }} tenantData Antwoord van de catalogus (articles, assortment) en de eigen sproeierbibliotheek.
 * @returns {{ Geo: object, Catalog: object, Planner: object, Hydraulics: object, BOM: object, Concept: object }} De bibliotheken.
 */
function loadLab({ catalog = null, library = null } = {}) {
  if (!scripts) scripts = LIB_FILES.map((file) => new vm.Script(fs.readFileSync(path.join(LIB_DIR, file), 'utf8'), { filename: file }));
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  for (const script of scripts) script.runInContext(sandbox);
  const lab = sandbox.window;
  if (library) lab.Catalog.setLibrary(library);
  const assortment = catalog && Array.isArray(catalog.assortment) && catalog.assortment.length ? catalog.assortment : null;
  lab.Catalog.setAssortment(assortment);
  lab.Catalog.libraryArticles();
  for (const [code, product] of Object.entries((catalog && catalog.articles) || {})) {
    if (!lab.Catalog.articles[code]) continue;
    lab.Catalog.articles[code] = { ...lab.Catalog.articles[code], name: product.name || lab.Catalog.articles[code].name, price: product.price, sku: product.sku, url: product.url, inStock: product.inStock, shop: true };
  }
  return lab;
}

/**
 * Uit de sandbox (ander realm) naar gewone objecten.
 * @param {*} value Een waarde uit de sandbox.
 * @returns {*} Een gewone kopie.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));
/**
 * Rondt af op één decimaal.
 * @param {number} value Het getal.
 * @returns {number} Het afgeronde getal.
 */
const round1 = (value) => Math.round(Number(value) * 10) / 10;
/**
 * Rondt af op twee decimalen.
 * @param {number} value Het getal.
 * @returns {number} Het afgeronde getal.
 */
const round2 = (value) => Math.round(Number(value) * 100) / 100;
/**
 * Of het een eindig getal binnen de coördinatengrens is.
 * @param {*} value De waarde.
 * @returns {boolean} true als het kan.
 */
const validCoordinate = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate;
/**
 * Korte schone tekst.
 * @param {*} value De invoer.
 * @param {number} max Hoeveel tekens hoogstens.
 * @returns {string} De tekst.
 */
const cleanText = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Controleert de invoer van de AI-app en maakt er vlakken en elementen van. Elke fout is een zin die de AI-app aan de gebruiker kan voorleggen.
 * @param {object} input { vlakken [{ soort, naam, punten [{ x, y }] }], elementen [{ soort, x, y }], druk, debiet, sproeiertype, methodes }.
 * @returns {{ areas: object[], elements: object[], settings: object, problems: string[] }} De opgeschoonde invoer en de fouten.
 */
function sanitizeInput(input) {
  const problems = [];
  const areas = [];
  const given = Array.isArray(input.vlakken) ? input.vlakken : [];
  if (!given.length) problems.push('Geef minstens één vlak (bijvoorbeeld het gazon) met hoekpunten in meters.');
  if (given.length > LIMITS.areas) problems.push(`Hoogstens ${LIMITS.areas} vlakken per plan.`);
  given.slice(0, LIMITS.areas).forEach((entry, index) => {
    const label = cleanText(entry && entry.naam, 60) || `vlak ${index + 1}`;
    const points = Array.isArray(entry && entry.punten) ? entry.punten : [];
    if (!entry || !AREA_TYPES.includes(entry.soort)) return problems.push(`${label}: kies een soort uit ${AREA_TYPES.join(', ')}.`);
    if (points.length < 3 || points.length > LIMITS.points) return problems.push(`${label}: geef 3 tot ${LIMITS.points} hoekpunten.`);
    if (!points.every((point) => point && validCoordinate(point.x) && validCoordinate(point.y))) return problems.push(`${label}: hoekpunten zijn getallen in meters (hoogstens ${LIMITS.coordinate}).`);
    areas.push({ type: entry.soort, name: label, pts: points.map((point) => ({ x: round2(point.x), y: round2(point.y) })) });
  });
  const elements = [];
  for (const entry of Array.isArray(input.elementen) ? input.elementen.slice(0, LIMITS.elements) : []) {
    if (!entry || !ELEMENT_KINDS.includes(entry.soort) || !validCoordinate(entry.x) || !validCoordinate(entry.y)) { problems.push(`Element met soort ${cleanText(entry && entry.soort, 20)}: gebruik ${ELEMENT_KINDS.join(', ')} met x en y in meters.`); continue; }
    elements.push({ kind: entry.soort, x: round2(entry.x), y: round2(entry.y) });
  }
  const pressure = input.druk == null ? null : Number(input.druk);
  const flow = input.debiet == null ? null : Number(input.debiet);
  if (pressure != null && !(pressure >= 0.5 && pressure <= 10)) problems.push('De waterdruk (bar) ligt tussen 0,5 en 10.');
  if (flow != null && !(flow >= 0.2 && flow <= 30)) problems.push('Het debiet (m³/u) ligt tussen 0,2 en 30.');
  const methods = { bed: 'dripline', hedge: 'dripline', planter: 'drippers' };
  if (input.methodes != null && (typeof input.methodes !== 'object' || Array.isArray(input.methodes))) problems.push('Methodes: geef een object, bijvoorbeeld { bed: "drippers" }.');
  for (const [kind, method] of Object.entries(input.methodes && typeof input.methodes === 'object' ? input.methodes : {})) {
    if (!Object.hasOwn(DRIP_METHODS, kind)) { problems.push(`Methode voor ${cleanText(kind, 20)}: kies bed, hedge of planter.`); continue; }
    if (!DRIP_METHODS[kind].includes(method)) { problems.push(`Methode ${cleanText(method, 20)} voor ${kind}: kies uit ${DRIP_METHODS[kind].join(', ')}.`); continue; }
    methods[kind] = method;
  }
  const sprinklerType = input.sproeiertype == null ? 'auto' : String(input.sproeiertype);
  if (!['auto', 'rotator', 'spray', 'rotor'].includes(sprinklerType)) problems.push('Sproeiertype: auto, rotator, spray of rotor.');
  const settings = { pressure: pressure == null ? DEFAULT_PRESSURE : pressure, flow: flow == null ? DEFAULT_FLOW : flow, level: 'expert', targetMm: 20, sessions: 3, sprinklerType, radius: null, methods, bedSprinklerType: 'spray' };
  return { areas, elements, settings, problems, assumed: { pressure: pressure == null, flow: flow == null } };
}

/**
 * Bouwt het plan: vlakken, elementen, sproeiers in de gazons, zones en leidingen, en rekent de stuklijst uit.
 * @param {object} input De AI-invoer (zie sanitizeInput) plus naam, klant en adres.
 * @param {{ catalog?: object|null, library?: object|null }} tenantData Assortiment, prijzen en eigen sproeiers van de organisatie.
 * @returns {{ error?: string, problems?: string[], state?: object, report?: object }} Het plan en het verslag, of de fouten.
 */
function buildPlan(input, tenantData = {}) {
  const clean = sanitizeInput(input);
  if (clean.problems.length) return { problems: clean.problems };
  const lawns = clean.areas.filter((area) => area.type === 'lawn');
  if (lawns.length > LIMITS.lawns) return { problems: [`Hoogstens ${LIMITS.lawns} gazons per plan.`] };
  const lab = loadLab(tenantData);
  const { Geo, Catalog, Planner, Hydraulics, BOM, Concept } = lab;
  const state = {
    version: 1,
    meta: { name: cleanText(input.naam, 120) || 'Beregeningsplan', customer: cleanText(input.klantNaam, 120), address: cleanText(input.adres, 200) },
    settings: clean.settings, areas: [], elements: [], sprinklers: [], zones: [],
  };
  const problems = [];
  clean.areas.forEach((area, index) => {
    const size = Geo.area(area.pts);
    if (!(size >= LIMITS.minAreaM2)) return problems.push(`${area.name}: het vlak is te klein of de hoekpunten vormen geen vlak.`);
    if (area.type === 'lawn' && size > LIMITS.lawnM2) return problems.push(`${area.name}: een gazon van ${Math.round(size)} m² is te groot voor een automatisch ontwerp (maximaal ${LIMITS.lawnM2} m²).`);
    state.areas.push({ id: `a${index + 1}`, type: area.type, name: area.name, pts: area.pts });
  });
  if (problems.length) return { problems };
  const lawnAreas = state.areas.filter((area) => area.type === 'lawn');
  state.elements = plain(Concept.defaultElements(state.areas, clean.elements));
  const placedTypes = [];
  const around = {
    dry: state.areas.filter((area) => area.type === 'dry').map((area) => area.pts),
    wet: state.areas.filter((area) => area.type === 'wet').map((area) => area.pts),
  };
  for (const area of lawnAreas) {
    let heads;
    if (clean.settings.sprinklerType === 'auto') {
      const types = ['rotator', 'spray', 'rotor'].filter((typeKey) => Catalog.typeAvailable(typeKey));
      const result = Planner.bestPlace(area.pts, { types, bodies: Object.fromEntries(types.map((typeKey) => [typeKey, null])), pressure: clean.settings.pressure, ...around });
      heads = result.heads;
      if (result.type) placedTypes.push({ area: area.name, type: result.type });
    } else {
      const type = Catalog.usableType(clean.settings.sprinklerType);
      heads = Planner.autoPlace(area.pts, type, { r: null, body: null, ...around });
      placedTypes.push({ area: area.name, type });
    }
    state.sprinklers.push(...plain(heads));
  }
  const irrigated = Hydraulics.hasIrrigation(state);
  const warnings = [];
  let rows = [];
  let rowsMissing = [];
  if (irrigated) {
    Hydraulics.autoZones(state);
    Hydraulics.calculate(state);
    rows = plain(BOM.build(state));
    rowsMissing = plain(BOM.build(state).missing || []);
    for (const warning of state.calc.warnings || []) warnings.push(warning);
  } else {
    warnings.push('Er zijn geen gazons of druppelvlakken om te beregenen: er zijn geen sproeiers of materialen berekend.');
  }
  if (lawnAreas.length && !state.sprinklers.length) warnings.push('Er zijn geen sproeiers in het gazon geplaatst: er staat geen passende sproeier in het eigen assortiment (Artikelen). Voeg sproeiers toe aan het assortiment of kies een ander sproeiertype.');
  if (!lawnAreas.length) warnings.push('Er is geen gazon in het plan; alleen beplanting met druppelslang of druppelaars is meegenomen.');
  if (rowsMissing.length) warnings.push(`Niet in het eigen assortiment en dus niet in de stuklijst: ${rowsMissing.map((item) => `${item.name} (${item.qty} ${item.unit})`).join(', ')}.`);
  const cleanState = plain({ ...state, calc: undefined });
  const typeCounts = {};
  for (const sprinkler of cleanState.sprinklers) typeCounts[sprinkler.type] = (typeCounts[sprinkler.type] || 0) + 1;
  const bomRows = rows.map((row) => ({ code: row.code, naam: row.name, aantal: row.qty, eenheid: row.unit, prijsExclBtw: round2(row.price), totaalExclBtw: round2(row.qty * row.price) }));
  const report = {
    vlakken: cleanState.areas.map((area) => ({ naam: area.name, soort: area.type, oppervlakM2: round1(Geo.area(area.pts)), methode: ['bed', 'hedge', 'planter'].includes(area.type) ? Hydraulics.methodOf(state, area) : null })),
    sproeiers: { totaal: cleanState.sprinklers.length, perType: typeCounts, perGazon: placedTypes },
    zones: (state.calc ? state.calc.zones : []).map((zone) => ({ naam: zone.zone.name, debietLiterPerUur: Math.round(zone.q), ok: Boolean(zone.ok) })),
    stuklijst: bomRows,
    totaalMateriaalExclBtw: round2(bomRows.reduce((sum, row) => sum + row.totaalExclBtw, 0)),
    aandachtspunten: warnings,
    aannames: [
      ...(clean.assumed.pressure ? [`Waterdruk ${DEFAULT_PRESSURE} bar aangenomen.`] : []),
      ...(clean.assumed.flow ? [`Debiet ${DEFAULT_FLOW} m³/u aangenomen.`] : []),
      ...(clean.elements.some((element) => element.kind === 'source') ? [] : ['Wateraansluiting, beregeningscomputer en ventielkast zijn automatisch bij de gevel of het gazon gezet.']),
    ],
  };
  return { state: cleanState, report: plain(report) };
}

/**
 * Vat een bewaard plan samen (zelfde verslag als bij het bouwen), met de assortimentsgegevens van de organisatie.
 * @param {object} planData Het bewaarde plan (de data van het plan).
 * @param {{ catalog?: object|null, library?: object|null }} tenantData Assortiment, prijzen en eigen sproeiers van de organisatie.
 * @returns {object} Het verslag zoals buildPlan het geeft.
 */
function summarizePlan(planData, tenantData = {}) {
  const lab = loadLab(tenantData);
  const { Geo, Hydraulics, BOM } = lab;
  const state = plain(planData);
  for (const key of ['areas', 'elements', 'sprinklers', 'zones']) if (!Array.isArray(state[key])) state[key] = [];
  state.settings = { pressure: DEFAULT_PRESSURE, flow: DEFAULT_FLOW, level: 'expert', methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, ...(state.settings || {}) };
  state.calc = null;
  const warnings = [];
  let rows = [];
  if (Hydraulics.hasIrrigation(state)) {
    if (!state.zones.length) Hydraulics.autoZones(state);
    Hydraulics.calculate(state);
    rows = plain(BOM.build(state));
    warnings.push(...(state.calc.warnings || []));
  }
  const typeCounts = {};
  for (const sprinkler of state.sprinklers) typeCounts[sprinkler.type] = (typeCounts[sprinkler.type] || 0) + 1;
  const bomRows = rows.map((row) => ({ code: row.code, naam: row.name, aantal: row.qty, eenheid: row.unit, prijsExclBtw: round2(row.price), totaalExclBtw: round2(row.qty * row.price) }));
  return plain({
    naam: cleanText(state.meta && state.meta.name, 120),
    vlakken: state.areas.map((area) => ({ naam: cleanText(area.name, 60), soort: area.type, oppervlakM2: round1(Geo.area(area.pts)) })),
    sproeiers: { totaal: state.sprinklers.length, perType: typeCounts },
    zones: (state.calc ? state.calc.zones : []).map((zone) => ({ naam: zone.zone.name, debietLiterPerUur: Math.round(zone.q), ok: Boolean(zone.ok) })),
    stuklijst: bomRows, totaalMateriaalExclBtw: round2(bomRows.reduce((sum, row) => sum + row.totaalExclBtw, 0)), aandachtspunten: warnings,
  });
}

module.exports = { buildPlan, summarizePlan, sanitizeInput, AREA_TYPES, ELEMENT_KINDS, LIMITS };
