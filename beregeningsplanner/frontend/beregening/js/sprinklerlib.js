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

  /** Prestatiepunten uit worp en neerslag bij de nominale druk (matched nozzles). */
  const matchedPerf = (r, pr, pts) => pts.map(([bar, fr, fq]) => ({ bar, r: round(r * fr, 1), q: Math.round(pr * r * r * fq) }));
  // MP Rotator: Hunter geeft 2,8 bar als ideale druk (PRS40-huis); bereik 2,1–3,8 bar.
  const MP = [[2.1, 0.93, 0.86], [2.8, 1, 1], [3.8, 1, 1.15]];
  // HE-VAN: nominaal 2,1 bar (1800-PRS); worp en debiet stijgen met de druk.
  const VAN = [[1.4, 0.85, 0.8], [2.1, 1, 1], [2.8, 1.06, 1.14]];

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

  const nozzle = (o) => ({ matched: true, reduce: null, ...o });
  const MP_ARCS = [[90, 210], [210, 270], [360, 360]];

  const DEFAULT_NOZZLES = [
    // Hunter MP Rotator (sleutels gelijk aan de MP-modellen in eerdere plannen)
    nozzle({ key: 'MP1000', brand: 'Hunter', name: 'MP1000', code: 'ROT-MP1000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 2.5, bar: 2.8, perf: matchedPerf(4.5, 11, MP) }),
    nozzle({ key: 'MP2000', brand: 'Hunter', name: 'MP2000', code: 'ROT-MP2000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 4.0, bar: 2.8, perf: matchedPerf(6.4, 10, MP) }),
    nozzle({ key: 'MP3000', brand: 'Hunter', name: 'MP3000', code: 'ROT-MP3000', mount: 'sproeikop', group: 'rotator', arcs: MP_ARCS, rMin: 6.7, bar: 2.8, perf: matchedPerf(9.1, 11, MP) }),
    nozzle({ key: 'MP3500', brand: 'Hunter', name: 'MP3500', code: 'ROT-MP3500', mount: 'sproeikop', group: 'rotator', arcs: [[90, 210]], rMin: 9.4, bar: 2.8, perf: matchedPerf(10.7, 10, MP) }),
    nozzle({ key: 'MPCORNER', brand: 'Hunter', name: 'MP Corner', code: 'ROT-MPCORNER', mount: 'sproeikop', group: 'rotator', arcs: [[45, 105]], rMin: 2.5, bar: 2.8, perf: matchedPerf(4.5, 11, MP) }),
    // Rain Bird HE-VAN (verstelbare sproeikop 0–360°, stelschroef tot 25% korter)
    ...[['08', 2.4], ['10', 3.0], ['12', 3.7], ['15', 4.6]].map(([n, r]) => nozzle({
      key: `HE-VAN-${n}`, brand: 'Rain Bird', name: `HE-VAN-${n}`, code: `RB-HEVAN${n}`, mount: 'sproeikop', group: 'spray',
      arcs: [[0, 360]], rMin: round(r * 0.75, 1), bar: 2.1, price: 3.9, perf: matchedPerf(r, 40, VAN),
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
    ].map(([n, pts]) => nozzle({
      key: `RB5000-${n}`, brand: 'Rain Bird', name: `Rain Curtain ${n.replace('.', ',')}`, code: '', mount: 'rb5000', group: 'rotor',
      arcs: [[40, 360]], reduce: 0.25, matched: false, bar: 3.0, perf: pts.map(([bar, r, q]) => ({ bar, r, q })),
    })),
  ];

  const DEFAULTS = { bodies: DEFAULT_BODIES, nozzles: DEFAULT_NOZZLES };

  // ---------------------------------------------------------------- hulpfuncties

  function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Worp (m) en debiet (l/u) bij druk `bar`: lineair tussen de meetpunten, buiten het bereik het dichtstbijzijnde. */
  function perfAt(n, bar) {
    const pts = (n && n.perf) || [];
    if (!pts.length) return null;
    if (bar == null || !Number.isFinite(bar)) bar = n.bar || pts[0].bar;
    if (bar <= pts[0].bar) return { r: pts[0].r, q: pts[0].q, bar: pts[0].bar };
    const last = pts[pts.length - 1];
    if (bar >= last.bar) return { r: last.r, q: last.q, bar: last.bar };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (bar <= b.bar) {
        const f = (bar - a.bar) / (b.bar - a.bar || 1);
        return { r: round(a.r + (b.r - a.r) * f, 2), q: round(a.q + (b.q - a.q) * f, 1), bar };
      }
    }
    return { r: last.r, q: last.q, bar: last.bar };
  }

  /** Kleinste en grootste worp van een nozzle bij druk `bar`. */
  function radiusRange(n, bar) {
    const p = perfAt(n, bar);
    if (!p) return null;
    const rMax = p.r;
    const rMin = n.rMin != null ? Math.min(n.rMin, rMax) : round(rMax * (1 - (n.reduce == null ? 0.25 : n.reduce)), 1);
    return { rMin, rMax };
  }

  /** Debiet (l/u) van een nozzle bij worp r, sproeihoek arc en druk bar. */
  function flowLph(n, r, arc, bar) {
    const p = perfAt(n, bar);
    if (!p) return 0;
    if (!n.matched) return p.q;
    const k = p.r > 0 && r > 0 ? Math.min(1, (r / p.r) ** 2) : 1;
    return p.q * k * (clamp(arc, 0, 360) / 360);
  }

  // ---------------------------------------------------------------- controleren

  const text = (v, max = LIMITS.text) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  };
  const yes = (v, dflt = true) => {
    if (v == null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    return !/^(nee|no|n|0|false|onwaar|uit)$/i.test(String(v).trim());
  };
  const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,59}$/;

  /** Sproeihoeken uit tekst ("90-210; 210-270; 360") of een lijst paren. */
  function parseArcs(v) {
    const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[;|]+/);
    const out = [];
    for (const part of list) {
      let lo, hi;
      if (Array.isArray(part)) [lo, hi] = [num(part[0]), num(part[1] ?? part[0])];
      else {
        const m = String(part).replace(/°/g, '').match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–]\s*(\d+(?:[.,]\d+)?))?\s*$/);
        if (!m) continue;
        lo = num(m[1]); hi = m[2] == null ? lo : num(m[2]);
      }
      if (lo == null || hi == null) continue;
      lo = clamp(Math.round(lo), 0, 360); hi = clamp(Math.round(hi), 0, 360);
      if (hi < lo) [lo, hi] = [hi, lo];
      out.push([lo, hi]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, 8);
  }
  const arcsText = (arcs) => (arcs || []).map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`)).join('; ');

  function sanitizeBody(raw, problems, where) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const key = text(r.key, 60);
    if (!KEY.test(key)) { problems.push(`${where}: sleutel ontbreekt of bevat ongeldige tekens.`); return null; }
    const regBar = num(r.regBar);
    const out = {
      key, brand: text(r.brand, 60), name: text(r.name) || key, code: text(r.code, 60),
      popup: num(r.popup), mount: text(r.mount, 40) || 'sproeikop',
      regBar: regBar != null && regBar > 0 ? round(clamp(regBar, 0.5, 10), 2) : null,
      minBar: num(r.minBar), maxBar: num(r.maxBar), price: num(r.price), active: yes(r.active),
    };
    if (out.popup != null) out.popup = clamp(Math.round(out.popup), 0, 100);
    if (out.minBar != null) out.minBar = round(clamp(out.minBar, 0, 10), 2);
    if (out.maxBar != null) out.maxBar = round(clamp(out.maxBar, 0, 12), 2);
    if (out.price != null) out.price = round(clamp(out.price, 0, 100000), 2);
    return out;
  }

  function sanitizeNozzle(raw, problems, where) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const key = text(r.key, 60);
    if (!KEY.test(key)) { problems.push(`${where}: sleutel ontbreekt of bevat ongeldige tekens.`); return null; }
    const group = text(r.group, 20).toLowerCase();
    if (!GROUPS[group]) { problems.push(`${where} (${key}): soort moet spray, rotator of rotor zijn.`); return null; }
    const arcs = parseArcs(r.arcs);
    if (!arcs.length) { problems.push(`${where} (${key}): geef de sproeihoeken, bijv. "90-210; 360".`); return null; }
    const perf = (Array.isArray(r.perf) ? r.perf : [])
      .map((p) => ({ bar: num(p && p.bar), r: num(p && p.r), q: num(p && p.q) }))
      .filter((p) => p.bar != null && p.r != null && p.q != null && p.bar > 0 && p.bar <= 12 && p.r > 0 && p.r <= 40 && p.q > 0 && p.q <= 100000)
      .map((p) => ({ bar: round(p.bar, 2), r: round(p.r, 2), q: round(p.q, 1) }))
      .sort((a, b) => a.bar - b.bar)
      .filter((p, i, all) => i === 0 || p.bar !== all[i - 1].bar)
      .slice(0, LIMITS.perf);
    if (!perf.length) { problems.push(`${where} (${key}): geen prestaties (druk, worp, debiet) gevonden.`); return null; }
    const reduce = num(r.reduce);
    const rMin = num(r.rMin);
    const bar = num(r.bar);
    return {
      key, brand: text(r.brand, 60), name: text(r.name) || key, code: text(r.code, 60),
      mount: text(r.mount, 40) || 'sproeikop', group, arcs,
      rMin: rMin != null && rMin > 0 ? round(Math.min(rMin, perf[perf.length - 1].r), 2) : null,
      reduce: reduce != null ? round(clamp(reduce > 1 ? reduce / 100 : reduce, 0, 0.9), 2) : null,
      matched: yes(r.matched, group !== 'rotor'),
      bar: bar != null && bar > 0 ? round(clamp(bar, 0.5, 10), 2) : perf[Math.floor((perf.length - 1) / 2)].bar,
      price: num(r.price) != null ? round(clamp(num(r.price), 0, 100000), 2) : null,
      active: yes(r.active),
      perf,
    };
  }

  /**
   * Controleert een (eigen) bibliotheek. Ongeldige regels vallen weg met een melding.
   * @returns {{ bodies, nozzles, problems: string[] }}
   */
  function sanitize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const problems = [];
    const seen = { bodies: new Set(), nozzles: new Set() };
    const take = (list, kind, fn, label) => (Array.isArray(list) ? list : []).slice(0, LIMITS[kind]).map((x, i) => {
      const v = fn(x, problems, `${label} ${i + 1}`);
      if (!v) return null;
      if (seen[kind].has(v.key)) { problems.push(`${label} ${i + 1}: sleutel ${v.key} komt dubbel voor.`); return null; }
      seen[kind].add(v.key);
      return v;
    }).filter(Boolean);
    const bodies = take(r.bodies, 'bodies', sanitizeBody, 'Behuizing');
    const nozzles = take(r.nozzles, 'nozzles', sanitizeNozzle, 'Nozzle');
    if (Array.isArray(r.bodies) && r.bodies.length > LIMITS.bodies) problems.push(`Maximaal ${LIMITS.bodies} behuizingen.`);
    if (Array.isArray(r.nozzles) && r.nozzles.length > LIMITS.nozzles) problems.push(`Maximaal ${LIMITS.nozzles} nozzles.`);
    return { bodies, nozzles, problems };
  }

  /** Standaard + eigen: eigen regels vervangen die met dezelfde sleutel, `active: false` haalt weg. */
  function merge(own) {
    const o = own || {};
    const pick = (defs, mine) => {
      const map = new Map(defs.map((d) => [d.key, { ...d, source: 'standaard' }]));
      for (const m of mine || []) map.set(m.key, { ...m, source: 'eigen' });
      return [...map.values()].filter((x) => x.active !== false);
    };
    return { bodies: pick(DEFAULT_BODIES, o.bodies), nozzles: pick(DEFAULT_NOZZLES, o.nozzles) };
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

  /** Bibliotheek naar rijen per blad (voor de Excel-export). */
  function toSheets(lib) {
    const val = (row, f) => {
      if (f === 'arcs') return arcsText(row.arcs);
      if (f === 'active') return row.active === false ? 'nee' : 'ja';
      if (f === 'matched') return row.matched ? 'ja' : 'nee';
      if (f === 'reduce') return row.reduce == null ? '' : Math.round(row.reduce * 100);
      return row[f] == null ? '' : row[f];
    };
    const rows = (list, cols) => (list || []).map((x) => cols.map(([, f]) => val(x, f)));
    const perf = [];
    for (const n of lib.nozzles || []) for (const p of n.perf || []) perf.push([n.key, p.bar, p.r, p.q]);
    return { Behuizingen: rows(lib.bodies, SHEETS.Behuizingen), Nozzles: rows(lib.nozzles, SHEETS.Nozzles), Prestaties: perf };
  }

  /**
   * Rijen per blad (eerste rij = koppen) naar een bibliotheek, ongecontroleerd.
   * Kolommen worden op hun kop herkend, de volgorde maakt niet uit.
   */
  function fromSheets(sheets) {
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const read = (rows, cols) => {
      if (!Array.isArray(rows) || !rows.length) return [];
      const head = rows[0].map(norm);
      const idx = cols.map(([h, f]) => [f, head.indexOf(norm(h))]).filter(([, i]) => i >= 0);
      return rows.slice(1).filter((r) => Array.isArray(r) && r.some((c) => c != null && String(c).trim() !== ''))
        .map((r) => Object.fromEntries(idx.map(([f, i]) => [f, r[i]])));
    };
    const s = sheets || {};
    const bodies = read(s.Behuizingen, SHEETS.Behuizingen);
    const nozzles = read(s.Nozzles, SHEETS.Nozzles);
    const perf = read(s.Prestaties, SHEETS.Prestaties);
    for (const n of nozzles) {
      n.perf = perf.filter((p) => String(p.key).trim() === String(n.key).trim());
      if (n.reduce != null && n.reduce !== '') { const v = num(n.reduce); n.reduce = v == null ? null : v / 100; }
    }
    return { bodies, nozzles };
  }

  return { GROUPS, MOUNTS, LIMITS, DEFAULTS, SHEETS, UITLEG, perfAt, radiusRange, flowLph, parseArcs, arcsText, sanitize, merge, toSheets, fromSheets };
}));
