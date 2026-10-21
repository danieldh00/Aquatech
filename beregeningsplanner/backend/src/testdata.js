// Testdata voor een testomgeving: testaccounts per rol, nepklanten met een
// getekende tuin (plan met gebieden, sproeiers, systeemelementen en zones) en
// offertes in alle statussen. Alles is verzonnen; de accounts horen bij de
// testomgeving zelf en verdwijnen met "Leegmaken" of "Verwijderen".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const zlib = require('zlib');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));
const WoCore = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));
const { loadArticles } = require('./shop');

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
  if (type === 'rotator') {
    // rotators met een vaste MP-kop; de eerste hoekkop is met de stelschroef iets ingekort
    const Cat = plannerLib().Catalog;
    for (const s of sprinklers) Cat.fitRotator(Object.assign(s, { model: Cat.autoRotatorModel(s.r, s.arc) }));
    sprinklers[0].r = round1(Math.max(Cat.rotatorModels[sprinklers[0].model].rMin, sprinklers[0].r * 0.9));
  }
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
  // Planner: plant werkorders in en regelt de afspraak, voert zelf niets uit.
  { key: 'planner', suffix: 'planner', displayName: 'Pim Planner (test)', role: 'planner' },
  { key: 'klant1', suffix: 'klant1', displayName: 'Fam. de Vries (test)', role: 'klant' },
  { key: 'klant2', suffix: 'klant2', displayName: 'Fam. Bakker (test)', role: 'klant' },
  { key: 'klant3', suffix: 'klant3', displayName: 'Dhr. en mevr. Visser (test)', role: 'klant' },
  // Klant met een ingeplande werkorder: zo toont het klantportaal een afspraak.
  { key: 'klant4', suffix: 'klant4', displayName: 'Fam. van den Berg (test)', role: 'klant' },
];

const CUSTOMERS = {
  klant1: { name: 'Fam. de Vries', contact: 'Petra de Vries', address: 'Molenweg 12\n8071 AB Nunspeet', email: 'devries@voorbeeld.test', phone: '0341 000 101' },
  klant2: { name: 'Fam. Bakker', contact: 'Henk Bakker', address: 'Elspeterweg 48\n8071 PC Nunspeet', email: 'bakker@voorbeeld.test', phone: '0341 000 102' },
  klant3: { name: 'Dhr. en mevr. Visser', contact: 'Anne Visser', address: 'Stationsstraat 7\n3851 NH Ermelo', email: 'visser@voorbeeld.test', phone: '0341 000 103' },
  mulder: { name: 'Fam. Mulder', contact: 'Jeroen Mulder', address: 'Zuiderzeestraatweg 220\n8096 BK Oldebroek', email: 'mulder@voorbeeld.test', phone: '0525 000 104' },
  vanberg: { name: 'Fam. van den Berg', contact: 'Sanne van den Berg', address: 'Hulshorsterweg 3\n8077 RA Hulshorst', email: 'vandenberg@voorbeeld.test', phone: '0341 000 105' },
  bos: { name: 'Vakantiepark De Veluwse Bossen', contact: 'Receptie', address: 'Bosweg 1\n8075 AA Elspeet', email: 'info@veluwsebossen.test', phone: '0577 000 106' },
  // Diende zonder account een tekening in (knop op de inlogpagina).
  jansen: { name: 'Mark Jansen', contact: 'Mark Jansen', address: 'Vierhouterweg 31\n8076 PL Vierhouten', email: 'jansen@voorbeeld.test', phone: '06 0000 7777' },
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
  // Mijn profiel: e-mail (voorbeeld.test bestaat niet), telefoon en voorkeuren;
  // de beheerder krijgt een kopie van verstuurde mail en start in de planning.
  const accounts = ACCOUNTS.map((a, i) => ({
    ...a,
    username: `${p}.${a.suffix}`,
    email: `${p}.${a.suffix}@voorbeeld.test`,
    phone: `06 0000 ${String(1000 + i * 111).slice(-4)}`,
    preferences: a.key === 'beheerder' ? { startPage: 'planning', mailCopy: true } : a.key === 'planner' ? { startPage: 'planning' } : a.key === 'klant1' ? { startPage: 'portaal' } : {},
  }));
  const day = (offset) => {
    const d = new Date(today.getTime() - offset * 86400000);
    d.setUTCHours(9 + (offset % 7), (offset * 13) % 60, 0, 0);
    return d.toISOString();
  };
  const c = CUSTOMERS;
  // review = controlestatus (concept | ter_controle | goedgekeurd); plannen
  // waar een offerte van is, zijn goedgekeurd. guest = ingediend zonder account.
  const approved = (by) => ({ status: 'goedgekeurd', by });
  const plans = [
    { key: 'devries', owner: 'inst1', at: day(34), review: approved('inst1'), data: garden({ name: 'Achtertuin De Vries', customer: c.klant1.name, address: oneLine(c.klant1), w: 14, h: 16, hedge: true, planter: true }) },
    { key: 'bakker', owner: 'inst1', at: day(21), review: approved('inst1'), data: garden({ name: 'Tuin Bakker', customer: c.klant2.name, address: oneLine(c.klant2), w: 12, h: 13, outlet: true }) },
    { key: 'visser', owner: 'inst2', at: day(17), review: approved('inst2'), data: garden({ name: 'Voortuin en achtertuin Visser', customer: c.klant3.name, address: oneLine(c.klant3), w: 10, h: 11, border: true, level: 'eco' }) },
    { key: 'mulder', owner: 'inst2', at: day(9), review: approved('inst1'), data: garden({ name: 'Tuin Mulder', customer: c.mulder.name, address: oneLine(c.mulder), w: 18, h: 20, hedge: true, level: 'premium' }) },
    { key: 'vanberg', owner: 'beheerder', at: day(5), review: approved('beheerder'), data: garden({ name: 'Tuin Van den Berg', customer: c.vanberg.name, address: oneLine(c.vanberg), w: 9, h: 10, border: false, planter: true }) },
    { key: 'bos', owner: 'inst1', at: day(2), review: approved('inst1'), data: garden({ name: 'Speelweide De Veluwse Bossen', customer: c.bos.name, address: oneLine(c.bos), w: 40, h: 34, border: false, hedge: true, turbine: true, outlet: true }) },
    // Nog niet goedgekeurd plan van een installateur.
    { key: 'smit', owner: 'inst2', at: day(3), review: { status: 'concept' }, data: garden({ name: 'Voortuin Smit (schets)', customer: 'Fam. Smit', address: 'Laan 5, 8071 CD Nunspeet', w: 7, h: 8, border: true }) },
    // Zonder account ingediend via de inlogpagina: ter controle.
    { key: 'aanvraag', guest: c.jansen, at: day(0), review: { status: 'ter_controle', via: 'openbaar', question: 'Kan dit gecontroleerd worden? Ik weet niet of de druk van mijn kraan genoeg is voor het hele gazon.' },
      data: garden({ name: `Tekening van ${c.jansen.name}`, customer: c.jansen.name, address: oneLine(c.jansen), w: 11, h: 12, border: true }) },
    // Zelf getekend door een klant (nog zonder zones en offerte), ter controle aangeboden.
    { key: 'zelf', owner: 'klant1', at: day(1), review: { status: 'ter_controle', via: 'account', question: 'Kunnen jullie kijken of dit zo klopt? Dan graag een offerte.' }, data: (() => {
      const g = garden({ name: 'Mijn voortuin', customer: c.klant1.name, address: oneLine(c.klant1), w: 8, h: 9, border: true });
      return { ...g, zones: [], sprinklers: g.sprinklers.map(({ zone, ...s }) => s), areas: g.areas.map(({ zone, ...a }) => a) };
    })() },
  ];

  // Offertes in alle statussen, met de digitale offerte erbij: share = klantlink
  // (verstuurd/bekeken), response = reactie van de klant (akkoord met naam,
  // handtekening en gekozen opties, of afgewezen met reden), workorder =
  // werkorder bij een geaccordeerde offerte (planned = over zoveel dagen,
  // appointment = reactie van de klant op de afspraaklink). Dagen zijn
  // verder "zoveel dagen geleden".
  const quotes = [
    { planKey: 'devries', owner: 'inst1', customerKey: 'klant1', customer: c.klant1, status: 'akkoord', at: 34, discountPct: 5,
      options: ['rain', 'service'],
      share: { sent: 33, views: 4, lastView: 31 },
      response: { answer: 'akkoord', name: 'Petra de Vries', at: 31, via: 'account', options: ['rain'] },
      workorder: { status: 'gereed', assignee: 'inst1', planned: -24, done: 1, picked: 1, notes: 'Opgeleverd en met de klant doorgelopen; computer ingesteld op 3 beurten per week.',
        photos: [
          { kind: 'voor', caption: 'Uitgezet: sleuven en sproeierposities gemarkeerd' },
          { kind: 'tijdens', caption: 'Leidingen gelegd, sleuven nog open', visible: false },
          { kind: 'oplevering', caption: 'Gazon met alle sproeiers, bereik getest' },
          { kind: 'oplevering', caption: 'Ventielkast dicht en op niveau' },
        ],
        appointment: { answer: 'bevestigd', name: 'Petra de Vries', at: 27 } } },
    { planKey: 'bakker', owner: 'inst1', customerKey: 'klant2', customer: c.klant2, status: 'verzonden', at: 3,
      options: ['rain', 'soil', 'service'], share: { sent: 3, views: 2, lastView: 1 } },
    { planKey: 'visser', owner: 'inst2', customerKey: 'klant3', customer: c.klant3, status: 'afgewezen', at: 17, layout: 'totaal',
      share: { sent: 16, views: 3, lastView: 14 },
      response: { answer: 'afgewezen', name: 'Anne Visser', at: 14, via: 'link', reason: 'We kiezen dit jaar voor alleen een druppelslang in de border.' } },
    { planKey: 'mulder', owner: 'inst2', customerKey: null, customer: c.mulder, status: 'akkoord', at: 9,
      options: ['service'], share: { sent: 9, views: 2, lastView: 7 },
      response: { answer: 'akkoord', name: 'Jeroen Mulder', at: 7, via: 'link', options: ['service'] },
      workorder: { status: 'bezig', assignee: 'inst2', planned: 0, days: 2, endTime: '16:30', done: 0.4, picked: 0.8, notes: 'Hond loopt los in de tuin; poort aan de zijkant gebruiken.',
        photos: [{ kind: 'voor', caption: 'Situatie bij aankomst' }, { kind: 'tijdens', caption: 'Hoofdleiding ligt, zijtakken volgen' }],
        appointment: { answer: 'bevestigd', name: 'Jeroen Mulder' } } },
    { planKey: 'vanberg', owner: 'beheerder', customerKey: 'klant4', customer: c.vanberg, status: 'akkoord', at: 5,
      share: { sent: 5, views: 1, lastView: 4 },
      response: { answer: 'akkoord', name: 'Sanne van den Berg', at: 4, via: 'link' },
      workorder: { status: 'gepland', assignee: 'inst1', planned: 8, endTime: '12:00', done: 0, picked: 0,
        appointment: { answer: 'ander_moment', name: 'Sanne van den Berg', reason: 'Die week zijn wij op vakantie; de week erna kan elke ochtend.' },
        // Uitbesteed aan iedereen die opdrachten ontvangt (andere testomgevingen).
        outsource: { message: 'Wij zitten die weken vol. Wie kan deze klus overnemen? Materiaal kan bij ons worden opgehaald.', fee: 395 } } },
    { planKey: 'bos', owner: 'inst1', customerKey: null, customer: c.bos, status: 'concept', at: 1, discountPct: 10, options: ['soil'] },
  ].map((qd) => {
    const plan = plans.find((x) => x.key === qd.planKey);
    const { lines, summary } = plain(Core.fromPlan(plan.data, plannerLib(), profile));
    for (const key of qd.options || []) lines.push({ ...OPTIONS[key], id: `opt-${key}`, optional: true, selected: false });
    const date = day(qd.at).slice(0, 10);
    // Geaccordeerde offertes moeten op het moment van akkoord nog geldig zijn.
    const validDays = Math.max(Number(profile.validDays) || 30, qd.at + 14);
    const data = Core.sanitize({
      title: `Automatische beregening ${plan.data.meta.customer}`,
      date,
      validUntil: Core.addDays(date, validDays),
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

  // Webshop: een nep-WooCommerce-winkel met de artikelen van de catalogus.
  // De meeste koppelen via sku = code, een paar via het productveld
  // aquatech_code of een handmatige koppeling, een paar staan niet in de shop.
  const shop = testShop();

  // Nieuws: berichten van de beheerder (at = dagen geleden), één ook voor klanten.
  const news = [
    { at: 12, title: 'Welkom op de nieuwspagina', audience: 'iedereen', pinned: true,
      body: 'Hier vind je voortaan berichten van ons en een overzicht van wat er nieuw is in de app.\n\nVragen? Bel of mail gerust.' },
    { at: 6, title: 'Nieuwe druppelslang op voorraad', audience: 'medewerkers', pinned: false,
      body: 'De nieuwe druppelslang (16 mm, 33 cm) ligt in het magazijn. Gebruik die voortaan bij beplanting.\nDe oude rollen gaan eerst op.' },
    { at: 1, title: 'Teamoverleg vrijdag 8:00', audience: 'medewerkers', pinned: false,
      body: 'Vrijdag om 8:00 kort overleg in de werkplaats over de planning van het voorjaar. Koffie staat klaar.' },
  ];
  // AI-kosten: plannen die de afgelopen weken met AI zijn herkend (Beheer >
  // AI-kosten). Verbruik zoals de AI-dienst het opgeeft; één weigering, één
  // keer een ander model en één verzoek van een klant.
  const aiUsage = [
    { at: 33, user: 'inst1', model: 'claude-opus-5-5', input: 3120, output: 9480, ms: 41200, areas: 7, width: 1600, height: 1200 },
    { at: 27, user: 'inst1', model: 'claude-opus-5-5', input: 2890, output: 7310, ms: 35800, areas: 5, width: 1400, height: 1000 },
    { at: 20, user: 'inst2', model: 'claude-opus-5-5', input: 3340, output: 11820, ms: 52400, areas: 9, width: 2000, height: 1500 },
    { at: 16, user: 'inst2', model: 'claude-opus-5-5', input: 3010, output: 2210, ms: 14100, status: 'refusal', width: 1200, height: 900 },
    { at: 12, user: 'beheerder', model: 'claude-sonnet-5-5', input: 2760, output: 6020, ms: 22900, areas: 6, width: 1500, height: 1100 },
    { at: 8, user: 'inst2', model: 'claude-opus-5-5', input: 3480, output: 12940, ms: 58300, areas: 11, width: 2200, height: 1600 },
    { at: 6, user: 'klant1', model: 'claude-opus-5-5', input: 2650, output: 5880, ms: 27600, areas: 4, width: 1280, height: 960 },
    { at: 4, user: 'beheerder', model: 'claude-opus-5-5', input: 3200, output: 8740, ms: 39100, areas: 8, width: 1800, height: 1300 },
    { at: 1, user: 'inst1', model: 'claude-opus-5-5', input: 2980, output: 10230, ms: 46700, areas: 10, width: 1700, height: 1250 },
  ];
  // Herkende plannen (recognitions.js): bewaarde AI-herkenningen met de
  // kleurtellingen waarvan de lokale herkenning leert. Vakjes volgens
  // localrecog.js featureKey: lichtgroen egaal = gazon, donkergroen = haag,
  // gevlekt groen = beplanting, grijs = bestrating, wit = papier.
  const bins = (lawn) => ({ 918: [0, lawn, 0, 0, 0, 0], 268: [0, 0, 900, 0, 0, 0],
    872: [10, 30, 0, 700, 0, 0], 876: [20, 0, 0, 0, 1200, 0], 1533: [9000, 0, 0, 0, 0, 0] });
  const recognitions = [
    { at: 33, user: 'inst1', areas: 7, lawn: 4200 },
    { at: 20, user: 'inst2', areas: 9, lawn: 5100 },
    { at: 4, user: 'beheerder', areas: 8, lawn: 3900 },
  ].map((r, i) => ({ ...r, hash: crypto.createHash('sha256').update(`testdata:${slug}:${i}`).digest('hex'), samples: { v: 1, bins: bins(r.lawn) } }));
  return { accounts, plans, quotes, shop, news, aiUsage, recognitions, day };
}

// Opties die de klant zelf kan aanvinken.
const OPTIONS = {
  rain: { section: 'materiaal', code: 'SEN-RAIN', description: 'Regensensor (beregening slaat over bij regen)', qty: 1, unit: 'st', price: 39, vat: 21 },
  soil: { section: 'materiaal', code: 'SEN-SOIL', description: 'Bodemvochtsensor voor het gazon', qty: 1, unit: 'st', price: 119, vat: 21 },
  service: { section: 'arbeid', code: '', description: 'Onderhoudsbeurt voorjaar en winterklaar maken (eerste jaar)', qty: 1, unit: 'post', price: 145, vat: 21 },
};

const SHOP_URL = 'https://webshop.voorbeeld.test';
function testShop() {
  const arts = loadArticles();
  const codes = Object.keys(arts);
  const mapping = {};
  const products = [];
  codes.forEach((code, i) => {
    if (i % 11 === 10) return; // niet in de webshop
    const a = arts[code];
    // Webshopprijs (excl. btw) iets anders dan de catalogusprijs.
    const price = Math.round(a.price * (1.08 + (i % 5) * 0.03) * 100) / 100;
    const slug = code.toLowerCase();
    const p = { id: String(1000 + i), sku: code, name: a.name, price, currency: 'EUR', url: `${SHOP_URL}/product/${slug}/`, image: '',
      inStock: i % 9 !== 4, code: '', categories: [code.split('-')[0]] };
    if (i % 7 === 3) { p.sku = `AQ-${1000 + i}`; p.code = code; } // via aquatech_code
    else if (i % 7 === 5) { p.sku = `WS${2000 + i}`; mapping[code] = p.sku; } // handmatig gekoppeld
    products.push(p);
  });
  return { source: { url: SHOP_URL, mode: 'store', pricesIncludeTax: true, vatRate: 21, mapping }, products };
}

// Een handgeschreven handtekening als PNG (data-URL), zonder bibliotheek.
function signaturePng(seed = 1) {
  const w = 240, h = 70;
  const px = Buffer.alloc((w * 4 + 1) * h);
  const dot = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const o = yy * (w * 4 + 1) + 1 + xx * 4;
      px[o] = 0x17; px[o + 1] = 0x2f; px[o + 2] = 0x5e; px[o + 3] = 255;
    }
  };
  for (let t = 0; t < 1; t += 0.0008) {
    const x = 12 + t * (w - 24);
    const y = h / 2 + Math.sin(t * (18 + seed * 3)) * 16 * (1 - t * 0.5) + Math.sin(t * 5 + seed) * 6;
    dot(x, y);
  }
  for (let t = 0; t < 1; t += 0.002) dot(30 + t * 170, h - 12 + Math.sin(t * 3) * 2);
  const crc = (buf) => zlib.crc32(buf) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Testfoto van een tuin (PNG) per fase: kale grond met uitgezette lijnen
// (voor), open sleuven met blauwe leiding (tijdens) of gazon met sproeiers en
// hun bereik (oplevering). Eenvoudige vormen, dus klein en echt te tonen.
function sitePhotoPng(kind = 'oplevering', seed = 1, w = 480, h = 320) {
  const px = Buffer.alloc((w * 3 + 1) * h);
  const set = (x, y, [r, g, b], a = 1) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = y * (w * 3 + 1) + 1 + x * 3;
    px[o] = Math.round(px[o] * (1 - a) + r * a); px[o + 1] = Math.round(px[o + 1] * (1 - a) + g * a); px[o + 2] = Math.round(px[o + 2] * (1 - a) + b * a);
  };
  const noise = (x, y) => (Math.sin(x * 12.9898 + y * 78.233 + seed * 3.1) * 43758.5453) % 1;
  const ground = kind === 'voor' ? [139, 105, 72] : [86, 150, 70];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = Math.abs(noise(x, y)) * 22 - 11;
    if (y < h * 0.22) set(x, y, [205 - y / 3, 200 - y / 3, 196 - y / 3]); // gevel
    else if (x > w * 0.78) set(x, y, [176 + n / 2, 172 + n / 2, 166 + n / 2]); // pad
    else set(x, y, ground.map((c) => c + n + (kind === 'voor' ? 0 : ((x + y) % 18 < 9 ? 6 : -4))));
  }
  const line = (x0, y0, x1, y1, col, width) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t <= len; t += 0.5) {
      const x = x0 + ((x1 - x0) * t) / len, y = y0 + ((y1 - y0) * t) / len;
      for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) if (dx * dx + dy * dy <= width * width) set(Math.round(x + dx), Math.round(y + dy), col);
    }
  };
  const disc = (cx, cy, r, col, a = 1) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, col, a);
  };
  const heads = [[40, 90], [w * 0.38, 90], [w * 0.74, 90], [40, h - 20], [w * 0.38, h - 20], [w * 0.74, h - 20]];
  const trench = [[40, 90, w * 0.74, 90], [40, h - 20, w * 0.74, h - 20], [w * 0.38, 90, w * 0.38, h - 20], [w * 0.74, 90, w * 0.74, h - 20]];
  if (kind === 'voor') {
    for (const [x0, y0, x1, y1] of trench) for (let t = 0; t < 1; t += 0.04) line(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, x0 + (x1 - x0) * (t + 0.02), y0 + (y1 - y0) * (t + 0.02), [250, 250, 250], 1);
    for (const [x, y] of heads) line(x, y - 14, x, y + 2, [230, 120, 30], 2);
  } else if (kind === 'tijdens') {
    for (const [x0, y0, x1, y1] of trench) line(x0, y0, x1, y1, [110, 80, 52], 9);
    for (const [x0, y0, x1, y1] of trench) line(x0, y0, x1, y1, [30, 90, 200], 2);
    for (const [x, y] of heads) disc(x, y, 6, [40, 40, 40]);
    disc(w * 0.86, h * 0.5, 22, [40, 70, 50]); // ventielkast
  } else {
    for (const [x, y] of heads) disc(x, y, 86, [150, 210, 255], 0.22);
    for (const [x, y] of heads) { disc(x, y, 7, [35, 35, 35]); disc(x, y, 3, [120, 120, 120]); }
    disc(w * 0.86, h * 0.5, 22, [40, 70, 50]);
    disc(w * 0.86, h * 0.5, 16, [60, 95, 70]);
  }
  const crc = (buf) => zlib.crc32(buf) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Het deel van de testdata dat via de echte opslaglogica loopt (zodat het
 * precies zo is als wanneer iemand het in de app doet): klantlinks, reacties
 * van klanten, werkorders en de webshop. Draait na store.seedEnvironment.
 * stores = { db, quotes, workorders, shop, settings } (settings van de
 * testomgeving); seeded = { users, quoteIds } uit seedEnvironment.
 * shareBase = adres van openbaar/offerte.html (uit de browser); zonder komen
 * er geen klantlinks (de afspraaklink staat ernaast: openbaar/afspraak.html).
 */
function seedFeatures(stores, set, seeded, { shareBase = null } = {}) {
  const { db, quotes, workorders, shop, settings, photos, outsourcing, news, aiUsage, recognitions, stock } = stores;
  const q = (sql) => db.prepare(sql);
  const counts = { links: 0, responses: 0, workOrders: 0, appointmentLinks: 0, appointments: 0, photos: 0, products: 0, offers: 0, news: 0, aiRequests: 0, recognitions: 0, stockItems: 0, stockMovements: 0, stockReservations: 0 };
  const seededWos = [];
  const apptBase = shareBase ? shareBase.replace(/offerte\.html$/, 'afspraak.html') : null;
  const today = new Date().toISOString().slice(0, 10);
  const dateIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  set.quotes.forEach((spec, i) => {
    const id = seeded.quoteIds[i];
    const owner = seeded.users[spec.owner];
    if (spec.share) {
      if (shareBase && !quotes.share(owner, id, shareBase).error) counts.links++;
      const s = spec.share;
      q('UPDATE quotes SET shared_at = ?, sent_at = ?, sent_to = ?, view_count = ?, viewed_at = ?, last_viewed_at = ? WHERE id = ?')
        .run(shareBase ? set.day(s.sent) : null, set.day(s.sent), spec.customer.email || '', s.views || 0,
          s.views ? set.day(Math.max(s.lastView, s.sent - 1)) : null, s.views ? set.day(s.lastView) : null, id);
    }
    if (spec.response) {
      const r = spec.response;
      const row = q('SELECT id, tenant_id, number, status, data, acceptance FROM quotes WHERE id = ?').get(id);
      const customer = spec.customerKey ? seeded.users[spec.customerKey] : null;
      const out = quotes.decide(row, r.answer, {
        name: r.name, terms: true, signature: signaturePng(i), reason: r.reason || '',
        options: (r.options || []).map((k) => `opt-${k}`),
      }, { via: r.via === 'account' && customer ? 'account' : 'link', userId: r.via === 'account' && customer ? customer.id : null,
        ip: '192.0.2.10', userAgent: 'Testdata (geen echte browser)' });
      if (out.error) throw new Error(`Testdata: reactie op offerte ${row.number} mislukt (${out.error})`);
      const acc = JSON.parse(q('SELECT acceptance FROM quotes WHERE id = ?').get(id).acceptance);
      acc.at = set.day(r.at);
      q('UPDATE quotes SET acceptance = ?, responded_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(acc), acc.at, acc.at, id);
      counts.responses++;
    }
    if (spec.workorder) {
      const w = spec.workorder;
      const quote = workorders.quoteOf(owner.tenant_id, id);
      const plan = set.plans.find((p) => p.key === spec.planKey);
      const data = plain(WoCore.fromQuote(quote, plan.data, plannerLib()).data);
      data.plannedDate = dateIn(w.planned);
      data.startTime = '08:00';
      data.endTime = w.endTime || '';
      data.days = w.days || 1;
      data.crew = seeded.users[w.assignee].display_name;
      data.instructions = 'Graag voor aanvang even aanbellen. Water en stroom zijn beschikbaar bij de achterdeur.';
      data.siteNotes = w.notes || '';
      const nDone = Math.round(data.steps.length * w.done);
      data.steps.forEach((st, k) => { if (k < nDone) { st.done = true; st.actualHours = st.hours ? Math.round(st.hours * 1.1 * 4) / 4 : null; } });
      const nPicked = Math.round(data.materials.length * w.picked);
      data.materials.forEach((m, k) => { m.picked = k < nPicked; });
      if (w.status === 'gereed') data.report = { notes: w.notes || '', completedOn: dateIn(w.planned + 1), signedBy: spec.response.name };
      const wo = workorders.create(owner, quote, data, { assigneeId: seeded.users[w.assignee].id });
      // Afspraaklink en de reactie van de klant (vóór de status verder gaat:
      // reageren kan alleen op een geplande klus die niet voorbij is).
      if (apptBase && !workorders.share(owner.tenant_id, wo.id, apptBase).error) counts.appointmentLinks++;
      if (w.appointment) {
        const a = w.appointment;
        const row = { id: wo.id };
        const who = { ip: '192.0.2.10', userAgent: 'Testdata (geen echte browser)', via: 'link' };
        const out = workorders.respond(row, a.answer, { name: a.name, reason: a.reason || '' }, who);
        if (out.error === 'past') {
          // Een afspraak in het verleden is toen bevestigd: zelf vastleggen.
          q('UPDATE work_orders SET appointment = ? WHERE id = ?').run(JSON.stringify([{ answer: a.answer, name: a.name, reason: a.reason || '', at: set.day(a.at),
            moment: WoCore.moment(data), ...who, forwardedFor: '', userId: null }]), wo.id);
        } else if (out.error) {
          throw new Error(`Testdata: reactie op afspraak ${wo.number} mislukt (${out.error})`);
        }
        counts.appointments++;
      }
      workorders.update(owner.tenant_id, wo.id, undefined, w.status);
      seededWos.push({ id: wo.id, status: w.status, owner, materials: data.materials, planned: w.planned });
      const at = set.day(Math.max(0, spec.response.at - 1));
      q('UPDATE work_orders SET created_at = ?, updated_at = ? WHERE id = ?').run(at, w.status === 'gereed' ? set.day(-w.planned - 1) : at, wo.id);
      counts.workOrders++;
      // Uitbesteden: versturen en ontvangen aan in de testomgeving, en deze klus aangeboden.
      if (outsourcing && w.outsource) {
        settings.update({ outsourcing: { ...settings.get('outsourcing'), send: true, receive: true } });
        const out = outsourcing.offer(owner, owner.tenant_id, wo.id, { ...w.outsource, toTenantId: null, fromName: q('SELECT name FROM tenants WHERE id = ?').get(owner.tenant_id).name });
        if (out.error) throw new Error(`Testdata: werkorder ${wo.number} uitbesteden mislukt (${out.error})`);
        q('UPDATE work_order_offers SET created_at = ?, updated_at = ? WHERE id = ?').run(set.day(1), set.day(1), out.offer.id);
        counts.offers++;
      }
      // Foto's: voor/tijdens bij werk in uitvoering, plus de oplevering als hij gereed is.
      if (photos && w.photos) {
        w.photos.forEach((p, k) => {
          const img = sitePhotoPng(p.kind, i * 10 + k);
          const out = photos.add(owner, owner.tenant_id, wo.id, { image: img.toString('base64'), thumb: sitePhotoPng(p.kind, i * 10 + k, 240, 160).toString('base64'),
            kind: p.kind, caption: p.caption, customerVisible: p.visible !== false, takenAt: `${dateIn(w.planned + (p.kind === 'oplevering' ? 1 : 0))}T${String(9 + k).padStart(2, '0')}:15:00.000Z` });
          if (out.error) throw new Error(`Testdata: foto bij werkorder ${wo.number} mislukt (${out.error})`);
          counts.photos++;
        });
      }
    }
  });
  // Nieuwsberichten van de testbeheerder, via de echte opslag.
  if (news && set.news) {
    const author = seeded.users.beheerder;
    for (const n of set.news) {
      const out = news.create(seeded.tenantId, author, n);
      if (out.error) throw new Error(`Testdata: nieuwsbericht mislukt (${out.error})`);
      q('UPDATE news SET created_at = ?, updated_at = ? WHERE id = ?').run(set.day(n.at), set.day(n.at), out.item.id);
      counts.news++;
    }
    news.forget(seeded.tenantId);
  }
  // AI-verzoeken (kostenoverzicht), via de echte opslag (kosten uitgerekend).
  if (aiUsage && set.aiUsage) {
    for (const a of set.aiUsage) {
      const id = aiUsage.record({ tenantId: seeded.tenantId, userId: seeded.users[a.user].id, feature: 'plan_analyse', model: a.model,
        status: a.status || 'ok', usage: { input_tokens: a.input, output_tokens: a.output }, durationMs: a.ms,
        eurCentsPerUsd: settings.get('aiEurCentsPerUsd'), detail: { width: a.width, height: a.height, ...(a.areas ? { areas: a.areas } : {}) } });
      q('UPDATE ai_usage SET created_at = ? WHERE id = ?').run(set.day(a.at), id);
      counts.aiRequests++;
    }
  }
  // Herkende plannen met kleurtellingen, via de echte opslag.
  if (recognitions && set.recognitions) {
    for (const r of set.recognitions) {
      const result = { scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog', evidence: 'maat 12,00 m' },
        areas: [{ type: 'lawn', name: 'Gazon', points: [{ x: 100, y: 100 }, { x: 700, y: 100 }, { x: 700, y: 500 }, { x: 100, y: 500 }] }],
        elements: [], notes: `${r.areas} vlakken (testdata)` };
      const id = recognitions.saveAi({ tenantId: seeded.tenantId, userId: seeded.users[r.user].id, hash: r.hash, model: 'claude-opus-5-5', version: 'testdata', result });
      recognitions.addSamples(seeded.tenantId, id, r.samples);
      q('UPDATE plan_recognitions SET created_at = ?, updated_at = ? WHERE id = ?').run(set.day(r.at), set.day(r.at), id);
      counts.recognitions++;
    }
  }
  // Voorraad: de artikelen van de werkorders op voorraad (op één na, die laat
  // zien hoe een artikel zonder voorraadbeheer eruitziet), een eigen artikel,
  // ontvangsten, een telling en een correctie. Een gereede werkorder heeft
  // zijn materialen afgeboekt, een werkorder in uitvoering deels; de open
  // werkorders reserveren de rest. Eén artikel komt tekort.
  if (stock && seededWos.length) {
    const tid = seeded.tenantId;
    const admin = seeded.users.beheerder;
    const need = new Map();
    for (const w of seededWos) for (const m of w.materials) if (m.code && m.qty > 0) need.set(m.code.toUpperCase(), (need.get(m.code.toUpperCase()) || 0) + m.qty);
    const codes = [...need.keys()].sort();
    const skip = codes[codes.length - 1];
    const short = codes[0];
    const imported = stock.importCatalog(tid, admin, codes.filter((c) => c !== skip));
    if (imported.error) throw new Error(`Testdata: voorraad mislukt (${imported.error})`);
    const own = stock.create(tid, admin, { code: 'EIGEN-ZAND', name: 'Straatzand (big bag, eigen inkoop)', unit: 'zak', location: 'Buitenterrein', minQty: 2, costPrice: 42.5, onHand: 5 }, { resync: false });
    if (own.error) throw new Error(`Testdata: voorraadartikel mislukt (${own.error})`);
    const items = stock.list(tid);
    items.forEach((it, k) => {
      const want = need.get(it.code) || 0;
      if (it.code === 'EIGEN-ZAND') return;
      const meta = { location: k % 2 ? 'Bus 1' : `Magazijn ${String.fromCharCode(65 + (k % 4))}${1 + (k % 5)}`, minQty: Math.ceil(want / 2), costPrice: Math.round((2 + (k % 9) * 3.15) * 100) / 100 };
      stock.update(tid, it.id, meta);
      // Genoeg voor alles, behalve het tekortartikel (half zoveel).
      const qty = it.code === short ? Math.max(1, Math.floor(want / 2)) : Math.ceil(want * 1.5) + 2;
      stock.move(tid, admin, it.id, { kind: 'ontvangst', qty, note: `Pakbon ${1000 + k}` });
    });
    const first = items.find((it) => it.code !== 'EIGEN-ZAND' && it.code !== short);
    if (first) {
      stock.move(tid, admin, first.id, { kind: 'telling', qty: Math.ceil((need.get(first.code) || 1) * 1.5) + 1, note: 'Kwartaaltelling' });
      stock.move(tid, admin, first.id, { kind: 'correctie', qty: -1, note: 'Beschadigd bij het laden' });
    }
    // Werkorders: gereed = alles afgeboekt, bezig = de helft, open = reserveren.
    for (const w of seededWos) {
      const lines = [...new Map(w.materials.filter((m) => m.code && m.qty > 0 && m.code.toUpperCase() !== skip)
        .map((m) => [m.code.toUpperCase(), m.qty])).entries()];
      if (w.status === 'gereed') {
        if (lines.length) stock.issue(tid, w.owner, w.id, lines.map(([code, qty]) => ({ code, qty })), 'Materiaal van de werkorder');
      } else if (w.status === 'bezig') {
        const half = lines.slice(0, Math.ceil(lines.length / 2));
        if (half.length) stock.issue(tid, w.owner, w.id, half.map(([code, qty]) => ({ code, qty })), 'Meegenomen naar de klus');
      }
      stock.onWorkOrderChange(tid, w.id, w.owner);
    }
    // Spreiden in de tijd: ontvangsten een maand terug, de rest rond de klus.
    q("UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND kind = 'ontvangst'").run(set.day(30), tid);
    q("UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND kind IN ('telling', 'correctie')").run(set.day(10), tid);
    for (const w of seededWos) q('UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND work_order_id = ?').run(set.day(Math.max(0, -w.planned)), tid, w.id);
    counts.stockItems = stock.list(tid).length;
    counts.stockMovements = q('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?').get(tid).n;
    counts.stockReservations = q('SELECT COUNT(*) AS n FROM stock_reservations WHERE tenant_id = ?').get(tid).n;
  }
  // Webshop alleen als de testomgeving geen eigen webshop heeft (de nepwinkel
  // van een vorige keer vullen we opnieuw).
  const url = settings.get('shopSource').url;
  if (!url || url === SHOP_URL) {
    settings.update({ shopSource: set.shop.source });
    shop.replaceProducts(seeded.tenantId, set.shop.products, `${today}T07:00:00.000Z`);
    counts.products = set.shop.products.length;
  }
  return counts;
}

module.exports = { buildTestData, seedFeatures, signaturePng, sitePhotoPng, newPassword, prefixOf, garden, lawnHeads, SHOP_URL };
