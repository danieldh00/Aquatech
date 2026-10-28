/*
 * Sproeierbibliotheek: behuizingen (sproeierhuizen, rotors) en nozzles met hun
 * prestaties (worp en debiet per druk). Gedeeld door de planner (window.SprinklerLib)
 * en de server (require), die er een geïmporteerde bibliotheek mee controleert.
 *
 * - Een behuizing heeft een aansluiting (`mount`); een nozzle past op elke behuizing
 *   met dezelfde aansluiting (bijv. 'sproeikop' = ½" binnendraad van een 1800 /
 *   Pro-Spray, 'rb5000' = nozzles van de Rain Bird 5000-rotor).
 * - Een nozzle hoort bij een sproeiergroep (`group`: spray | rotator | rotor); de
 *   planner rekent per groep en mengt groepen niet in één zone.
 * - Prestaties: punten { bar, r, q } met worp r (m) en debiet q (l/u). Bij
 *   `matched` (gelijke neerslag bij elke hoek, MP Rotator, HE-VAN) is q het debiet
 *   bij 360° en schaalt het met de sproeihoek; anders (rotornozzle) is q het debiet
 *   van de nozzle, ongeacht de hoek.
 * - De stelschroef kort de worp in tot `rMin`; bij `matched` daalt het debiet mee
 *   (neerslag blijft gelijk).
 * - Elke organisatie kan de standaardbibliotheek aanvullen of overschrijven met een
 *   Excel-bestand (Beheer > Sproeiers). Eigen regels gaan voor een standaardregel met
 *   dezelfde sleutel; `active: false` verbergt een standaardregel.
 *
 * De standaardwaarden zijn afgerond uit de openbare prestatietabellen van de
 * fabrikanten (Rain Bird, Hunter) en bedoeld als startpunt. Prijzen zijn indicatief.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else {
    root.SprinklerLib = lib;
    if (root.window && root.window !== root) root.window.SprinklerLib = lib; // vm-sandbox (tests, server)
  }
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const GROUPS = { spray: 'Sproeier (vaste kop)', rotator: 'Meerstraalsrotator', rotor: 'Turbinesproeier (rotor)' };
  const MOUNTS = { sproeikop: 'Sproeierhuis ½" (1800, Pro-Spray)', rb5000: 'Rain Bird 5000-rotor' };
  const LIMITS = { bodies: 300, nozzles: 1000, perf: 12, text: 120 };

  // ---------------------------------------------------------------- standaarddata

  /**
   * Maakt prestatiepunten uit worp en neerslag bij de nominale druk (matched nozzles).
   * @param {number} radius worp bij de nominale druk (m)
   * @param {number} precipitation neerslag (mm/u)
   * @param {Array<number[]>} factors per punt [druk, factor worp, factor debiet]
   * @returns {Array<{bar: number, r: number, q: number}>} prestatiepunten
   */
  const matchedPerf = (radius, precipitation, factors) => factors.map(([bar, radiusFactor, flowFactor]) => ({ bar, r: round(radius * radiusFactor, 1), q: Math.round(precipitation * radius * radius * flowFactor) }));
  // MP Rotator: Hunter geeft 2,8 bar als ideale druk (PRS40-huis); bereik 2,1–3,8 bar.
  const MP = [[2.1, 0.93, 0.86], [2.8, 1, 1], [3.8, 1, 1.15]];
  // HE-VAN: nominaal 2,1 bar (1800-PRS); worp en debiet stijgen met de druk.
  const VAN = [[1.4, 0.85, 0.8], [2.1, 1, 1], [2.8, 1.06, 1.14]];

  /**
   * Maakt een behuizing.
   * @param {string} key sleutel
   * @param {string} brand merk
   * @param {string} name naam
   * @param {string} code artikelcode
   * @param {number} popup pop-uphoogte (cm)
   * @param {string} mount aansluiting
   * @param {number|null} regBar geregelde druk (bar), of null zonder drukregeling
   * @param {number} minBar minimale druk (bar)
   * @param {number} maxBar maximale druk (bar)
   * @param {number} price prijs (€)
   * @returns {object} de behuizing
   */
  const body = (key, brand, name, code, popup, mount, regBar, minBar, maxBar, price) =>
    ({ key, brand, name, code, popup, mount, regBar, minBar, maxBar, price });

  const DEFAULT_BODIES = [
    body('RB-1804-PRS', 'Rain Bird', '1804 PRS (10 cm, drukregeling 2,1 bar)', 'RB-1804-PRS', 10, 'sproeikop', 2.1, 1.4, 4.8, 7.9),
    body('RB-1806-PRS', 'Rain Bird', '1806 PRS (15 cm, drukregeling 2,1 bar)', 'RB-1806-PRS', 15, 'sproeikop', 2.1, 1.4, 4.8, 9.9),
    body('RB-1812-PRS', 'Rain Bird', '1812 PRS (30 cm, drukregeling 2,1 bar)', 'RB-1812-PRS', 30, 'sproeikop', 2.1, 1.4, 4.8, 12.9),
    body('RB-1804-P45', 'Rain Bird', '1804 SAM-P45 (10 cm, drukregeling 3,1 bar)', 'RB-1804-P45', 10, 'sproeikop', 3.1, 2.1, 4.8, 8.9),
    body('RB-1806-P45', 'Rain Bird', '1806 SAM-P45 (15 cm, drukregeling 3,1 bar)', 'RB-1806-P45', 15, 'sproeikop', 3.1, 2.1, 4.8, 10.9),
    body('RB-1812-P45', 'Rain Bird', '1812 SAM-P45 (30 cm, drukregeling 3,1 bar)', 'RB-1812-P45', 30, 'sproeikop', 3.1, 2.1, 4.8, 13.9),
    body('HU-PROS04-PRS40', 'Hunter', 'Pro-Spray PRS40 (10 cm, drukregeling 2,8 bar)', 'HU-PROS04-PRS40', 10, 'sproeikop', 2.8, 2.1, 4.8, 8.9),
    body('HU-PROS06-PRS40', 'Hunter', 'Pro-Spray PRS40 (15 cm, drukregeling 2,8 bar)', 'HU-PROS06-PRS40', 15, 'sproeikop', 2.8, 2.1, 4.8, 10.9),
    body('HU-PROS12-PRS40', 'Hunter', 'Pro-Spray PRS40 (30 cm, drukregeling 2,8 bar)', 'HU-PROS12-PRS40', 30, 'sproeikop', 2.8, 2.1, 4.8, 13.9),
    body('RB-5004-PC', 'Rain Bird', '5004 PC (10 cm, sector 40–360°)', 'RB-5004-PC', 10, 'rb5000', null, 1.7, 4.5, 16.5),
    body('RB-5004-PRS', 'Rain Bird', '5004 PRS (10 cm, drukregeling 3,1 bar)', 'RB-5004-PRS', 10, 'rb5000', 3.1, 2.1, 4.8, 22.5),
    body('RB-5012-PC', 'Rain Bird', '5012 PC (30 cm, sector 40–360°)', 'RB-5012-PC', 30, 'rb5000', null, 1.7, 4.5, 32.5),
  ];

  /**
   * Maakt een nozzle met standaardwaarden (matched, niet inkortbaar).
   * @param {object} fields de velden van de nozzle
   * @returns {object} de nozzle
   */
  const nozzle = (fields) => ({ matched: true, reduce: null, ...fields });
  const MP_ARCS = [[90, 210], [210, 270], [360, 360]];

  const DEFAULT_NOZZLES = [
    // Hunter MP Rotator (sleutels gelijk aan de MP-modellen in eerdere plannen)
    nozzle({ key: 'MP1000', brand: 'Hunter', name: 'MP1000', code: 'ROT-MP1000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 2.5, bar: 2.8, perf: matchedPerf(4.5, 11, MP) }),
    nozzle({ key: 'MP2000', brand: 'Hunter', name: 'MP2000', code: 'ROT-MP2000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 4.0, bar: 2.8, perf: matchedPerf(6.4, 10, MP) }),
    nozzle({ key: 'MP3000', brand: 'Hunter', name: 'MP3000', code: 'ROT-MP3000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 6.7, bar: 2.8, perf: matchedPerf(9.1, 11, MP) }),
    nozzle({ key: 'MP3500', brand: 'Hunter', name: 'MP3500', code: 'ROT-MP3500', mount: 'sproeikop', group: 'rotator', arcs: [[90, 210]], rMin: 9.4, bar: 2.8, perf: matchedPerf(10.7, 10, MP) }),
    nozzle({ key: 'MPCORNER', brand: 'Hunter', name: 'MP Corner', code: 'ROT-MPCORNER', mount: 'sproeikop', group: 'rotator', arcs: [[45, 105]], rMin: 2.5, bar: 2.8, perf: matchedPerf(4.5, 11, MP) }),
    // Rain Bird HE-VAN (verstelbare sproeikop 0–360°, stelschroef tot 25% korter)
    ...[['08', 2.4], ['10', 3.0], ['12', 3.7], ['15', 4.6]].map(([size, radius]) => nozzle({
      key: `HE-VAN-${size}`, brand: 'Rain Bird', name: `HE-VAN-${size}`, code: `RB-HEVAN${size}`, mount: 'sproeikop', group: 'spray',
      arcs: [[0, 360]], rMin: round(radius * 0.75, 1), bar: 2.1, price: 3.9, perf: matchedPerf(radius, 40, VAN),
    })),
    // Rain Bird 5000 Rain Curtain (standaardhoek 25°): debiet per nozzle, niet per hoek
    ...[['1.5', [[2.5, 10.4, 310], [3.0, 10.5, 340], [3.5, 10.6, 370], [4.0, 10.6, 400]]],
      ['2.0', [[2.5, 10.7, 410], [3.0, 10.9, 450], [3.5, 11.0, 490], [4.0, 11.1, 520]]],
      ['2.5', [[2.5, 11.0, 520], [3.0, 11.3, 570], [3.5, 11.5, 610], [4.0, 11.6, 660]]],
      ['3.0', [[2.5, 11.3, 630], [3.0, 11.7, 690], [3.5, 12.0, 750], [4.0, 12.2, 800]]],
      ['4.0', [[2.5, 11.6, 820], [3.0, 12.2, 900], [3.5, 12.5, 970], [4.0, 12.8, 1040]]],
      ['5.0', [[2.5, 12.2, 1020], [3.0, 12.9, 1120], [3.5, 13.4, 1210], [4.0, 13.7, 1290]]],
      ['6.0', [[2.5, 13.1, 1230], [3.0, 13.9, 1350], [3.5, 14.5, 1460], [4.0, 14.9, 1550]]],
      ['8.0', [[2.5, 13.4, 1630], [3.0, 14.2, 1790], [3.5, 14.8, 1930], [4.0, 15.2, 2060]]],
    ].map(([size, performance]) => nozzle({
      key: `RB5000-${size}`, brand: 'Rain Bird', name: `Rain Curtain ${size.replace('.', ',')}`, code: '', mount: 'rb5000', group: 'rotor',
      arcs: [[40, 360]], reduce: 0.25, matched: false, bar: 3.0, perf: performance.map(([bar, radius, flow]) => ({ bar, r: radius, q: flow })),
    })),
  ];

  const DEFAULTS = { bodies: DEFAULT_BODIES, nozzles: DEFAULT_NOZZLES };

  // ---------------------------------------------------------------- hulpfuncties

  /**
   * Rondt af op een aantal decimalen.
   * @param {number} value het getal
   * @param {number} decimals aantal decimalen (standaard 2)
   * @returns {number} het afgeronde getal
   */
  function round(value, decimals = 2) { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }
  /**
   * Houdt een getal binnen grenzen.
   * @param {number} value het getal
   * @param {number} low ondergrens
   * @param {number} high bovengrens
   * @returns {number} het begrensde getal
   */
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  /**
   * Worp (m) en debiet (l/u) bij een druk: lineair tussen de meetpunten, buiten het bereik het dichtstbijzijnde.
   * @param {object} nozzleSpec de nozzle
   * @param {number} bar de druk (leeg = werkdruk van de nozzle)
   * @returns {{r: number, q: number, bar: number}|null} worp, debiet en druk; null zonder prestaties
   */
  function perfAt(nozzleSpec, bar) {
    const points = (nozzleSpec && nozzleSpec.perf) || [];
    if (!points.length) return null;
    if (bar == null || !Number.isFinite(bar)) bar = nozzleSpec.bar || points[0].bar;
    if (bar <= points[0].bar) return { r: points[0].r, q: points[0].q, bar: points[0].bar };
    const last = points[points.length - 1];
    if (bar >= last.bar) return { r: last.r, q: last.q, bar: last.bar };
    for (let i = 1; i < points.length; i++) {
      const lower = points[i - 1], upper = points[i];
      if (bar <= upper.bar) {
        const fraction = (bar - lower.bar) / (upper.bar - lower.bar || 1);
        return { r: round(lower.r + (upper.r - lower.r) * fraction, 2), q: round(lower.q + (upper.q - lower.q) * fraction, 1), bar };
      }
    }
    return { r: last.r, q: last.q, bar: last.bar };
  }

  /**
   * Kleinste en grootste worp van een nozzle bij een druk.
   * @param {object} nozzleSpec de nozzle
   * @param {number} bar de druk
   * @returns {{rMin: number, rMax: number}|null} het bereik, of null zonder prestaties
   */
  function radiusRange(nozzleSpec, bar) {
    const performance = perfAt(nozzleSpec, bar);
    if (!performance) return null;
    const rMax = performance.r;
    const rMin = nozzleSpec.rMin != null ? Math.min(nozzleSpec.rMin, rMax) : round(rMax * (1 - (nozzleSpec.reduce == null ? 0.25 : nozzleSpec.reduce)), 1);
    return { rMin, rMax };
  }

  /**
   * Debiet (l/u) van een nozzle bij een worp, sproeihoek en druk.
   * @param {object} nozzleSpec de nozzle
   * @param {number} radius ingestelde worp (m)
   * @param {number} arc sproeihoek (graden)
   * @param {number} bar de druk
   * @returns {number} debiet in l/u
   */
  function flowLph(nozzleSpec, radius, arc, bar) {
    const performance = perfAt(nozzleSpec, bar);
    if (!performance) return 0;
    if (!nozzleSpec.matched) return performance.q;
    const factor = performance.r > 0 && radius > 0 ? Math.min(1, (radius / performance.r) ** 2) : 1;
    return performance.q * factor * (clamp(arc, 0, 360) / 360);
  }

  // ---------------------------------------------------------------- controleren

  /**
   * Maakt nette tekst: zonder stuurtekens, enkele spaties, begrensd.
   * @param {*} value de invoer
   * @param {number} max maximale lengte
   * @returns {string} de tekst
   */
  const text = (value, max = LIMITS.text) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  /**
   * Leest een getal (ook met komma).
   * @param {*} value de invoer
   * @returns {number|null} het getal, of null als het leeg of ongeldig is
   */
  const num = (value) => {
    if (value == null || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.').trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  /**
   * Leest ja/nee (ook 'nee', 'uit', '0', false).
   * @param {*} value de invoer
   * @param {boolean} fallback waarde bij lege invoer
   * @returns {boolean} de keuze
   */
  const yes = (value, fallback = true) => {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !/^(nee|no|n|0|false|onwaar|uit)$/i.test(String(value).trim());
  };
  const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,59}$/;

  /**
   * Leest sproeihoeken uit tekst ("90-210; 210-270; 360") of een lijst paren.
   * @param {string|Array} value de invoer
   * @returns {Array<number[]>} gesorteerde sectoren [van, tot], hooguit 8
   */
  function parseArcs(value) {
    const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[;|]+/);
    const result = [];
    for (const part of list) {
      let low, high;
      if (Array.isArray(part)) [low, high] = [num(part[0]), num(part[1] ?? part[0])];
      else {
        const match = String(part).replace(/°/g, '').match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–]\s*(\d+(?:[.,]\d+)?))?\s*$/);
        if (!match) continue;
        low = num(match[1]); high = match[2] == null ? low : num(match[2]);
      }
      if (low == null || high == null) continue;
      low = clamp(Math.round(low), 0, 360); high = clamp(Math.round(high), 0, 360);
      if (high < low) [low, high] = [high, low];
      result.push([low, high]);
    }
    return result.sort((left, right) => left[0] - right[0]).slice(0, 8);
  }
  /**
   * Schrijft sproeihoeken als tekst.
   * @param {Array<number[]>} arcs de sectoren
   * @returns {string} bijv. '90-210; 360'
   */
  const arcsText = (arcs) => (arcs || []).map(([low, high]) => (low === high ? `${low}` : `${low}-${high}`)).join('; ');

  /**
   * Controleert één behuizing.
   * @param {object} raw de ingelezen regel
   * @param {string[]} problems meldingen (hier komen fouten bij)
   * @param {string} where plaats van de regel, voor de melding
   * @returns {object|null} de nette behuizing, of null als hij ongeldig is
   */
  function sanitizeBody(raw, problems, where) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const key = text(row.key, 60);
    if (!KEY.test(key)) { problems.push(`${where}: sleutel ontbreekt of bevat ongeldige tekens.`); return null; }
    const regBar = num(row.regBar);
    const result = {
      key, brand: text(row.brand, 60), name: text(row.name) || key, code: text(row.code, 60),
      popup: num(row.popup), mount: text(row.mount, 40) || 'sproeikop',
      regBar: regBar != null && regBar > 0 ? round(clamp(regBar, 0.5, 10), 2) : null,
      minBar: num(row.minBar), maxBar: num(row.maxBar), price: num(row.price), active: yes(row.active),
    };
    if (result.popup != null) result.popup = clamp(Math.round(result.popup), 0, 100);
    if (result.minBar != null) result.minBar = round(clamp(result.minBar, 0, 10), 2);
    if (result.maxBar != null) result.maxBar = round(clamp(result.maxBar, 0, 12), 2);
    if (result.price != null) result.price = round(clamp(result.price, 0, 100000), 2);
    return result;
  }

  /**
   * Controleert één nozzle met zijn prestaties.
   * @param {object} rawRow de ingelezen regel
   * @param {string[]} problems meldingen (hier komen fouten bij)
   * @param {string} where plaats van de regel, voor de melding
   * @returns {object|null} de nette nozzle, of null als hij ongeldig is
   */
  function sanitizeNozzle(rawRow, problems, where) {
    const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
    const key = text(row.key, 60);
    if (!KEY.test(key)) { problems.push(`${where}: sleutel ontbreekt of bevat ongeldige tekens.`); return null; }
    const group = text(row.group, 20).toLowerCase();
    if (!GROUPS[group]) { problems.push(`${where} (${key}): soort moet spray, rotator of rotor zijn.`); return null; }
    const arcs = parseArcs(row.arcs);
    if (!arcs.length) { problems.push(`${where} (${key}): geef de sproeihoeken, bijv. "90-210; 360".`); return null; }
    const perf = (Array.isArray(row.perf) ? row.perf : [])
      .map((point) => ({ bar: num(point && point.bar), r: num(point && point.r), q: num(point && point.q) }))
      .filter((point) => point.bar != null && point.r != null && point.q != null && point.bar > 0 && point.bar <= 12 && point.r > 0 && point.r <= 40 && point.q > 0 && point.q <= 100000)
      .map((point) => ({ bar: round(point.bar, 2), r: round(point.r, 2), q: round(point.q, 1) }))
      .sort((left, right) => left.bar - right.bar)
      .filter((point, i, all) => i === 0 || point.bar !== all[i - 1].bar)
      .slice(0, LIMITS.perf);
    if (!perf.length) { problems.push(`${where} (${key}): geen prestaties (druk, worp, debiet) gevonden.`); return null; }
    const reduce = num(row.reduce);
    const rMin = num(row.rMin);
    const bar = num(row.bar);
    return {
      key, brand: text(row.brand, 60), name: text(row.name) || key, code: text(row.code, 60),
      mount: text(row.mount, 40) || 'sproeikop', group, arcs,
      rMin: rMin != null && rMin > 0 ? round(Math.min(rMin, perf[perf.length - 1].r), 2) : null,
      reduce: reduce != null ? round(clamp(reduce > 1 ? reduce / 100 : reduce, 0, 0.9), 2) : null,
      matched: yes(row.matched, group !== 'rotor'),
      bar: bar != null && bar > 0 ? round(clamp(bar, 0.5, 10), 2) : perf[Math.floor((perf.length - 1) / 2)].bar,
      price: num(row.price) != null ? round(clamp(num(row.price), 0, 100000), 2) : null,
      active: yes(row.active),
      perf,
    };
  }

  /**
   * Controleert een (eigen) bibliotheek. Ongeldige regels vallen weg met een melding.
   * @param {object} raw de ingelezen bibliotheek
   * @returns {{bodies: object[], nozzles: object[], problems: string[]}} de nette regels en de meldingen
   */
  function sanitize(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const problems = [];
    const seen = { bodies: new Set(), nozzles: new Set() };
    /**
     * Controleert de regels van één soort en haalt dubbele sleutels weg.
     * @param {object[]} list de regels
     * @param {string} kind 'bodies' of 'nozzles'
     * @param {function} sanitizeRow controle per regel
     * @param {string} label naam voor in de melding
     * @returns {object[]} de geldige regels
     */
    const take = (list, kind, sanitizeRow, label) => (Array.isArray(list) ? list : []).slice(0, LIMITS[kind]).map((row, i) => {
      const clean = sanitizeRow(row, problems, `${label} ${i + 1}`);
      if (!clean) return null;
      if (seen[kind].has(clean.key)) { problems.push(`${label} ${i + 1}: sleutel ${clean.key} komt dubbel voor.`); return null; }
      seen[kind].add(clean.key);
      return clean;
    }).filter(Boolean);
    const bodies = take(input.bodies, 'bodies', sanitizeBody, 'Behuizing');
    const nozzles = take(input.nozzles, 'nozzles', sanitizeNozzle, 'Nozzle');
    if (Array.isArray(input.bodies) && input.bodies.length > LIMITS.bodies) problems.push(`Maximaal ${LIMITS.bodies} behuizingen.`);
    if (Array.isArray(input.nozzles) && input.nozzles.length > LIMITS.nozzles) problems.push(`Maximaal ${LIMITS.nozzles} nozzles.`);
    return { bodies, nozzles, problems };
  }

  /**
   * Standaard + eigen: eigen regels vervangen die met dezelfde sleutel, `active: false` haalt weg.
   * @param {{bodies: object[], nozzles: object[]}} own de eigen regels
   * @returns {{bodies: object[], nozzles: object[]}} de samengevoegde bibliotheek
   */
  function merge(own) {
    const ownLibrary = own || {};
    /**
     * Voegt eigen regels over de standaardregels.
     * @param {object[]} defaults standaardregels
     * @param {object[]} ownRows eigen regels
     * @returns {object[]} de actieve regels met hun bron
     */
    const pick = (defaults, ownRows) => {
      const map = new Map(defaults.map((row) => [row.key, { ...row, source: 'standaard' }]));
      for (const row of ownRows || []) map.set(row.key, { ...row, source: 'eigen' });
      return [...map.values()].filter((row) => row.active !== false);
    };
    return { bodies: pick(DEFAULT_BODIES, ownLibrary.bodies), nozzles: pick(DEFAULT_NOZZLES, ownLibrary.nozzles) };
  }

  // ---------------------------------------------------------------- Excel

  /** Kolommen van het Excel-sjabloon per blad: [kop, veld, breedte]. */
  const SHEETS = {
    Behuizingen: [
      ['Sleutel', 'key', 18], ['Merk', 'brand', 12], ['Naam', 'name', 44], ['Artikelcode', 'code', 18],
      ['Pop-up (cm)', 'popup', 11], ['Aansluiting', 'mount', 14], ['Drukregeling (bar)', 'regBar', 17],
      ['Min. druk (bar)', 'minBar', 14], ['Max. druk (bar)', 'maxBar', 14], ['Prijs (€)', 'price', 10], ['Actief', 'active', 8],
    ],
    Nozzles: [
      ['Sleutel', 'key', 16], ['Merk', 'brand', 12], ['Naam', 'name', 24], ['Artikelcode', 'code', 16],
      ['Aansluiting', 'mount', 14], ['Soort', 'group', 10], ['Sproeihoeken (°)', 'arcs', 24], ['Min. worp (m)', 'rMin', 13],
      ['Inkorten (%)', 'reduce', 12], ['Werkdruk (bar)', 'bar', 13], ['Debiet per hoek', 'matched', 15], ['Prijs (€)', 'price', 10], ['Actief', 'active', 8],
    ],
    Prestaties: [['Nozzle', 'key', 16], ['Druk (bar)', 'bar', 11], ['Worp (m)', 'r', 10], ['Debiet (l/u)', 'q', 12]],
  };

  const UITLEG = [
    'Sproeierbibliotheek – zo vul je dit bestand in',
    '',
    'Behuizingen: sproeierhuizen en rotors. Aansluiting bepaalt welke nozzles passen (gelijke tekst), bijv. "sproeikop" (½" binnendraad, 1800 / Pro-Spray) of "rb5000" (Rain Bird 5000-rotor).',
    'Drukregeling: de geregelde druk van het huis in bar (leeg = geen drukregeling). De planner rekent de nozzle op die druk door.',
    'Nozzles: Soort is spray (vaste kop), rotator (MP Rotator e.d.) of rotor (turbinesproeier). Soorten worden niet in één zone gemengd.',
    'Sproeihoeken: instelbare sectoren gescheiden door ";", bijv. "90-210; 210-270; 360" (360 = vaste rondkop) of "0-360".',
    'Min. worp: zo kort is de worp met de stelschroef in te stellen. Leeg = de worp min. Inkorten (%), standaard 25%.',
    'Debiet per hoek: "ja" als het debiet meeschaalt met de sproeihoek (gelijke neerslag, MP Rotator, HE-VAN); dan staat bij Prestaties het debiet bij 360°. "nee" voor rotornozzles: dan is het debiet per nozzle.',
    'Prestaties: per nozzle één regel per druk, met worp (m) en debiet (l/u) uit de tabel van de fabrikant.',
    'Actief: "nee" verbergt een regel, ook een standaardregel met dezelfde sleutel.',
    '',
    'Bij het inlezen vervangt dit bestand alle eigen regels van de organisatie. Standaardregels met dezelfde sleutel worden overschreven.',
  ];

  /**
   * Zet de bibliotheek om naar rijen per blad (voor de Excel-export).
   * @param {{bodies: object[], nozzles: object[]}} lib de bibliotheek
   * @returns {{Behuizingen: Array<Array>, Nozzles: Array<Array>, Prestaties: Array<Array>}} rijen per blad
   */
  function toSheets(lib) {
    /**
     * Geeft de waarde van een veld zoals hij in Excel komt.
     * @param {object} row de regel
     * @param {string} field het veld
     * @returns {*} de celwaarde
     */
    const cellValue = (row, field) => {
      if (field === 'arcs') return arcsText(row.arcs);
      if (field === 'active') return row.active === false ? 'nee' : 'ja';
      if (field === 'matched') return row.matched ? 'ja' : 'nee';
      if (field === 'reduce') return row.reduce == null ? '' : Math.round(row.reduce * 100);
      return row[field] == null ? '' : row[field];
    };
    /**
     * Zet regels om naar rijen met de kolommen van een blad.
     * @param {object[]} list de regels
     * @param {Array<Array>} columns kolommen [kop, veld, breedte]
     * @returns {Array<Array>} de rijen
     */
    const rows = (list, columns) => (list || []).map((row) => columns.map(([, field]) => cellValue(row, field)));
    const perf = [];
    for (const nozzleRow of lib.nozzles || []) for (const point of nozzleRow.perf || []) perf.push([nozzleRow.key, point.bar, point.r, point.q]);
    return { Behuizingen: rows(lib.bodies, SHEETS.Behuizingen), Nozzles: rows(lib.nozzles, SHEETS.Nozzles), Prestaties: perf };
  }

  /**
   * Zet rijen per blad (eerste rij = koppen) om naar een bibliotheek, ongecontroleerd. Kolommen worden op hun kop herkend, de volgorde maakt niet uit.
   * @param {object} sheets rijen per bladnaam
   * @returns {{bodies: object[], nozzles: object[]}} de ingelezen regels
   */
  function fromSheets(sheets) {
    /**
     * Maakt een kop vergelijkbaar: kleine letters, alleen letters en cijfers.
     * @param {*} value de kop
     * @returns {string} de genormaliseerde kop
     */
    const normalize = (value) => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
    /**
     * Leest een blad naar regels met velden.
     * @param {Array<Array>} rows de rijen (eerste = koppen)
     * @param {Array<Array>} columns kolommen [kop, veld, breedte]
     * @returns {object[]} de regels
     */
    const readSheet = (rows, columns) => {
      if (!Array.isArray(rows) || !rows.length) return [];
      const head = rows[0].map(normalize);
      const columnIndexes = columns.map(([header, field]) => [field, head.indexOf(normalize(header))]).filter(([, i]) => i >= 0);
      return rows.slice(1).filter((row) => Array.isArray(row) && row.some((cell) => cell != null && String(cell).trim() !== ''))
        .map((row) => Object.fromEntries(columnIndexes.map(([field, i]) => [field, row[i]])));
    };
    const sheetsByName = sheets || {};
    const bodies = readSheet(sheetsByName.Behuizingen, SHEETS.Behuizingen);
    const nozzles = readSheet(sheetsByName.Nozzles, SHEETS.Nozzles);
    const perf = readSheet(sheetsByName.Prestaties, SHEETS.Prestaties);
    for (const nozzleRow of nozzles) {
      nozzleRow.perf = perf.filter((point) => String(point.key).trim() === String(nozzleRow.key).trim());
      if (nozzleRow.reduce != null && nozzleRow.reduce !== '') { const value = num(nozzleRow.reduce); nozzleRow.reduce = value == null ? null : value / 100; }
    }
    return { bodies, nozzles };
  }

  return { GROUPS, MOUNTS, LIMITS, DEFAULTS, SHEETS, UITLEG, perfAt, radiusRange, flowLph, parseArcs, arcsText, sanitize, merge, toSheets, fromSheets };
}));
