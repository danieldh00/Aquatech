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

  // Offertes in alle statussen, met de digitale offerte erbij: share = klantlink
  // (verstuurd/bekeken), response = reactie van de klant (akkoord met naam,
  // handtekening en gekozen opties, of afgewezen met reden), workorder =
  // werkorder bij een geaccordeerde offerte. Dagen zijn "zoveel dagen geleden".
  const quotes = [
    { planKey: 'devries', owner: 'inst1', customerKey: 'klant1', customer: c.klant1, status: 'akkoord', at: 34, discountPct: 5,
      options: ['rain', 'service'],
      share: { sent: 33, views: 4, lastView: 31 },
      response: { answer: 'akkoord', name: 'Petra de Vries', at: 31, via: 'account', options: ['rain'] },
      workorder: { status: 'gereed', assignee: 'inst1', planned: -24, done: 1, picked: 1, notes: 'Opgeleverd en met de klant doorgelopen; computer ingesteld op 3 beurten per week.' } },
    { planKey: 'bakker', owner: 'inst1', customerKey: 'klant2', customer: c.klant2, status: 'verzonden', at: 3,
      options: ['rain', 'soil', 'service'], share: { sent: 3, views: 2, lastView: 1 } },
    { planKey: 'visser', owner: 'inst2', customerKey: 'klant3', customer: c.klant3, status: 'afgewezen', at: 17, layout: 'totaal',
      share: { sent: 16, views: 3, lastView: 14 },
      response: { answer: 'afgewezen', name: 'Anne Visser', at: 14, via: 'link', reason: 'We kiezen dit jaar voor alleen een druppelslang in de border.' } },
    { planKey: 'mulder', owner: 'inst2', customerKey: null, customer: c.mulder, status: 'akkoord', at: 9,
      options: ['service'], share: { sent: 9, views: 2, lastView: 7 },
      response: { answer: 'akkoord', name: 'Jeroen Mulder', at: 7, via: 'link', options: ['service'] },
      workorder: { status: 'bezig', assignee: 'inst2', planned: 0, done: 0.4, picked: 0.8, notes: 'Hond loopt los in de tuin; poort aan de zijkant gebruiken.' } },
    { planKey: 'vanberg', owner: 'beheerder', customerKey: null, customer: c.vanberg, status: 'akkoord', at: 5,
      share: { sent: 5, views: 1, lastView: 4 },
      response: { answer: 'akkoord', name: 'Sanne van den Berg', at: 4, via: 'link' },
      workorder: { status: 'gepland', assignee: 'inst1', planned: 8, done: 0, picked: 0 } },
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

  return { accounts, plans, quotes, shop, day };
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

/**
 * Het deel van de testdata dat via de echte opslaglogica loopt (zodat het
 * precies zo is als wanneer iemand het in de app doet): klantlinks, reacties
 * van klanten, werkorders en de webshop. Draait na store.seedEnvironment.
 * stores = { db, quotes, workorders, shop, settings } (settings van de
 * testomgeving); seeded = { users, quoteIds } uit seedEnvironment.
 * shareBase = adres van openbaar/offerte.html (uit de browser); zonder komen
 * er geen klantlinks.
 */
function seedFeatures(stores, set, seeded, { shareBase = null } = {}) {
  const { db, quotes, workorders, shop, settings } = stores;
  const q = (sql) => db.prepare(sql);
  const counts = { links: 0, responses: 0, workOrders: 0, products: 0 };
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
      const row = q('SELECT * FROM quotes WHERE id = ?').get(id);
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
      data.crew = seeded.users[w.assignee].display_name;
      data.instructions = 'Graag voor aanvang even aanbellen. Water en stroom zijn beschikbaar bij de achterdeur.';
      data.siteNotes = w.notes || '';
      const nDone = Math.round(data.steps.length * w.done);
      data.steps.forEach((st, k) => { if (k < nDone) { st.done = true; st.actualHours = st.hours ? Math.round(st.hours * 1.1 * 4) / 4 : null; } });
      const nPicked = Math.round(data.materials.length * w.picked);
      data.materials.forEach((m, k) => { m.picked = k < nPicked; });
      if (w.status === 'gereed') data.report = { notes: w.notes || '', completedOn: dateIn(w.planned + 1), signedBy: spec.response.name };
      const wo = workorders.create(owner, quote, data, { assigneeId: seeded.users[w.assignee].id });
      workorders.update(owner.tenant_id, wo.id, undefined, w.status);
      const at = set.day(Math.max(0, spec.response.at - 1));
      q('UPDATE work_orders SET created_at = ?, updated_at = ? WHERE id = ?').run(at, w.status === 'gereed' ? set.day(-w.planned - 1) : at, wo.id);
      counts.workOrders++;
    }
  });
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

module.exports = { buildTestData, seedFeatures, signaturePng, newPassword, prefixOf, garden, lawnHeads, SHOP_URL };
