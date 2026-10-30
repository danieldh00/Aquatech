// Testdata voor een testomgeving: testaccounts per rol, nepklanten met een
// getekende tuin (plan met gebieden, sproeiers, systeemelementen en zones) en
// offertes in alle statussen. Alles is verzonnen; de accounts horen bij de
// testomgeving zelf en verdwijnen met "Leegmaken" of "Verwijderen".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const vm = require('vm');

const zlib = require('zlib');

const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));
const WoCore = require(path.join(FRONTEND_DIR, 'werkorders', 'workorder-core.js'));
const { fromOrder } = require('../webshop/shop-orders');
const InvCore = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));
const { loadArticles } = require('../webshop/shop');

// De plannerbibliotheken (zones indelen, stuklijst) in een sandbox, zoals de
// offertemodule ze in de browser laadt. Pas bij het eerste gebruik laden.
let lib = null;
const SprinklerLib = require(path.join(FRONTEND_DIR, 'beregening', 'js', 'sprinklerlib.js'));

/**
 * De plannerbibliotheken (zones indelen, stuklijst) in een sandbox, zoals de
 * offertemodule ze in de browser laadt. Pas bij het eerste gebruik geladen.
 * @returns {{ Catalog: object, Hydraulics: object, BOM: object }} De bibliotheken.
 */
function plannerLib() {
  if (lib) return lib;
  const dir = path.join(FRONTEND_DIR, 'beregening', 'js');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), sandbox);
  lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };
  return lib;
}

/**
 * Uit de sandbox (ander realm) naar gewone objecten.
 * @param {*} value Een waarde uit de sandbox.
 * @returns {*} Een gewone kopie.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Hoekpunten van een rechthoek.
 * @param {number} x0 Linkerkant (m).
 * @param {number} y0 Bovenkant (m).
 * @param {number} x1 Rechterkant (m).
 * @param {number} y1 Onderkant (m).
 * @returns {{ x: number, y: number }[]} Vier hoekpunten.
 */
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/**
 * Rondt af op één decimaal.
 * @param {number} value Het getal.
 * @returns {number} Het afgeronde getal.
 */
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Sproeiers op een rechthoekig gazon, kop-aan-kop: hoeken 90°, randen 180°,
 * binnenin 360°. Hoeken in graden, 0 = naar rechts, met de klok mee (y omlaag).
 * @param {number} x0 Linkerkant (m).
 * @param {number} y0 Bovenkant (m).
 * @param {number} x1 Rechterkant (m).
 * @param {number} y1 Onderkant (m).
 * @param {string} type Sproeiertype (rotator, rotor).
 * @param {number} target Gewenste onderlinge afstand (m).
 * @returns {object[]} De sproeiers (type, x, y, r, arc, start).
 */
function lawnHeads(x0, y0, x1, y1, type, target) {
  const width = x1 - x0, height = y1 - y0;
  const nx = Math.max(1, Math.ceil(width / target - 1e-9));
  const ny = Math.max(1, Math.ceil(height / target - 1e-9));
  const dx = width / nx, dy = height / ny;
  const radius = round1(Math.max(dx, dy));
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
      heads.push({ type, x: round1(x0 + i * dx), y: round1(y0 + j * dy), r: radius, arc, start });
    }
  }
  return heads;
}

/**
 * Een tuin achter een woning: terras langs het huis, gazon, optioneel een
 * border langs de zijkant, een haag achterin en een plantenbak op het terras.
 * @param {object} options name, customer, address, w en h (breedte en diepte in m), border, hedge, planter, outlet, level en turbine.
 * @returns {object} Een plan zoals de planner het opslaat, met zones.
 */
function garden({ name, customer, address, w: width, h: height, border = true, hedge = false, planter = false, outlet = false, level = 'expert', turbine = false }) {
  const areas = [];
  let areaCount = 0;
  /**
   * Voegt een gebied toe.
   * @param {string} type Soort gebied (lawn, bed, ...).
   * @param {object[]} pts Hoekpunten.
   * @returns {number} Aantal gebieden.
   */
  const area = (type, pts) => areas.push({ id: `a${++areaCount}`, type, pts });
  const lawnRight = border ? width - 2.5 : width;
  area('dry', rect(0, 0, width, 3.5));
  area('lawn', rect(0, 4, lawnRight, height));
  if (border) area('bed', rect(width - 2, 4, width, height));
  if (hedge) area('hedge', rect(0, height + 0.5, width, height + 1.3));
  if (planter) area('planter', rect(width - 2.5, 0.5, width - 0.5, 1.5));
  const type = turbine ? 'rotor' : 'rotator';
  const sprinklers = lawnHeads(0, 4, lawnRight, height, type, turbine ? 11 : 6).map((head, i) => ({ id: `s${i + 1}`, ...head }));
  if (type === 'rotator') {
    // rotators met een vaste MP-kop; de eerste hoekkop is met de stelschroef iets ingekort
    const Cat = plannerLib().Catalog;
    // sproeierhuis Hunter Pro-Spray PRS40 (10 cm, 2,8 bar) uit de sproeierbibliotheek
    for (const head of sprinklers) Cat.fitRotator(Object.assign(head, { body: 'HU-PROS04-PRS40', model: Cat.autoRotatorModel(head.r, head.arc) }));
    sprinklers[0].r = round1(Math.max(Cat.rotatorModels[sprinklers[0].model].rMin, sprinklers[0].r * 0.9));
  }
  // turbinesproeiers: Rain Bird 5004 met een Rain Curtain-nozzle die bij worp en hoek past
  if (turbine) for (const head of sprinklers) plannerLib().Catalog.fitHead(Object.assign(head, { body: 'RB-5004-PC' }));
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
/**
 * Een testwachtwoord van makkelijk over te typen woorden en een getal.
 * @returns {string} Het wachtwoord.
 */
function newPassword() {
  /**
   * Een willekeurig woord uit WORDS.
   * @returns {string} Het woord.
   */
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

/**
 * Gebruikersnamen moeten uniek zijn over het hele platform: voorvoegsel = code
 * van de testomgeving (ingekort, geen gereserveerd begin).
 * @param {string} slug Code van de testomgeving.
 * @returns {string} Het voorvoegsel.
 */
function prefixOf(slug) {
  let prefix = String(slug || 'test').replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'test';
  if (/^(gast-|ha-)/.test(prefix) || !/^[a-z0-9]/.test(prefix)) prefix = `t${prefix}`.slice(0, 24);
  return prefix;
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

/**
 * Het adres van een klant op één regel.
 * @param {{ address: string }} customer De klant.
 * @returns {string} Het adres.
 */
const oneLine = (customer) => `${customer.address.replace(/\n/g, ', ')}`;

/**
 * De volledige testset, los van de database. Plannen en offertes verwijzen
 * naar accounts via key, offertes naar plannen via planKey.
 * @param {{ slug: string, profile?: object, today?: Date }} options Code van de testomgeving, bedrijfsprofiel en datum (voor offertedata en geldigheid).
 * @returns {object} accounts, plans, quotes, shop, news, aiUsage, recognitions, requests, sprinklerLibrary en day().
 */
function buildTestData({ slug, profile = {}, today = new Date() }) {
  const prefix = prefixOf(slug);
  // Mijn profiel: e-mail (voorbeeld.test bestaat niet), telefoon en voorkeuren;
  // de beheerder krijgt een kopie van verstuurde mail en start in de planning.
  const accounts = ACCOUNTS.map((account, i) => ({
    ...account,
    username: `${prefix}.${account.suffix}`,
    email: `${prefix}.${account.suffix}@voorbeeld.test`,
    phone: `06 0000 ${String(1000 + i * 111).slice(-4)}`,
    preferences: account.key === 'beheerder' ? { startPage: 'planning', mailCopy: true } : account.key === 'planner' ? { startPage: 'planning' } : account.key === 'klant1' ? { startPage: 'portaal' } : {},
  }));
  /**
   * Een tijdstip zoveel dagen geleden (overdag, wisselend).
   * @param {number} offset Aantal dagen terug (negatief = vooruit).
   * @returns {string} Tijdstip als ISO-tekst.
   */
  const day = (offset) => {
    const date = new Date(today.getTime() - offset * 86400000);
    date.setUTCHours(9 + (offset % 7), (offset * 13) % 60, 0, 0);
    return date.toISOString();
  };
  const customers = CUSTOMERS;
  /**
   * Controlestatus goedgekeurd door een account.
   * @param {string} by Sleutel van het account.
   * @returns {{ status: string, by: string }} De status.
   */
  const approved = (by) => ({ status: 'goedgekeurd', by });
  const plans = [
    { key: 'devries', owner: 'inst1', at: day(34), review: approved('inst1'), data: garden({ name: 'Achtertuin De Vries', customer: customers.klant1.name, address: oneLine(customers.klant1), w: 14, h: 16, hedge: true, planter: true }) },
    { key: 'bakker', owner: 'inst1', at: day(21), review: approved('inst1'), data: garden({ name: 'Tuin Bakker', customer: customers.klant2.name, address: oneLine(customers.klant2), w: 12, h: 13, outlet: true }) },
    { key: 'visser', owner: 'inst2', at: day(17), review: approved('inst2'), data: garden({ name: 'Voortuin en achtertuin Visser', customer: customers.klant3.name, address: oneLine(customers.klant3), w: 10, h: 11, border: true, level: 'eco' }) },
    { key: 'mulder', owner: 'inst2', at: day(9), review: approved('inst1'), data: garden({ name: 'Tuin Mulder', customer: customers.mulder.name, address: oneLine(customers.mulder), w: 18, h: 20, hedge: true, level: 'premium' }) },
    { key: 'vanberg', owner: 'beheerder', at: day(5), review: approved('beheerder'), data: garden({ name: 'Tuin Van den Berg', customer: customers.vanberg.name, address: oneLine(customers.vanberg), w: 9, h: 10, border: false, planter: true }) },
    { key: 'bos', owner: 'inst1', at: day(2), review: approved('inst1'), data: garden({ name: 'Speelweide De Veluwse Bossen', customer: customers.bos.name, address: oneLine(customers.bos), w: 40, h: 34, border: false, hedge: true, turbine: true, outlet: true }) },
    // Nog niet goedgekeurd plan van een installateur.
    { key: 'smit', owner: 'inst2', at: day(3), review: { status: 'concept' }, data: garden({ name: 'Voortuin Smit (schets)', customer: 'Fam. Smit', address: 'Laan 5, 8071 CD Nunspeet', w: 7, h: 8, border: true }) },
    // Zonder account ingediend via de inlogpagina: ter controle.
    { key: 'aanvraag', guest: customers.jansen, at: day(0), review: { status: 'ter_controle', via: 'openbaar', question: 'Kan dit gecontroleerd worden? Ik weet niet of de druk van mijn kraan genoeg is voor het hele gazon.' },
      data: garden({ name: `Tekening van ${customers.jansen.name}`, customer: customers.jansen.name, address: oneLine(customers.jansen), w: 11, h: 12, border: true }) },
    // Zelf getekend door een klant (nog zonder zones en offerte), ter controle aangeboden.
    { key: 'zelf', owner: 'klant1', at: day(1), review: { status: 'ter_controle', via: 'account', question: 'Kunnen jullie kijken of dit zo klopt? Dan graag een offerte.' }, data: (() => {
      const sketch = garden({ name: 'Mijn voortuin', customer: customers.klant1.name, address: oneLine(customers.klant1), w: 8, h: 9, border: true });
      return { ...sketch, zones: [], sprinklers: sketch.sprinklers.map(({ zone, ...head }) => head), areas: sketch.areas.map(({ zone, ...area }) => area) };
    })() },
  ];

  // Offertes in alle statussen, met de digitale offerte erbij: share = klantlink
  // (verstuurd/bekeken), response = reactie van de klant (akkoord met naam,
  // handtekening en gekozen opties, of afgewezen met reden), workorder =
  // werkorder bij een geaccordeerde offerte (planned = over zoveel dagen,
  // appointment = reactie van de klant op de afspraaklink). Dagen zijn
  // verder "zoveel dagen geleden".
  const quotes = [
    { planKey: 'devries', owner: 'inst1', customerKey: 'klant1', customer: customers.klant1, status: 'akkoord', at: 34, discountPct: 5,
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
    { planKey: 'bakker', owner: 'inst1', customerKey: 'klant2', customer: customers.klant2, status: 'verzonden', at: 3,
      options: ['rain', 'soil', 'service'], share: { sent: 3, views: 2, lastView: 1 } },
    { planKey: 'visser', owner: 'inst2', customerKey: 'klant3', customer: customers.klant3, status: 'afgewezen', at: 17, layout: 'totaal',
      share: { sent: 16, views: 3, lastView: 14 },
      response: { answer: 'afgewezen', name: 'Anne Visser', at: 14, via: 'link', reason: 'We kiezen dit jaar voor alleen een druppelslang in de border.' } },
    { planKey: 'mulder', owner: 'inst2', customerKey: null, customer: customers.mulder, status: 'akkoord', at: 9,
      options: ['service'], share: { sent: 9, views: 2, lastView: 7 },
      response: { answer: 'akkoord', name: 'Jeroen Mulder', at: 7, via: 'link', options: ['service'] },
      workorder: { status: 'bezig', assignee: 'inst2', planned: 0, days: 2, endTime: '16:30', done: 0.4, picked: 0.8, notes: 'Hond loopt los in de tuin; poort aan de zijkant gebruiken.',
        photos: [{ kind: 'voor', caption: 'Situatie bij aankomst' }, { kind: 'tijdens', caption: 'Hoofdleiding ligt, zijtakken volgen' }],
        appointment: { answer: 'bevestigd', name: 'Jeroen Mulder' } } },
    { planKey: 'vanberg', owner: 'beheerder', customerKey: 'klant4', customer: customers.vanberg, status: 'akkoord', at: 5,
      share: { sent: 5, views: 1, lastView: 4 },
      response: { answer: 'akkoord', name: 'Sanne van den Berg', at: 4, via: 'link' },
      workorder: { status: 'gepland', assignee: 'inst1', planned: 8, endTime: '12:00', done: 0, picked: 0,
        appointment: { answer: 'ander_moment', name: 'Sanne van den Berg', reason: 'Die week zijn wij op vakantie; de week erna kan elke ochtend.' },
        // Uitbesteed aan iedereen die opdrachten ontvangt (andere testomgevingen).
        outsource: { message: 'Wij zitten die weken vol. Wie kan deze klus overnemen? Materiaal kan bij ons worden opgehaald.', fee: 395 } } },
    { planKey: 'bos', owner: 'inst1', customerKey: null, customer: customers.bos, status: 'concept', at: 1, discountPct: 10, options: ['soil'] },
  ].map((quoteSpec) => {
    const plan = plans.find((candidate) => candidate.key === quoteSpec.planKey);
    const { lines, summary } = plain(Core.fromPlan(plan.data, plannerLib(), profile));
    for (const key of quoteSpec.options || []) lines.push({ ...OPTIONS[key], id: `opt-${key}`, optional: true, selected: false });
    const date = day(quoteSpec.at).slice(0, 10);
    // Geaccordeerde offertes moeten op het moment van akkoord nog geldig zijn.
    const validDays = Math.max(Number(profile.validDays) || 30, quoteSpec.at + 14);
    const data = Core.sanitize({
      title: `Automatische beregening ${plan.data.meta.customer}`,
      date,
      validUntil: Core.addDays(date, validDays),
      reference: plan.data.meta.name,
      customer: quoteSpec.customer,
      intro: profile.intro || '',
      terms: profile.terms || '',
      discountPct: quoteSpec.discountPct || 0,
      layout: quoteSpec.layout || 'specificatie',
      planTitle: plan.data.meta.name,
      planSummary: summary,
      lines,
    });
    const totals = Core.totals(data);
    return { ...quoteSpec, at: day(quoteSpec.at), data, totalExcl: totals.net, totalIncl: totals.total };
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
  /**
   * Kleurtellingen voor een herkend plan. Vakjes volgens localrecog.js
   * featureKey: lichtgroen egaal = gazon, donkergroen = haag, gevlekt groen =
   * beplanting, grijs = bestrating, wit = papier.
   * @param {number} lawn Telling voor het gazonvakje.
   * @returns {object} Tellingen per vakje.
   */
  const bins = (lawn) => ({ 918: [0, lawn, 0, 0, 0, 0], 268: [0, 0, 900, 0, 0, 0],
    872: [10, 30, 0, 700, 0, 0], 876: [20, 0, 0, 0, 1200, 0], 1533: [9000, 0, 0, 0, 0, 0] });
  const recognitions = [
    { at: 33, user: 'inst1', areas: 7, lawn: 4200 },
    { at: 20, user: 'inst2', areas: 9, lawn: 5100 },
    { at: 4, user: 'beheerder', areas: 8, lawn: 3900 },
  ].map((recognition, i) => ({ ...recognition, hash: crypto.createHash('sha256').update(`testdata:${slug}:${i}`).digest('hex'), samples: { v: 1, bins: bins(recognition.lawn) } }));
  // Meldingen van klanten via het portaal (service-requests.js): installation =
  // planKey van de offerte met de werkorder waar het om gaat, photos = aantal
  // foto's van de klant, workorder = er is al een werkorder van gemaakt.
  const requests = [
    { customer: 'klant1', at: 1, kind: 'storing', urgent: true, installation: 'devries', status: 'nieuw', photos: 2,
      subject: 'Sproeiers bij de border gaan niet meer aan',
      description: 'Sinds gisteren gaan de sproeiers langs de border niet meer aan. Het gazon krijgt wel water. Op de computer staat zone 2 te knipperen.',
      preferred: 'Liefst deze week, \'s ochtends' },
    { customer: 'klant1', at: 8, kind: 'onderhoud', installation: 'devries', status: 'ingepland', photos: 1, handler: 'planner',
      subject: 'Installatie winterklaar maken', description: 'Graag de beregening winterklaar maken (leegblazen) voordat het gaat vriezen.',
      preferred: 'Tweede helft november', reply: 'Wij komen de installatie winterklaar maken. U krijgt een afspraakvoorstel in uw portaal.',
      workorder: { assignee: 'inst2', planned: 12 } },
    { customer: 'klant4', at: 3, kind: 'overig', status: 'in_behandeling', handler: 'beheerder',
      subject: 'Extra sproeier bij het terras?', description: 'Kan er bij de aanleg ook een sproeier bij het nieuwe terras worden geplaatst? Daar is het gras altijd droog.',
      reply: 'Dat kan. We nemen het mee bij de aanleg en sturen u een kleine aanvulling op de offerte.', note: 'Eén rotator en circa 4 m leiding extra; aanvulling offerte maken.' },
    { customer: 'klant2', at: 20, kind: 'storing', status: 'afgehandeld', handler: 'inst1',
      subject: 'Lekt water bij de buitenkraan', description: 'Bij de buitenkraan aan de achterkant staat steeds een plas water, ook als de beregening uit staat.',
      reply: 'Dit zat in de kraan zelf en niet in de beregening; de pakking is vervangen. Laat het weten als het weer gebeurt.' },
  ];
  // Eigen sproeierbibliotheek (Beheer > Sproeiers): wat een organisatie zelf inleest.
  const sprinklerLibrary = {
    bodies: [{ key: 'EIGEN-POP20-PRS', brand: 'Eigen', name: 'Pop-up 20 cm met drukregeling 2,8 bar', code: 'EIGEN-POP20-PRS', popup: 20, mount: 'sproeikop', regBar: 2.8, minBar: 2.1, maxBar: 4.8, price: 11.5 }],
    nozzles: [{ ...SprinklerLib.DEFAULTS.nozzles.find((nozzle) => nozzle.key === 'MP3000'), price: 10.25 }],
  };

  return { accounts, plans, quotes, shop, news, aiUsage, recognitions, requests, sprinklerLibrary, day };
}

// Opties die de klant zelf kan aanvinken.
const OPTIONS = {
  rain: { section: 'materiaal', code: 'SEN-RAIN', description: 'Regensensor (beregening slaat over bij regen)', qty: 1, unit: 'st', price: 39, vat: 21 },
  soil: { section: 'materiaal', code: 'SEN-SOIL', description: 'Bodemvochtsensor voor het gazon', qty: 1, unit: 'st', price: 119, vat: 21 },
  service: { section: 'arbeid', code: '', description: 'Onderhoudsbeurt voorjaar en winterklaar maken (eerste jaar)', qty: 1, unit: 'post', price: 145, vat: 21 },
};

const SHOP_URL = 'https://webshop.voorbeeld.test';
/**
 * Een nep-WooCommerce-winkel met de artikelen van de catalogus. De meeste
 * koppelen via sku = code, een paar via het veld aquatech_code of handmatig,
 * een paar staan niet in de shop.
 * @returns {{ source: object, products: object[] }} Instelling shopSource en de producten.
 */
function testShop() {
  const articles = loadArticles();
  const codes = Object.keys(articles);
  const mapping = {};
  const products = [];
  codes.forEach((code, i) => {
    if (i % 11 === 10) return; // niet in de webshop
    const article = articles[code];
    // Webshopprijs (excl. btw) iets anders dan de catalogusprijs.
    const price = Math.round(article.price * (1.08 + (i % 5) * 0.03) * 100) / 100;
    const slug = code.toLowerCase();
    const product = { id: String(1000 + i), sku: code, name: article.name, price, currency: 'EUR', url: `${SHOP_URL}/product/${slug}/`, image: '',
      inStock: i % 9 !== 4, code: '', categories: [code.split('-')[0]] };
    if (i % 7 === 3) { product.sku = `AQ-${1000 + i}`; product.code = code; } // via aquatech_code
    else if (i % 7 === 5) { product.sku = `WS${2000 + i}`; mapping[code] = product.sku; } // handmatig gekoppeld
    products.push(product);
  });
  return { source: { url: SHOP_URL, mode: 'store', pricesIncludeTax: true, vatRate: 21, mapping }, products };
}

/**
 * Bouwt een PNG-bestand uit ruwe pixelregels (zonder bibliotheek).
 * @param {number} width Breedte in pixels.
 * @param {number} height Hoogte in pixels.
 * @param {number} colorType 2 = RGB, 6 = RGBA (8 bits per kanaal).
 * @param {Buffer} pixels Per regel een filterbyte (0) en dan de pixels.
 * @param {object} [deflateOptions] Opties voor zlib.deflateSync.
 * @returns {Buffer} Het PNG-bestand.
 */
function pngFile(width, height, colorType, pixels, deflateOptions = {}) {
  /**
   * Eén PNG-blok: lengte, type, data en CRC.
   * @param {string} type Bloktype (IHDR, IDAT, IEND).
   * @param {Buffer} data De inhoud.
   * @returns {Buffer} Het blok.
   */
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(zlib.crc32(typeAndData) >>> 0);
    return Buffer.concat([length, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels, deflateOptions)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Een handgeschreven handtekening als PNG (data-URL), zonder bibliotheek.
 * @param {number} [seed] Varieert de vorm.
 * @returns {string} De data-URL.
 */
function signaturePng(seed = 1) {
  const imageWidth = 240, imageHeight = 70;
  const px = Buffer.alloc((imageWidth * 4 + 1) * imageHeight);
  /**
   * Zet een stip van 3x3 pixels in navy.
   * @param {number} x Horizontale positie.
   * @param {number} y Verticale positie.
   * @returns {void}
   */
  const dot = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
      if (xx < 0 || yy < 0 || xx >= imageWidth || yy >= imageHeight) continue;
      const offset = yy * (imageWidth * 4 + 1) + 1 + xx * 4;
      px[offset] = 0x17; px[offset + 1] = 0x2f; px[offset + 2] = 0x5e; px[offset + 3] = 255;
    }
  };
  for (let progress = 0; progress < 1; progress += 0.0008) {
    const x = 12 + progress * (imageWidth - 24);
    const y = imageHeight / 2 + Math.sin(progress * (18 + seed * 3)) * 16 * (1 - progress * 0.5) + Math.sin(progress * 5 + seed) * 6;
    dot(x, y);
  }
  for (let progress = 0; progress < 1; progress += 0.002) dot(30 + progress * 170, imageHeight - 12 + Math.sin(progress * 3) * 2);
  return `data:image/png;base64,${pngFile(imageWidth, imageHeight, 6, px).toString('base64')}`;
}

/**
 * Testfoto van een tuin (PNG) per fase: kale grond met uitgezette lijnen
 * (voor), open sleuven met blauwe leiding (tijdens) of gazon met sproeiers en
 * hun bereik (oplevering). Eenvoudige vormen, dus klein en echt te tonen.
 * @param {string} [kind] voor, tijdens of oplevering.
 * @param {number} [seed] Varieert de ruis.
 * @param {number} [imageWidth] Breedte in pixels.
 * @param {number} [imageHeight] Hoogte in pixels.
 * @returns {Buffer} Het PNG-bestand.
 */
function sitePhotoPng(kind = 'oplevering', seed = 1, imageWidth = 480, imageHeight = 320) {
  const px = Buffer.alloc((imageWidth * 3 + 1) * imageHeight);
  /**
   * Kleurt een pixel, eventueel half doorzichtig over wat er al staat.
   * @param {number} x Horizontale positie.
   * @param {number} y Verticale positie.
   * @param {number[]} color Rood, groen en blauw (0-255).
   * @param {number} [alpha] Dekking (0-1).
   * @returns {void}
   */
  const set = (x, y, [red, green, blue], alpha = 1) => {
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return;
    const offset = y * (imageWidth * 3 + 1) + 1 + x * 3;
    px[offset] = Math.round(px[offset] * (1 - alpha) + red * alpha); px[offset + 1] = Math.round(px[offset + 1] * (1 - alpha) + green * alpha); px[offset + 2] = Math.round(px[offset + 2] * (1 - alpha) + blue * alpha);
  };
  /**
   * Vaste ruis per pixel.
   * @param {number} x Horizontale positie.
   * @param {number} y Verticale positie.
   * @returns {number} Waarde tussen -1 en 1.
   */
  const noise = (x, y) => (Math.sin(x * 12.9898 + y * 78.233 + seed * 3.1) * 43758.5453) % 1;
  const ground = kind === 'voor' ? [139, 105, 72] : [86, 150, 70];
  for (let y = 0; y < imageHeight; y++) for (let x = 0; x < imageWidth; x++) {
    const variation = Math.abs(noise(x, y)) * 22 - 11;
    if (y < imageHeight * 0.22) set(x, y, [205 - y / 3, 200 - y / 3, 196 - y / 3]); // gevel
    else if (x > imageWidth * 0.78) set(x, y, [176 + variation / 2, 172 + variation / 2, 166 + variation / 2]); // pad
    else set(x, y, ground.map((channel) => channel + variation + (kind === 'voor' ? 0 : ((x + y) % 18 < 9 ? 6 : -4))));
  }
  /**
   * Tekent een dikke lijn.
   * @param {number} x0 Begin x.
   * @param {number} y0 Begin y.
   * @param {number} x1 Eind x.
   * @param {number} y1 Eind y.
   * @param {number[]} col Kleur (RGB).
   * @param {number} width Halve dikte in pixels.
   * @returns {void}
   */
  const line = (x0, y0, x1, y1, col, width) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let distance = 0; distance <= len; distance += 0.5) {
      const x = x0 + ((x1 - x0) * distance) / len, y = y0 + ((y1 - y0) * distance) / len;
      for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) if (dx * dx + dy * dy <= width * width) set(Math.round(x + dx), Math.round(y + dy), col);
    }
  };
  /**
   * Tekent een gevulde cirkel.
   * @param {number} cx Middelpunt x.
   * @param {number} cy Middelpunt y.
   * @param {number} radius Straal in pixels.
   * @param {number[]} col Kleur (RGB).
   * @param {number} [alpha] Dekking (0-1).
   * @returns {void}
   */
  const disc = (cx, cy, radius, col, alpha = 1) => {
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) for (let x = Math.floor(cx - radius); x <= cx + radius; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) set(x, y, col, alpha);
  };
  const heads = [[40, 90], [imageWidth * 0.38, 90], [imageWidth * 0.74, 90], [40, imageHeight - 20], [imageWidth * 0.38, imageHeight - 20], [imageWidth * 0.74, imageHeight - 20]];
  const trench = [[40, 90, imageWidth * 0.74, 90], [40, imageHeight - 20, imageWidth * 0.74, imageHeight - 20], [imageWidth * 0.38, 90, imageWidth * 0.38, imageHeight - 20], [imageWidth * 0.74, 90, imageWidth * 0.74, imageHeight - 20]];
  if (kind === 'voor') {
    for (const [x0, y0, x1, y1] of trench) for (let progress = 0; progress < 1; progress += 0.04) line(x0 + (x1 - x0) * progress, y0 + (y1 - y0) * progress, x0 + (x1 - x0) * (progress + 0.02), y0 + (y1 - y0) * (progress + 0.02), [250, 250, 250], 1);
    for (const [x, y] of heads) line(x, y - 14, x, y + 2, [230, 120, 30], 2);
  } else if (kind === 'tijdens') {
    for (const [x0, y0, x1, y1] of trench) line(x0, y0, x1, y1, [110, 80, 52], 9);
    for (const [x0, y0, x1, y1] of trench) line(x0, y0, x1, y1, [30, 90, 200], 2);
    for (const [x, y] of heads) disc(x, y, 6, [40, 40, 40]);
    disc(imageWidth * 0.86, imageHeight * 0.5, 22, [40, 70, 50]); // ventielkast
  } else {
    for (const [x, y] of heads) disc(x, y, 86, [150, 210, 255], 0.22);
    for (const [x, y] of heads) { disc(x, y, 7, [35, 35, 35]); disc(x, y, 3, [120, 120, 120]); }
    disc(imageWidth * 0.86, imageHeight * 0.5, 22, [40, 70, 50]);
    disc(imageWidth * 0.86, imageHeight * 0.5, 16, [60, 95, 70]);
  }
  return pngFile(imageWidth, imageHeight, 2, px, { level: 9 });
}

/**
 * Het deel van de testdata dat via de echte opslaglogica loopt (zodat het
 * precies zo is als wanneer iemand het in de app doet): klantlinks, reacties
 * van klanten, werkorders, uren, foto's, meldingen, voorraad, facturen en de
 * webshop. Draait na store.seedEnvironment.
 * @param {object} stores { db, quotes, workorders, shop, settings (van de testomgeving), photos, worklog, outsourcing, news, aiUsage, recognitions, stock, requests, invoices, sprinklers }.
 * @param {object} testSet Uitkomst van buildTestData.
 * @param {{ users: object, quoteIds: string[], tenantId: string }} seeded Uit seedEnvironment.
 * @param {{ shareBase?: string|null }} [options] Adres van openbaar/offerte.html (uit de browser); zonder komen er geen klantlinks.
 * @returns {object} Aantallen per soort aangemaakte gegevens.
 */
function seedFeatures(stores, testSet, seeded, { shareBase = null } = {}) {
  const { db, quotes, workorders, shop, settings, photos, worklog, outsourcing, news, aiUsage, recognitions, stock, requests, invoices, sprinklers, seasonReminders } = stores;
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const counts = { links: 0, responses: 0, workOrders: 0, appointmentLinks: 0, appointments: 0, photos: 0, hours: 0, materialUsage: 0, products: 0, offers: 0, news: 0, aiRequests: 0, recognitions: 0, stockItems: 0, stockMovements: 0, stockReservations: 0, requests: 0, requestWorkOrders: 0, invoices: 0, debtors: 0, sprinklerParts: 0, seasonReminders: 0 };
  const seededWos = [];
  // Werkorder per plan (voor meldingen over die installatie).
  const woByPlan = {};
  const apptBase = shareBase ? shareBase.replace(/offerte\.html$/, 'afspraak.html') : null;
  const today = new Date().toISOString().slice(0, 10);
  /**
   * De datum over zoveel dagen.
   * @param {number} days Aantal dagen (negatief = terug).
   * @returns {string} Datum als JJJJ-MM-DD.
   */
  const dateIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  testSet.quotes.forEach((spec, i) => {
    const id = seeded.quoteIds[i];
    const owner = seeded.users[spec.owner];
    if (spec.share) {
      if (shareBase && !quotes.share(owner, id, shareBase).error) counts.links++;
      const share = spec.share;
      prepare('UPDATE quotes SET shared_at = ?, sent_at = ?, sent_to = ?, view_count = ?, viewed_at = ?, last_viewed_at = ? WHERE id = ?')
        .run(shareBase ? testSet.day(share.sent) : null, testSet.day(share.sent), spec.customer.email || '', share.views || 0,
          share.views ? testSet.day(Math.max(share.lastView, share.sent - 1)) : null, share.views ? testSet.day(share.lastView) : null, id);
    }
    if (spec.response) {
      const response = spec.response;
      const row = prepare('SELECT id, tenant_id, number, status, data, acceptance FROM quotes WHERE id = ?').get(id);
      const customer = spec.customerKey ? seeded.users[spec.customerKey] : null;
      const out = quotes.decide(row, response.answer, {
        name: response.name, terms: true, signature: signaturePng(i), reason: response.reason || '',
        options: (response.options || []).map((key) => `opt-${key}`),
      }, { via: response.via === 'account' && customer ? 'account' : 'link', userId: response.via === 'account' && customer ? customer.id : null,
        ip: '192.0.2.10', userAgent: 'Testdata (geen echte browser)' });
      if (out.error) throw new Error(`Testdata: reactie op offerte ${row.number} mislukt (${out.error})`);
      const acceptance = JSON.parse(prepare('SELECT acceptance FROM quotes WHERE id = ?').get(id).acceptance);
      acceptance.at = testSet.day(response.at);
      prepare('UPDATE quotes SET acceptance = ?, responded_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(acceptance), acceptance.at, acceptance.at, id);
      counts.responses++;
    }
    if (spec.workorder) {
      const workOrderSpec = spec.workorder;
      const quote = workorders.quoteOf(owner.tenant_id, id);
      const plan = testSet.plans.find((candidate) => candidate.key === spec.planKey);
      const data = plain(WoCore.fromQuote(quote, plan.data, plannerLib()).data);
      data.plannedDate = dateIn(workOrderSpec.planned);
      data.startTime = '08:00';
      data.endTime = workOrderSpec.endTime || '';
      data.days = workOrderSpec.days || 1;
      data.crew = seeded.users[workOrderSpec.assignee].display_name;
      data.instructions = 'Graag voor aanvang even aanbellen. Water en stroom zijn beschikbaar bij de achterdeur.';
      data.siteNotes = workOrderSpec.notes || '';
      const nDone = Math.round(data.steps.length * workOrderSpec.done);
      data.steps.forEach((step, stepIndex) => { if (stepIndex < nDone) { step.done = true; step.actualHours = step.hours ? Math.round(step.hours * 1.1 * 4) / 4 : null; } });
      const nPicked = Math.round(data.materials.length * workOrderSpec.picked);
      data.materials.forEach((material, materialIndex) => { material.picked = materialIndex < nPicked; });
      if (workOrderSpec.status === 'gereed') data.report = { notes: workOrderSpec.notes || '', completedOn: dateIn(workOrderSpec.planned + 1), signedBy: spec.response.name };
      const workOrder = workorders.create(owner, quote, data, { assigneeId: seeded.users[workOrderSpec.assignee].id });
      woByPlan[spec.planKey] = workOrder.id;
      // Afspraaklink en de reactie van de klant (vóór de status verder gaat:
      // reageren kan alleen op een geplande klus die niet voorbij is).
      if (apptBase && !workorders.share(owner.tenant_id, workOrder.id, apptBase).error) counts.appointmentLinks++;
      if (workOrderSpec.appointment) {
        const appointment = workOrderSpec.appointment;
        const row = { id: workOrder.id };
        const who = { ip: '192.0.2.10', userAgent: 'Testdata (geen echte browser)', via: 'link' };
        const out = workorders.respond(row, appointment.answer, { name: appointment.name, reason: appointment.reason || '' }, who);
        if (out.error === 'past') {
          // Een afspraak in het verleden is toen bevestigd: zelf vastleggen.
          prepare('UPDATE work_orders SET appointment = ? WHERE id = ?').run(JSON.stringify([{ answer: appointment.answer, name: appointment.name, reason: appointment.reason || '', at: testSet.day(appointment.at),
            moment: WoCore.moment(data), ...who, forwardedFor: '', userId: null }]), workOrder.id);
        } else if (out.error) {
          throw new Error(`Testdata: reactie op afspraak ${workOrder.number} mislukt (${out.error})`);
        }
        counts.appointments++;
      }
      workorders.update(owner.tenant_id, workOrder.id, undefined, workOrderSpec.status);
      seededWos.push({ id: workOrder.id, status: workOrderSpec.status, owner, materials: data.materials, planned: workOrderSpec.planned });
      const at = testSet.day(Math.max(0, spec.response.at - 1));
      prepare('UPDATE work_orders SET created_at = ?, updated_at = ? WHERE id = ?').run(at, workOrderSpec.status === 'gereed' ? testSet.day(-workOrderSpec.planned - 1) : at, workOrder.id);
      counts.workOrders++;
      // Uitbesteden: versturen en ontvangen aan in de testomgeving, en deze klus aangeboden.
      if (outsourcing && workOrderSpec.outsource) {
        settings.update({ outsourcing: { ...settings.get('outsourcing'), send: true, receive: true } });
        const out = outsourcing.offer(owner, owner.tenant_id, workOrder.id, { ...workOrderSpec.outsource, toTenantId: null, fromName: prepare('SELECT name FROM tenants WHERE id = ?').get(owner.tenant_id).name });
        if (out.error) throw new Error(`Testdata: werkorder ${workOrder.number} uitbesteden mislukt (${out.error})`);
        prepare('UPDATE work_order_offers SET created_at = ?, updated_at = ? WHERE id = ?').run(testSet.day(1), testSet.day(1), out.offer.id);
        counts.offers++;
      }
      // Foto's: voor/tijdens bij werk in uitvoering, plus de oplevering als hij gereed is.
      if (photos && workOrderSpec.photos) {
        workOrderSpec.photos.forEach((photo, photoIndex) => {
          const image = sitePhotoPng(photo.kind, i * 10 + photoIndex);
          const out = photos.add(owner, owner.tenant_id, workOrder.id, { image: image.toString('base64'), thumb: sitePhotoPng(photo.kind, i * 10 + photoIndex, 240, 160).toString('base64'),
            kind: photo.kind, caption: photo.caption, customerVisible: photo.visible !== false, takenAt: `${dateIn(workOrderSpec.planned + (photo.kind === 'oplevering' ? 1 : 0))}T${String(9 + photoIndex).padStart(2, '0')}:15:00.000Z` });
          if (out.error) throw new Error(`Testdata: foto bij werkorder ${workOrder.number} mislukt (${out.error})`);
          counts.photos++;
        });
      }
      // Geboekte uren en materiaalverbruik: elke werkdag tot en met vandaag de
      // uitvoerder (07:30–16:00, halfuur pauze) plus reistijd; het verzamelde
      // materiaal verbruikt, één extra artikel en één retour.
      if (worklog && workOrderSpec.done > 0) {
        const fitter = seeded.users[workOrderSpec.assignee];
        const forUser = { id: fitter.id, displayName: fitter.display_name };
        const opts = { actor: fitter, forUser };
        const workDays = WoCore.workDays(data.plannedDate, data.days).filter((date) => date <= today);
        workDays.forEach((date, dayIndex) => {
          for (const entry of [
            { workDate: date, startTime: '07:30', endTime: dayIndex === workDays.length - 1 && workOrderSpec.status !== 'gereed' ? '12:00' : '16:00', breakMinutes: 30, kind: 'werk', stepId: data.steps.length ? data.steps[Math.min(dayIndex + 3, data.steps.length - 1)].id : '' },
            { workDate: date, hours: 0.75, kind: 'reistijd', note: 'Heen en terug vanaf de werkplaats' },
          ]) {
            const out = worklog.addHours(owner.tenant_id, workOrder.id, entry, opts);
            if (out.error) throw new Error(`Testdata: uren bij werkorder ${workOrder.number} mislukt (${out.message})`);
            counts.hours++;
          }
        });
        const usedOn = workDays[0] || data.plannedDate;
        const mats = data.materials.filter((material) => material.picked && material.qty > 0).slice(0, 6).map((material, materialIndex) => ({
          usedOn, code: material.code, description: material.description, unit: material.unit, materialId: material.id, qty: materialIndex === 0 ? material.qty + 1 : material.qty,
          note: materialIndex === 0 ? 'Eén extra nodig door een omweg om de boomwortels' : '',
        }));
        mats.push({ usedOn, code: '', description: 'Koppelstuk 25 mm (meerwerk, uit de bus)', unit: 'st', qty: 2, note: 'Aansluiting bestaande tuinkraan' });
        if (mats.length > 2) mats.push({ ...mats[1], qty: -1, note: 'Retour: niet gebruikt', materialId: mats[1].materialId });
        for (const material of mats) {
          const out = worklog.addMaterial(owner.tenant_id, workOrder.id, material, opts);
          if (out.error) throw new Error(`Testdata: materiaal bij werkorder ${workOrder.number} mislukt (${out.message})`);
          counts.materialUsage++;
        }
      }
    }
  });
  // Meldingen van klanten, via de echte opslag (foto's, antwoord, werkorder).
  if (requests && testSet.requests) {
    testSet.requests.forEach((requestSpec, i) => {
      const customer = seeded.users[requestSpec.customer];
      const contact = CUSTOMERS[requestSpec.customer] || {};
      const out = requests.create(customer, seeded.tenantId, { kind: requestSpec.kind, urgent: requestSpec.urgent, subject: requestSpec.subject, description: requestSpec.description,
        address: (contact.address || '').replace(/\n/g, ', '), phone: contact.phone || '', email: contact.email || '', preferred: requestSpec.preferred || '',
        installationId: requestSpec.installation ? woByPlan[requestSpec.installation] || null : null }, { installationOk: () => true });
      if (out.error) throw new Error(`Testdata: melding mislukt (${out.error})`);
      const id = out.item.id;
      for (let photoIndex = 0; photoIndex < (requestSpec.photos || 0); photoIndex++) {
        const photo = requests.addPhoto(seeded.tenantId, id, customer.id, { image: sitePhotoPng('voor', 50 + i * 5 + photoIndex).toString('base64'), thumb: sitePhotoPng('voor', 50 + i * 5 + photoIndex, 240, 160).toString('base64') });
        if (photo.error) throw new Error(`Testdata: foto bij melding mislukt (${photo.error})`);
      }
      const handler = requestSpec.handler ? seeded.users[requestSpec.handler] : null;
      if (handler && (requestSpec.reply || requestSpec.note || requestSpec.status !== 'ingepland')) {
        const updated = requests.update(handler, seeded.tenantId, id, { status: requestSpec.status === 'ingepland' ? 'in_behandeling' : requestSpec.status, reply: requestSpec.reply || '', note: requestSpec.note || '' });
        if (updated.error) throw new Error(`Testdata: melding bijwerken mislukt (${updated.error})`);
      }
      if (requestSpec.workorder) {
        const converted = requests.toWorkOrder(handler, seeded.tenantId, id, { assigneeId: seeded.users[requestSpec.workorder.assignee].id });
        if (converted.error) throw new Error(`Testdata: werkorder van melding mislukt (${converted.error})`);
        // Ingepland: de klant ziet de afspraak in zijn portaal.
        const workOrderData = { ...converted.workOrder.data, plannedDate: dateIn(requestSpec.workorder.planned), startTime: '13:00', endTime: '15:00', days: 1, crew: seeded.users[requestSpec.workorder.assignee].display_name };
        workorders.update(seeded.tenantId, converted.workOrder.id, workOrderData, 'gepland');
        prepare('UPDATE work_orders SET created_at = ?, updated_at = ? WHERE id = ?').run(testSet.day(Math.max(0, requestSpec.at - 1)), testSet.day(Math.max(0, requestSpec.at - 1)), converted.workOrder.id);
        counts.requestWorkOrders++;
      }
      prepare('UPDATE service_requests SET created_at = ?, updated_at = ? WHERE id = ?').run(testSet.day(requestSpec.at), testSet.day(Math.max(0, requestSpec.at - (requestSpec.handler ? 1 : 0))), id);
      prepare('UPDATE service_request_photos SET created_at = ? WHERE request_id = ?').run(testSet.day(requestSpec.at), id);
      counts.requests++;
    });
  }
  // Seizoensherinneringen: de klanten met een installatie kregen vorig najaar
  // de herinnering "winterklaar maken" (aanzetten doet de beheerder zelf).
  if (seasonReminders) {
    const lastYear = new Date().getUTCFullYear() - 1;
    for (const customer of seasonReminders.recipients(seeded.tenantId, [seeded.tenantId], 'najaar', lastYear, 50)) {
      seasonReminders.markSent(seeded.tenantId, customer.id, 'najaar', lastYear, `${lastYear}-10-01T07:00:00.000Z`);
      counts.seasonReminders++;
    }
  }
  // Eigen sproeierbibliotheek: een eigen behuizing (pop-up 20 cm) en een eigen prijs voor de MP3000.
  if (sprinklers && testSet.sprinklerLibrary) {
    const out = sprinklers.replace(seeded.tenantId, seeded.users.beheerder, testSet.sprinklerLibrary);
    if (out.error) throw new Error(`Testdata: sproeierbibliotheek mislukt (${out.error})`);
    counts.sprinklerParts = out.counts.bodies + out.counts.nozzles;
  }
  // Nieuwsberichten van de testbeheerder, via de echte opslag.
  if (news && testSet.news) {
    const author = seeded.users.beheerder;
    for (const item of testSet.news) {
      const out = news.create(seeded.tenantId, author, item);
      if (out.error) throw new Error(`Testdata: nieuwsbericht mislukt (${out.error})`);
      prepare('UPDATE news SET created_at = ?, updated_at = ? WHERE id = ?').run(testSet.day(item.at), testSet.day(item.at), out.item.id);
      counts.news++;
    }
    news.forget(seeded.tenantId);
  }
  // AI-verzoeken (kostenoverzicht), via de echte opslag (kosten uitgerekend).
  if (aiUsage && testSet.aiUsage) {
    for (const usage of testSet.aiUsage) {
      const id = aiUsage.record({ tenantId: seeded.tenantId, userId: seeded.users[usage.user].id, feature: 'plan_analyse', model: usage.model,
        status: usage.status || 'ok', usage: { input_tokens: usage.input, output_tokens: usage.output }, durationMs: usage.ms,
        eurCentsPerUsd: settings.get('aiEurCentsPerUsd'), detail: { width: usage.width, height: usage.height, ...(usage.areas ? { areas: usage.areas } : {}) } });
      prepare('UPDATE ai_usage SET created_at = ? WHERE id = ?').run(testSet.day(usage.at), id);
      counts.aiRequests++;
    }
  }
  // Herkende plannen met kleurtellingen, via de echte opslag.
  if (recognitions && testSet.recognitions) {
    for (const recognition of testSet.recognitions) {
      const result = { scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog', evidence: 'maat 12,00 m' },
        areas: [{ type: 'lawn', name: 'Gazon', points: [{ x: 100, y: 100 }, { x: 700, y: 100 }, { x: 700, y: 500 }, { x: 100, y: 500 }] }],
        elements: [], notes: `${recognition.areas} vlakken (testdata)` };
      const id = recognitions.saveAi({ tenantId: seeded.tenantId, userId: seeded.users[recognition.user].id, hash: recognition.hash, model: 'claude-opus-5-5', version: 'testdata', result });
      recognitions.addSamples(seeded.tenantId, id, recognition.samples);
      prepare('UPDATE plan_recognitions SET created_at = ?, updated_at = ? WHERE id = ?').run(testSet.day(recognition.at), testSet.day(recognition.at), id);
      counts.recognitions++;
    }
  }
  // Voorraad: de artikelen van de werkorders op voorraad (op één na, die laat
  // zien hoe een artikel zonder voorraadbeheer eruitziet), een eigen artikel,
  // ontvangsten, een telling en een correctie. Een gereede werkorder heeft
  // zijn materialen afgeboekt, een werkorder in uitvoering deels; de open
  // werkorders reserveren de rest. Eén artikel komt tekort.
  if (stock && seededWos.length) {
    const tenantId = seeded.tenantId;
    const admin = seeded.users.beheerder;
    const need = new Map();
    for (const seededWorkOrder of seededWos) for (const material of seededWorkOrder.materials) if (material.code && material.qty > 0) need.set(material.code.toUpperCase(), (need.get(material.code.toUpperCase()) || 0) + material.qty);
    const codes = [...need.keys()].sort();
    const skip = codes[codes.length - 1];
    const short = codes[0];
    const imported = stock.importCatalog(tenantId, admin, codes.filter((code) => code !== skip));
    if (imported.error) throw new Error(`Testdata: voorraad mislukt (${imported.error})`);
    const own = stock.create(tenantId, admin, { code: 'EIGEN-ZAND', name: 'Straatzand (big bag, eigen inkoop)', unit: 'zak', location: 'Buitenterrein', minQty: 2, costPrice: 42.5, onHand: 5 }, { resync: false });
    if (own.error) throw new Error(`Testdata: voorraadartikel mislukt (${own.error})`);
    // Eigen eenheid naast de standaardeenheden (de lijst is voor het eerst gevuld bij het artikel hierboven).
    stock.addUnit(tenantId, 'big bag');
    const items = stock.list(tenantId);
    items.forEach((item, itemIndex) => {
      const want = need.get(item.code) || 0;
      if (item.code === 'EIGEN-ZAND') return;
      const cost = Math.round((2 + (itemIndex % 9) * 3.15) * 100) / 100;
      // Verkoopprijs ongeveer 1,6 x de inkoop (Aquatech is de bron voor de webshop).
      const meta = { location: itemIndex % 2 ? 'Bus 1' : `Magazijn ${String.fromCharCode(65 + (itemIndex % 4))}${1 + (itemIndex % 5)}`, minQty: Math.ceil(want / 2), reorderQty: itemIndex % 3 ? null : want * 2, costPrice: cost, salePrice: Math.round(cost * 160) / 100 };
      stock.update(tenantId, item.id, meta);
      // Genoeg voor alles, behalve het tekortartikel (half zoveel).
      const qty = item.code === short ? Math.max(1, Math.floor(want / 2)) : Math.ceil(want * 1.5) + 2;
      stock.move(tenantId, admin, item.id, { kind: 'ontvangst', qty, note: `Pakbon ${1000 + itemIndex}` });
    });
    const first = items.find((item) => item.code !== 'EIGEN-ZAND' && item.code !== short);
    if (first) {
      stock.move(tenantId, admin, first.id, { kind: 'telling', qty: Math.ceil((need.get(first.code) || 1) * 1.5) + 1, note: 'Kwartaaltelling' });
      stock.move(tenantId, admin, first.id, { kind: 'correctie', qty: -1, note: 'Beschadigd bij het laden' });
    }
    // Werkorders: gereed = alles afgeboekt, bezig = de helft, open = reserveren.
    for (const seededWorkOrder of seededWos) {
      const lines = [...new Map(seededWorkOrder.materials.filter((material) => material.code && material.qty > 0 && material.code.toUpperCase() !== skip)
        .map((material) => [material.code.toUpperCase(), material.qty])).entries()];
      if (seededWorkOrder.status === 'gereed') {
        if (lines.length) stock.issue(tenantId, seededWorkOrder.owner, seededWorkOrder.id, lines.map(([code, qty]) => ({ code, qty })), 'Materiaal van de werkorder');
      } else if (seededWorkOrder.status === 'bezig') {
        const half = lines.slice(0, Math.ceil(lines.length / 2));
        if (half.length) stock.issue(tenantId, seededWorkOrder.owner, seededWorkOrder.id, half.map(([code, qty]) => ({ code, qty })), 'Meegenomen naar de klus');
      }
      stock.onWorkOrderChange(tenantId, seededWorkOrder.id, seededWorkOrder.owner);
    }
    // Spreiden in de tijd: ontvangsten een maand terug, de rest rond de klus.
    prepare("UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND kind = 'ontvangst'").run(testSet.day(30), tenantId);
    prepare("UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND kind IN ('telling', 'correctie')").run(testSet.day(10), tenantId);
    for (const seededWorkOrder of seededWos) prepare('UPDATE stock_movements SET created_at = ? WHERE tenant_id = ? AND work_order_id = ?').run(testSet.day(Math.max(0, -seededWorkOrder.planned)), tenantId, seededWorkOrder.id);
    counts.stockItems = stock.list(tenantId).length;
    counts.stockMovements = prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?').get(tenantId).n;
    counts.stockReservations = prepare('SELECT COUNT(*) AS n FROM stock_reservations WHERE tenant_id = ?').get(tenantId).n;
  }
  // Facturen: de gereede werkorders gefactureerd (één betaald, één
  // openstaand en over de vervaldatum, één nog concept), een creditfactuur
  // in concept en een losse verkoop aan de balie.
  if (invoices && seededWos.length) {
    const tenantId = seeded.tenantId;
    const admin = seeded.users.beheerder;
    const conf = InvCore.sanitizeSettings(settings.get('invoicing'));
    const profile = settings.get('quoteProfile');
    const done = seededWos.filter((seededWorkOrder) => seededWorkOrder.status === 'gereed' || seededWorkOrder.status === 'bezig');
    const made = [];
    done.slice(0, 3).forEach((seededWorkOrder, invoiceIndex) => {
      const workOrder = invoices.workOrder(tenantId, seededWorkOrder.id);
      const quote = workOrder.quoteId ? invoices.quote(tenantId, workOrder.quoteId) : null;
      const built = InvCore.fromWorkOrder(workOrder, {
        quote, logged: worklog ? worklog.list(tenantId, workOrder.id) : { hours: [], materials: [] }, articles: stock ? stock.saleInfo(tenantId) : {},
        catalog: loadArticles(), hourlyRate: profile.hourlyRate, settings: conf,
      });
      // Betaald een maand terug, openstaand over de vervaldatum, concept van vandaag.
      const date = testSet.day(Math.max(0, -seededWorkOrder.planned - 1) + [30, 20, 0][invoiceIndex]).slice(0, 10);
      const invoice = invoices.create(tenantId, admin, { ...built.data, date, dueDate: InvCore.addDays(date, conf.paymentDays) }, conf,
        { workOrderId: workOrder.id, quoteId: quote ? quote.id : null, customerId: quote ? quote.customerId : null });
      if (invoiceIndex < 2) invoices.finalize(tenantId, admin, invoice.id, conf);
      if (invoiceIndex === 0) invoices.setPaid(tenantId, invoice.id, true, InvCore.addDays(date, 9));
      made.push(invoice);
    });
    if (made[0]) invoices.credit(tenantId, admin, made[0].id, conf);
    const sand = stock ? stock.saleInfo(tenantId, ['EIGEN-ZAND'])['EIGEN-ZAND'] : null;
    const counter = invoices.create(tenantId, admin, {
      date: today, reference: 'Afhaalverkoop',
      customer: { name: 'Hoveniersbedrijf De Groene Hand', address: 'Industrieweg 4\n8071 AB Nunspeet', email: 'inkoop@groenehand.voorbeeld.test', vatNumber: 'NL001234567B01' },
      lines: [{ code: 'EIGEN-ZAND', description: sand ? sand.name : 'Straatzand', qty: 2, unit: 'zak', price: 69.5, vat: 21, group: 'producten' },
        { code: '', description: 'Bezorgen', qty: 1, unit: 'st', price: 35, vat: 21, group: 'overig' }],
    }, conf);
    invoices.finalize(tenantId, admin, counter.id, conf);
    invoices.markSent(tenantId, counter.id, 'inkoop@groenehand.voorbeeld.test');
    // Een afgeronde webshopbestelling (betaald met iDEAL), zoals shop-orders.js hem maakt.
    const order = fromOrder({
      id: 9001, number: '9001', status: 'completed', customer_id: 0, date_created: `${today}T09:12:00`, date_completed: `${today}T10:00:00`, date_paid: `${today}T09:13:00`,
      billing: { first_name: 'Petra', last_name: 'Jansen', address_1: 'Kerkstraat 12', postcode: '8071 CD', city: 'Nunspeet', country: 'NL', email: 'petra.jansen@voorbeeld.test', phone: '0612345678' },
      tax_lines: [{ rate_id: 1, rate_percent: 21 }],
      line_items: [{ sku: 'EIGEN-ZAND', name: sand ? sand.name : 'Straatzand', quantity: 1, total: '69.50', total_tax: '14.60', taxes: [{ id: 1, total: '14.60' }] }],
      shipping_lines: [{ method_title: 'PostNL', total: '6.95', total_tax: '1.46', taxes: [{ id: 1, total: '1.46' }] }],
    }, { articles: stock ? stock.saleInfo(tenantId, ['EIGEN-ZAND']) : {}, settings: conf });
    const shopInv = invoices.create(tenantId, admin, order.data, conf, { shopOrderId: '9001' });
    invoices.finalize(tenantId, admin, shopInv.id, conf, { skipStock: true });
    invoices.setPaid(tenantId, shopInv.id, true, order.paidOn);
    counts.invoices = prepare('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ?').get(tenantId).n;
    counts.debtors = prepare('SELECT COUNT(*) AS n FROM debtors WHERE tenant_id = ?').get(tenantId).n;
  }
  // Webshop alleen als de testomgeving geen eigen webshop heeft (de nepwinkel
  // van een vorige keer vullen we opnieuw).
  const url = settings.get('shopSource').url;
  if (!url || url === SHOP_URL) {
    settings.update({ shopSource: testSet.shop.source });
    shop.replaceProducts(seeded.tenantId, testSet.shop.products, `${today}T07:00:00.000Z`);
    counts.products = testSet.shop.products.length;
  }
  return counts;
}

module.exports = { buildTestData, seedFeatures, signaturePng, sitePhotoPng, newPassword, prefixOf, garden, lawnHeads, SHOP_URL };
