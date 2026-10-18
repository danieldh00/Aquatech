// Testdata voor een testomgeving: testaccounts per rol, nepklanten met een
// getekende tuin (plan met gebieden, sproeiers, systeemelementen en zones) en
// offertes in alle statussen. Alles is verzonnen; de accounts horen bij de
// testomgeving zelf en verdwijnen met "Leegmaken" of "Verwijderen".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));

// De plannerbibliotheken (zones indelen, stuklijst) in een sandbox, zoals de
// offertemodule ze in de browser laadt. Pas bij het eerste gebruik laden.
let lib = null;
function plannerLib() {
  if (lib) return lib;
  const dir = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  for (const f of ['geometry.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox);
  lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };
  return lib;
}

// Uit de sandbox (ander realm) naar gewone objecten.
const plain = (v) => JSON.parse(JSON.stringify(v));

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Sproeiers op een rechthoekig gazon, kop-aan-kop: hoeken 90°, randen 180°,
 * binnenin 360°. Hoeken in graden, 0 = naar rechts, met de klok mee (y omlaag).
 */
function lawnHeads(x0, y0, x1, y1, type, target) {
  const w = x1 - x0, h = y1 - y0;
  const nx = Math.max(1, Math.ceil(w / target - 1e-9));
  const ny = Math.max(1, Math.ceil(h / target - 1e-9));
  const dx = w / nx, dy = h / ny;
  const r = round1(Math.max(dx, dy));
  const heads = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const left = i === 0, right = i === nx, top = j === 0, bottom = j === ny;
      let start = 0, arc = 360;
      if (top && left) { start = 0; arc = 90; }
      else if (top && right) { start = 90; arc = 90; }
      else if (bottom && right) { start = 180; arc = 90; }
      else if (bottom && left) { start = 270; arc = 90; }
      else if (top) { start = 0; arc = 180; }
      else if (bottom) { start = 180; arc = 180; }
      else if (left) { start = 270; arc = 180; }
      else if (right) { start = 90; arc = 180; }
      heads.push({ type, x: round1(x0 + i * dx), y: round1(y0 + j * dy), r, arc, start });
    }
  }
  return heads;
}

/**
 * Een tuin achter een woning: terras langs het huis, gazon, optioneel een
 * border langs de zijkant, een haag achterin en een plantenbak op het terras.
 */
function garden({ name, customer, address, w, h, border = true, hedge = false, planter = false, outlet = false, level = 'expert', turbine = false }) {
  const areas = [];
  let n = 0;
  const area = (type, pts) => areas.push({ id: `a${++n}`, type, pts });
  const lawnRight = border ? w - 2.5 : w;
  area('dry', rect(0, 0, w, 3.5));
  area('lawn', rect(0, 4, lawnRight, h));
  if (border) area('bed', rect(w - 2, 4, w, h));
  if (hedge) area('hedge', rect(0, h + 0.5, w, h + 1.3));
  if (planter) area('planter', rect(w - 2.5, 0.5, w - 0.5, 1.5));
  const type = turbine ? 'rotor' : 'rotator';
  const sprinklers = lawnHeads(0, 4, lawnRight, h, type, turbine ? 11 : 6).map((s, i) => ({ id: `s${i + 1}`, ...s }));
  const elements = [
    { id: 'e1', kind: 'source', x: 0.6, y: 3.2 },
    { id: 'e2', kind: 'controller', x: 1.6, y: 0.3 },
    { id: 'e3', kind: 'valvebox', x: 1.6, y: 3.75 },
  ];
  if (outlet) elements.push({ id: 'e4', kind: 'outlet', x: round1(lawnRight / 2), y: 3.7 });
  const state = {
    version: 1,
    meta: { name, customer, address },
    settings: { pressure: 3.5, flow: turbine ? 3.0 : 2.0, level, targetMm: 20, sessions: 3, sprinklerType: type, radius: null,
      methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray' },
    areas,
    elements,
    sprinklers,
    zones: [],
  };
  // Zones zoals de planner ze automatisch indeelt (stap "Zones & leidingen").
  const st = plain(state);
  plannerLib().Hydraulics.autoZones(st);
  return plain({ ...st, calc: undefined });
}

// Woorden voor het testwachtwoord: makkelijk over te typen, geen verwarrende tekens.
const WORDS = ['gieter', 'regen', 'vijver', 'krokus', 'tulp', 'linde', 'beuk', 'klaver', 'heide', 'mos', 'varen', 'wilg', 'eik', 'berk', 'iris', 'roos'];
function newPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

// Gebruikersnamen moeten uniek zijn over het hele platform: voorvoegsel = code
// van de testomgeving (ingekort, geen gereserveerd begin).
function prefixOf(slug) {
  let p = String(slug || 'test').replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'test';
  if (/^(gast-|ha-)/.test(p) || !/^[a-z0-9]/.test(p)) p = `t${p}`.slice(0, 24);
  return p;
}

const ACCOUNTS = [
  { key: 'beheerder', suffix: 'beheerder', displayName: 'Bea Beheer (test)', role: 'beheerder' },
  { key: 'inst1', suffix: 'installateur', displayName: 'Ivo Installateur (test)', role: 'installateur' },
  { key: 'inst2', suffix: 'installateur2', displayName: 'Iris Installateur (test)', role: 'installateur' },
  { key: 'klant1', suffix: 'klant1', displayName: 'Fam. de Vries (test)', role: 'klant' },
  { key: 'klant2', suffix: 'klant2', displayName: 'Fam. Bakker (test)', role: 'klant' },
  { key: 'klant3', suffix: 'klant3', displayName: 'Dhr. en mevr. Visser (test)', role: 'klant' },
];

const CUSTOMERS = {
  klant1: { name: 'Fam. de Vries', contact: 'Petra de Vries', address: 'Molenweg 12\n8071 AB Nunspeet', email: 'devries@voorbeeld.test', phone: '0341 000 101' },
  klant2: { name: 'Fam. Bakker', contact: 'Henk Bakker', address: 'Elspeterweg 48\n8071 PC Nunspeet', email: 'bakker@voorbeeld.test', phone: '0341 000 102' },
  klant3: { name: 'Dhr. en mevr. Visser', contact: 'Anne Visser', address: 'Stationsstraat 7\n3851 NH Ermelo', email: 'visser@voorbeeld.test', phone: '0341 000 103' },
  mulder: { name: 'Fam. Mulder', contact: 'Jeroen Mulder', address: 'Zuiderzeestraatweg 220\n8096 BK Oldebroek', email: 'mulder@voorbeeld.test', phone: '0525 000 104' },
  vanberg: { name: 'Fam. van den Berg', contact: 'Sanne van den Berg', address: 'Hulshorsterweg 3\n8077 RA Hulshorst', email: 'vandenberg@voorbeeld.test', phone: '0341 000 105' },
  bos: { name: 'Vakantiepark De Veluwse Bossen', contact: 'Receptie', address: 'Bosweg 1\n8075 AA Elspeet', email: 'info@veluwsebossen.test', phone: '0577 000 106' },
};

const oneLine = (c) => `${c.address.replace(/\n/g, ', ')}`;

/**
 * De volledige testset, los van de database. slug = code van de
 * testomgeving, today = datum (voor offertedata en geldigheid).
 * Geeft { accounts, plans, quotes }; plannen en offertes verwijzen naar
 * accounts via key, offertes naar plannen via planKey.
 */
function buildTestData({ slug, profile = {}, today = new Date() }) {
  const p = prefixOf(slug);
  const accounts = ACCOUNTS.map((a) => ({ ...a, username: `${p}.${a.suffix}` }));
  const day = (offset) => {
    const d = new Date(today.getTime() - offset * 86400000);
    d.setUTCHours(9 + (offset % 7), (offset * 13) % 60, 0, 0);
    return d.toISOString();
  };
  const c = CUSTOMERS;
  const plans = [
    { key: 'devries', owner: 'inst1', at: day(34), data: garden({ name: 'Achtertuin De Vries', customer: c.klant1.name, address: oneLine(c.klant1), w: 14, h: 16, hedge: true, planter: true }) },
    { key: 'bakker', owner: 'inst1', at: day(21), data: garden({ name: 'Tuin Bakker', customer: c.klant2.name, address: oneLine(c.klant2), w: 12, h: 13, outlet: true }) },
    { key: 'visser', owner: 'inst2', at: day(17), data: garden({ name: 'Voortuin en achtertuin Visser', customer: c.klant3.name, address: oneLine(c.klant3), w: 10, h: 11, border: true, level: 'eco' }) },
    { key: 'mulder', owner: 'inst2', at: day(9), data: garden({ name: 'Tuin Mulder', customer: c.mulder.name, address: oneLine(c.mulder), w: 18, h: 20, hedge: true, level: 'premium' }) },
    { key: 'vanberg', owner: 'beheerder', at: day(5), data: garden({ name: 'Tuin Van den Berg', customer: c.vanberg.name, address: oneLine(c.vanberg), w: 9, h: 10, border: false, planter: true }) },
    { key: 'bos', owner: 'inst1', at: day(2), data: garden({ name: 'Speelweide De Veluwse Bossen', customer: c.bos.name, address: oneLine(c.bos), w: 40, h: 34, border: false, hedge: true, turbine: true, outlet: true }) },
    // Zelf getekend door een klant (nog zonder zones en offerte).
    { key: 'zelf', owner: 'klant1', at: day(1), data: (() => {
      const g = garden({ name: 'Mijn voortuin', customer: c.klant1.name, address: oneLine(c.klant1), w: 8, h: 9, border: true });
      return { ...g, zones: [], sprinklers: g.sprinklers.map(({ zone, ...s }) => s), areas: g.areas.map(({ zone, ...a }) => a) };
    })() },
  ];

  const quotes = [
    { planKey: 'devries', owner: 'inst1', customerKey: 'klant1', customer: c.klant1, status: 'akkoord', at: 30, discountPct: 5 },
    { planKey: 'bakker', owner: 'inst1', customerKey: 'klant2', customer: c.klant2, status: 'verzonden', at: 3 },
    { planKey: 'visser', owner: 'inst2', customerKey: 'klant3', customer: c.klant3, status: 'afgewezen', at: 14, layout: 'totaal' },
    { planKey: 'mulder', owner: 'inst2', customerKey: null, customer: c.mulder, status: 'verzonden', at: 6 },
    { planKey: 'bos', owner: 'inst1', customerKey: null, customer: c.bos, status: 'concept', at: 1, discountPct: 10 },
  ].map((qd) => {
    const plan = plans.find((x) => x.key === qd.planKey);
    const { lines, summary } = plain(Core.fromPlan(plan.data, plannerLib(), profile));
    const date = day(qd.at).slice(0, 10);
    const data = Core.sanitize({
      title: `Automatische beregening ${plan.data.meta.customer}`,
      date,
      validUntil: Core.addDays(date, Number(profile.validDays) || 30),
      reference: plan.data.meta.name,
      customer: qd.customer,
      intro: profile.intro || '',
      terms: profile.terms || '',
      discountPct: qd.discountPct || 0,
      layout: qd.layout || 'specificatie',
      planTitle: plan.data.meta.name,
      planSummary: summary,
      lines,
    });
    const t = Core.totals(data);
    return { ...qd, at: day(qd.at), data, totalExcl: t.net, totalIncl: t.total };
  });

  return { accounts, plans, quotes };
}

module.exports = { buildTestData, newPassword, prefixOf, garden, lawnHeads };
