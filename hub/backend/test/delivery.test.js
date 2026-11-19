// Levermethode en levertijd per artikel: de regels (artikel, hoofdartikel, categorie, gemengde wagen), de aantalstaffel van pallet,
// de levertijd (kalender- en werkdagen, onbekend, inkoop, leverancier) en de uitkomst in de winkelwagen, bij het afrekenen,
// op de productpagina en in de beheerroutes.
const test = require('node:test');
const assert = require('node:assert');
const Rules = require('../src/webshop/delivery-rules');
const Times = require('../src/webshop/delivery-times');
const Shipping = require('../src/webshop/shipping');
const { flatten } = require('../src/webshop/category-discounts');
const { DEFAULT_TREE } = require('../src/webshop/category-tree');
const { setup, until, PERSON } = require('./helpers/webshop-world');
const { postForm, postCheckout } = require('./helpers/http-client');

/** De hoofdcategorie en haar subcategorie in de standaardboom. */
const PARENT = { slug: 'druppelslang-toebehoren', name: 'Druppelslangen & toebehoren' };
const CHILD = { slug: 'driptape-koppelingen', name: 'Driptape koppelingen' };
const OTHER = { slug: 'beregeningscomputers-en-regensensors', name: 'Beregeningscomputers & regensensors' };
/** Vaste "vandaag" voor de levertijdberekening. */
const TODAY = new Date(Date.UTC(2026, 10, 18));

test('regels: opschonen, controleren en welke methodes bij een aantal mogen', () => {
  assert.deepStrictEqual(Rules.sanitizeRules(undefined), []);
  assert.deepStrictEqual(Rules.sanitizeRules('geen json'), []);
  const rules = Rules.sanitizeRules([
    { method: 'dpd', minQty: '1', maxQty: '99' }, { method: 'pallet', minQty: 100, maxQty: '' }, { method: 'vliegtuig', minQty: 1 },
    { method: 'eigen', minQty: 0 }, { method: 'eigen', minQty: 10, maxQty: 5 }, { method: 'eigen', minQty: 'x' },
  ]);
  assert.deepStrictEqual(rules, [{ method: 'dpd', minQty: 1, maxQty: 99 }, { method: 'pallet', minQty: 100, maxQty: null }]);
  assert.deepStrictEqual(Rules.sanitizeRules(JSON.stringify(rules)), rules, 'ook een JSON-tekst uit de database');
  assert.strictEqual(Rules.checkRules(rules), '');
  assert.match(Rules.checkRules([{ method: 'trein', minQty: 1 }]), /bezorgmethode/);
  assert.match(Rules.checkRules([{ method: 'dpd', minQty: 1.5 }]), /minimum/);
  assert.match(Rules.checkRules([{ method: 'dpd', minQty: 5, maxQty: 2 }]), /maximum/);
  assert.match(Rules.checkRules(Array.from({ length: 13 }, () => ({ method: 'dpd', minQty: 1 }))), /Hoogstens/);
  assert.strictEqual(Rules.allowedAt([], 5), null, 'geen regels = geen beperking');
  assert.deepStrictEqual([...Rules.allowedAt(rules, 99)], ['dpd']);
  assert.deepStrictEqual([...Rules.allowedAt(rules, 100)], ['pallet']);
  assert.deepStrictEqual([...Rules.allowedAt([{ method: 'dpd', minQty: 1, maxQty: 9 }], 50)], [], 'buiten alle regels: niets toegestaan');
});

test('gemengde wagen: de zwaarste methode neemt de hele bestelling mee', () => {
  const palletOnly = [{ method: 'pallet', minQty: 1, maxQty: null }];
  const dpdOnly = [{ method: 'dpd', minQty: 1, maxQty: null }];
  assert.deepStrictEqual(Rules.blockedMethods([{ name: 'Gewoon', qty: 3, rules: null }]), {}, 'zonder regels niets geblokkeerd');
  const mixed = Rules.blockedMethods([{ name: 'Pallet-artikel', qty: 120, rules: palletOnly }, { name: 'Pakket-artikel', qty: 2, rules: dpdOnly }, { name: 'Vrij', qty: 1, rules: null }]);
  assert.deepStrictEqual(Object.keys(mixed).sort(), ['dpd', 'eigen'], 'pallet mag (zwaarder dan DPD), DPD en eigen vervoer niet');
  assert.match(mixed.dpd, /Pallet-artikel/);
  const both = [{ method: 'dpd', minQty: 1, maxQty: null }, { method: 'pallet', minQty: 1, maxQty: null }];
  assert.deepStrictEqual(Object.keys(Rules.blockedMethods([{ name: 'A', qty: 1, rules: both }])), ['eigen'], 'eigen vervoer ligt tussen de toegestane methodes in');
  const nothing = Rules.blockedMethods([{ name: 'Te klein', qty: 50, rules: [{ method: 'dpd', minQty: 1, maxQty: 9 }] }]);
  assert.deepStrictEqual(Object.keys(nothing).sort(), ['dpd', 'eigen', 'pallet'], 'geen enkele regel past: niets bezorgbaar');
  assert.match(nothing.pallet, /contact/);
});

test('regels per artikel, hoofdartikel en categorie: de diepste categorie wint en het artikel gaat voor', () => {
  const flat = flatten(DEFAULT_TREE);
  const config = { categories: [
    { categorySlug: PARENT.slug, rules: [{ method: 'dpd', minQty: 1, maxQty: 9 }, { method: 'pallet', minQty: 10 }] },
    { categorySlug: CHILD.slug, rules: [{ method: 'pallet', minQty: 1 }] },
    { categorySlug: 'bestaat-niet', rules: [{ method: 'dpd', minQty: 1 }] },
  ] };
  const resolve = Rules.resolverFor(flat, config);
  assert.deepStrictEqual(resolve(PARENT.slug).map((rule) => rule.method), ['dpd', 'pallet']);
  assert.deepStrictEqual(resolve(CHILD.slug).map((rule) => rule.method), ['pallet'], 'subcategorie gaat voor de hoofdcategorie');
  assert.deepStrictEqual(resolve(OTHER.slug), [], 'andere tak: geen regels');
  assert.deepStrictEqual(resolve('onbekend'), []);
  assert.deepStrictEqual(Rules.resolverFor(flat, {})(PARENT.slug), []);
  const categoryRules = resolve(CHILD.slug);
  const own = [{ method: 'dpd', minQty: 1, maxQty: null }];
  assert.deepStrictEqual(Rules.effectiveRules(own, '[]', categoryRules), own, 'eigen regels gaan voor');
  assert.deepStrictEqual(Rules.effectiveRules('[]', JSON.stringify(own), categoryRules), own, 'een variant erft van het hoofdartikel');
  assert.deepStrictEqual(Rules.effectiveRules('[]', '[]', categoryRules), categoryRules);
  assert.strictEqual(Rules.effectiveRules('[]', '[]', []), null);
  assert.strictEqual(Rules.checkCategoryRules(config, new Set([PARENT.slug, CHILD.slug])), 'Een gekozen categorie staat niet (meer) in het menu van de webshop.');
  assert.deepStrictEqual(Rules.sanitizeCategoryRules(config).categories.length, 3, 'sanitize kent het menu niet; de beheerroute controleert dat');
});

test('levertijd: kalender- en werkdagen, onbekend, artikel, inkoop en leverancier', () => {
  const dpd = { min: 1, max: 2 };
  const pallet = { min: 3, max: 5 };
  assert.deepStrictEqual(Times.sanitizeLead({ min: '2', max: '' }), { min: 2, max: 2 });
  assert.strictEqual(Times.sanitizeLead({ min: 5, max: 2 }), null);
  assert.strictEqual(Times.sanitizeLead({ min: '', max: '' }), null);
  assert.strictEqual(Times.sanitizeLead({ min: 0, max: 400 }), null);
  assert.strictEqual(Times.sanitizeDayType('rommel', 'working'), 'working');
  const inStock = Times.leadFor({ inStock: true, methodLead: dpd, dayType: 'calendar', today: TODAY });
  assert.deepStrictEqual(inStock, { min: 1, max: 2, dayType: 'calendar', source: 'voorraad' });
  assert.strictEqual(Times.leadText(inStock), '1-2 dagen');
  assert.strictEqual(Times.leadText(Times.leadFor({ inStock: true, methodLead: pallet, dayType: 'working', today: TODAY })), '3-5 werkdagen');
  assert.strictEqual(Times.leadText({ min: 1, max: 1, dayType: 'working' }), '1 werkdag');
  assert.strictEqual(Times.leadText({ min: 0, max: 0, dayType: 'calendar' }), 'Direct');
  assert.strictEqual(Times.leadText(null), 'Levertijd op aanvraag');
  assert.strictEqual(Times.leadFor({ inStock: true, methodLead: null, dayType: 'calendar' }), null, 'geen standaard voor de methode: onbekend');
  const override = Times.leadFor({ override: { min: 10, max: 14 }, inStock: false, methodLead: dpd, dayType: 'calendar', today: TODAY });
  assert.deepStrictEqual([override.min, override.max, override.source], [10, 14, 'artikel'], 'de eigen levertijd gaat voor alles');
  assert.strictEqual(Times.leadFor({ override: { min: 2, max: 3 }, inStock: true, methodLead: null, dayType: 'calendar' }).source, 'artikel', 'ook zonder standaard van de methode');
  const expected = Times.leadFor({ inStock: false, methodLead: dpd, dayType: 'calendar', expectedDate: '2026-11-28', supplierLeadDays: 3, today: TODAY });
  assert.deepStrictEqual([expected.min, expected.max, expected.source], [11, 12, 'inkoop'], '10 dagen tot de levering + 1-2 dagen bezorgen; de inkooporder gaat voor de leverancier');
  const past = Times.leadFor({ inStock: false, methodLead: dpd, dayType: 'calendar', expectedDate: '2026-11-01', today: TODAY });
  assert.deepStrictEqual([past.min, past.max], [1, 2], 'een verwachte datum in het verleden telt als vandaag');
  const supplier = Times.leadFor({ inStock: false, methodLead: pallet, dayType: 'working', supplierLeadDays: 7, today: TODAY });
  assert.deepStrictEqual([supplier.min, supplier.max, supplier.source], [8, 10, 'leverancier'], '7 kalenderdagen = 5 werkdagen, plus 3-5 werkdagen');
  assert.strictEqual(Times.leadFor({ inStock: false, methodLead: dpd, dayType: 'calendar', today: TODAY }), null, 'niet op voorraad zonder inkoop of leverancier: op aanvraag');
  assert.strictEqual(Times.leadFor({ inStock: false, methodLead: dpd, dayType: 'calendar', expectedDate: 'kapot', supplierLeadDays: '', today: TODAY }), null);
  assert.strictEqual(Times.daysUntil('2026-11-20', TODAY), 2);
  const slowest = Times.slowestOf([{ min: 1, max: 2, dayType: 'calendar' }, { min: 3, max: 5, dayType: 'working' }, { min: 2, max: 3, dayType: 'calendar' }]);
  assert.deepStrictEqual([slowest.min, slowest.max], [3, 5], '5 werkdagen is langer dan 3 kalenderdagen');
  assert.strictEqual(Times.slowestOf([{ min: 1, max: 2, dayType: 'calendar' }, null]), null, 'één onbekende maakt het geheel onbekend');
  assert.strictEqual(Times.slowestOf([]), null);
});

test('verzendinstelling: levertijd per methode, standaarden en aantalstaffel voor pallet en eigen vervoer', () => {
  const defaults = Shipping.sanitizeShipping({});
  assert.deepStrictEqual([defaults.dpd.leadDays, defaults.dpd.dayType], [{ min: 1, max: 2 }, 'calendar']);
  assert.deepStrictEqual([defaults.pallet.leadDays, defaults.pallet.dayType], [{ min: 3, max: 5 }, 'working']);
  assert.deepStrictEqual([defaults.pickup.leadDays, defaults.pickup.dayType], [{ min: 0, max: 0 }, 'calendar']);
  const custom = Shipping.sanitizeShipping({ dpd: { enabled: true, leadDays: { min: '', max: '' }, dayType: 'working' }, pallet: { enabled: true, leadDays: { min: 9, max: 3 } }, pickup: {} });
  assert.strictEqual(custom.dpd.leadDays, null, 'bewust leeg = onbekend');
  assert.strictEqual(custom.dpd.dayType, 'working');
  assert.deepStrictEqual(custom.pallet.leadDays, { min: 3, max: 5 }, 'een onbruikbaar bereik geeft de standaard');
  const config = Shipping.sanitizeShipping({ pickup: { enabled: true }, dpd: { enabled: true, zones: [{ country: 'NL', tiers: [{ upToGrams: 5000, price: 7 }, { upToGrams: 50000, price: 20 }], qtyTiers: [{ upToQty: 1, price: 1 }] }] },
    pallet: { enabled: true, zones: [{ country: 'NL', qtyTiers: [{ upToQty: 200, price: 90 }, { upToQty: 50, price: 45 }, { upToQty: 0, price: 1 }, { upToQty: 50, price: 5 }] }] } });
  assert.strictEqual(config.dpd.zones[0].qtyTiers, undefined, 'DPD kent geen aantalstaffel');
  assert.deepStrictEqual(config.pallet.zones[0].qtyTiers, [{ upToQty: 50, price: 45 }, { upToQty: 200, price: 90 }], 'oplopend, zonder dubbelen en rommel');
  /**
   * De verzendopties per methode voor een winkelwagen in Nederland.
   * @param {object} basket Wat van de standaardwagen afwijkt (gewicht, aantal, geblokkeerde methodes).
   * @returns {Object<string, object>} De opties per methode.
   */
  const options = (basket) => Object.fromEntries(Shipping.optionsFor(config, { country: 'NL', weightGrams: 100, subtotal: 10, ...basket }).map((option) => [option.method, option]));
  assert.strictEqual(options({ quantity: 40 }).pallet.price, 45);
  assert.strictEqual(options({ quantity: 51 }).pallet.price, 90);
  assert.strictEqual(options({ quantity: 201 }).pallet.available, false);
  assert.match(options({ quantity: 201 }).pallet.reason, /aantal/);
  assert.strictEqual(options({ weightGrams: 30000, quantity: 5 }).pallet.price, 45, 'de staffel gaat voor het gewicht: zwaar maar weinig stuks');
  assert.strictEqual(options({ weightGrams: 30000 }).dpd.price, 20, 'DPD rekent op gewicht');
  const blocked = options({ quantity: 5, blocked: { dpd: 'Niet met DPD.' } });
  assert.deepStrictEqual([blocked.dpd.available, blocked.dpd.reason, blocked.pallet.available], [false, 'Niet met DPD.', true]);
  assert.strictEqual(blocked.ophalen.available, true, 'ophalen kan altijd');
  assert.deepStrictEqual(Shipping.countriesOf(Shipping.sanitizeShipping({ pallet: { enabled: true, zones: [{ country: 'DE', qtyTiers: [{ upToQty: 5, price: 1 }] }] }, dpd: { enabled: false } })).map((country) => country.code), ['DE'], 'een land met alleen een aantalstaffel telt mee');
  assert.strictEqual(Shipping.quantityOf([{ qty: 2, stockPer: 100 }, { qty: 3 }]), 203, 'een verpakking telt als haar factor');
});

/**
 * Winkel met pallet naast DPD en artikelen met regels per artikel en per categorie.
 * @returns {Promise<object>} De wereld van webshop-world plus de id's en een klant.
 */
async function deliveryWorld() {
  const world = await setup();
  const { admin, db } = world;
  const saved = await admin.put('/app/api/admin/settings', { shopShipping: {
    pickup: { enabled: true },
    dpd: { enabled: true, zones: [{ country: 'NL', tiers: [{ upToGrams: 100000, price: 6.95 }] }] },
    pallet: { enabled: true, zones: [{ country: 'NL', qtyTiers: [{ upToQty: 100, price: 40 }, { upToQty: 1000, price: 90 }] }] },
  } });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const tenantId = db.prepare("SELECT tenant_id FROM stock_items WHERE code = 'BUS'").get().tenant_id;
  const ids = {};
  const items = [
    { code: 'LOS', category: PARENT }, { code: 'BUIS', category: CHILD }, { code: 'VRIJ', category: OTHER, leadDays: { min: 2, max: 3 } },
    { code: 'EIG', category: PARENT, deliveryRules: [{ method: 'dpd', minQty: 1, maxQty: null }] },
  ];
  for (const [index, item] of items.entries()) {
    const made = await admin.post('/app/api/stock/items', { code: item.code, name: `Artikel ${item.code}`, unit: 'st', onHand: 5000, salePrice: 5, weightGrams: 100, vatRate: 21, ...(item.deliveryRules ? { deliveryRules: item.deliveryRules } : {}), ...(item.leadDays ? { leadDays: item.leadDays } : {}) });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    ids[item.code] = made.body.id;
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, String(index + 1), item.code, '', JSON.stringify([item.category.name]));
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(index + 1), tenantId, item.code);
  }
  // De catalogus onthoudt zijn gegevens 30 seconden; een andere kortingsinstelling geeft meteen een nieuwe catalogus met de nieuwe artikelen.
  assert.strictEqual((await admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: OTHER.slug, discountPct: 1 }] })).status, 200);
  const rules = await admin.put('/app/api/admin/delivery-rules', { categories: [
    { categorySlug: PARENT.slug, rules: [{ method: 'dpd', minQty: 1, maxQty: 9 }, { method: 'pallet', minQty: 10, maxQty: '' }] },
    { categorySlug: CHILD.slug, rules: [{ method: 'pallet', minQty: 1, maxQty: '' }] },
  ] });
  assert.strictEqual(rules.status, 200, JSON.stringify(rules.body));
  return { ...world, ids, customer: world.shoppers[0].client };
}

/**
 * Legt artikelen in de winkelwagen van een klant en geeft de keuzelijst van de verzendmethode.
 * @param {object} world De wereld van deliveryWorld.
 * @param {[string, number][]} cart Codes en aantallen.
 * @returns {Promise<Object<string, { available: boolean, text: string }>>} Per methode of hij beschikbaar is en de tekst.
 */
async function optionsAfter(world, cart) {
  const empty = await postForm(world.base, world.customer, '/winkelwagen/', { action: 'clear' });
  assert.ok(empty.status < 400);
  for (const [code, qty] of cart) assert.strictEqual((await postForm(world.base, world.customer, '/winkelwagen/', { action: 'add', code, qty: String(qty) })).status, 303);
  const page = await world.customer.get('/afrekenen/');
  assert.strictEqual(page.status, 200);
  const out = {};
  for (const match of page.text.matchAll(/<input type="radio" name="shippingMethod" value="(dpd|pallet|eigen|ophalen)"([^>]*)>([\s\S]*?)<\/label>/g)) out[match[1]] = { available: !/disabled/.test(match[2]), text: match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase() };
  out.reasons = page.text;
  return out;
}

test('winkelwagen: categorieregels, regels van het artikel, aantal en gemengde wagen bepalen de methodes', async () => {
  const world = await deliveryWorld();
  const few = await optionsAfter(world, [['LOS', 5]]);
  assert.strictEqual(few.dpd.available, true, 'tot 9 stuks DPD (regel van de hoofdcategorie)');
  assert.strictEqual(few.pallet.available, true, 'pallet is zwaarder dan DPD en mag altijd');
  const many = await optionsAfter(world, [['LOS', 12]]);
  assert.strictEqual(many.dpd.available, false, 'vanaf 10 stuks alleen pallet');
  assert.strictEqual(many.pallet.available, true);
  assert.strictEqual(many.ophalen.available, true, 'ophalen kan altijd');
  assert.match(many.reasons, /Artikel LOS/);
  assert.match(many.pallet.text, /€\s*40,00/, 'aantalstaffel: 12 stuks valt in de klasse tot 100');
  const child = await optionsAfter(world, [['BUIS', 1]]);
  assert.strictEqual(child.dpd.available, false, 'subcategorie: alleen pallet, ook bij 1 stuk');
  const own = await optionsAfter(world, [['EIG', 500]]);
  assert.strictEqual(own.dpd.available, true, 'regel van het artikel gaat voor die van de categorie');
  const mixed = await optionsAfter(world, [['EIG', 2], ['BUIS', 1], ['VRIJ', 3]]);
  assert.strictEqual(mixed.dpd.available, false, 'één pallet-artikel zet de hele wagen op pallet');
  assert.strictEqual(mixed.pallet.available, true);
  const free = await optionsAfter(world, [['VRIJ', 3], ['BUS', 2]]);
  assert.strictEqual(free.dpd.available && free.pallet.available, true, 'artikelen zonder regels beperken niets');
});

test('levertijd bij het afrekenen en op de bestelling: de langzaamste regel, indicatief', async () => {
  const world = await deliveryWorld();
  const mixed = await optionsAfter(world, [['VRIJ', 3], ['BUS', 2]]);
  assert.match(mixed.dpd.text, /levertijd ca\. 2-3 dagen/, 'eigen levertijd 2-3 van VRIJ is langer dan de 1-2 van DPD');
  assert.match(mixed.pallet.text, /levertijd ca\. 3-5 werkdagen/, 'de standaard van pallet (werkdagen) is langzamer dan 2-3 dagen');
  assert.match(mixed.ophalen.text, /levertijd ca\. 2-3 dagen/, 'de eigen levertijd van een artikel geldt ook voor ophalen');
  assert.match((await optionsAfter(world, [['BUS', 1]])).ophalen.text, /direct/);
  assert.match(mixed.reasons, /indicatief/);
  const placed = await postCheckout(world.base, world.customer, { ...PERSON, shippingMethod: 'pallet' });
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 300));
  const list = (await world.admin.get('/app/api/admin/web-orders')).body.items;
  const order = (await world.admin.get(`/app/api/admin/web-orders/${list[0].id}`)).body.order;
  assert.deepStrictEqual([order.shipping.eta.text, order.shipping.eta.min, order.shipping.eta.max, order.shipping.eta.dayType, order.shipping.eta.indicative], ['3-5 werkdagen', 3, 5, 'working', true], 'momentopname op de bestelling');
  assert.strictEqual(order.shipping.price, 40, 'aantalstaffel: 5 stuks');
  // Bij een artikel dat alleen met pallet mag, wordt DPD ook bij het plaatsen geweigerd.
  await optionsAfter(world, [['BUIS', 1]]);
  const refused = await postCheckout(world.base, world.customer, { ...PERSON, shippingMethod: 'dpd' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /Artikel BUIS/);
  // Zonder levertijd voor de methode staat er "op aanvraag".
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { shopShipping: { pickup: { enabled: true }, dpd: { enabled: true, leadDays: { min: '', max: '' }, zones: [{ country: 'NL', tiers: [{ upToGrams: 100000, price: 6.95 }] }] } } })).status, 200);
  const unknown = await optionsAfter(world, [['BUS', 1]]);
  assert.match(unknown.dpd.text, /levertijd op aanvraag/);
});

test('productpagina: levertijd bij voorraad, eigen levertijd en niet op voorraad', async () => {
  const world = await deliveryWorld();
  /**
   * Het adres van de productpagina van een testartikel.
   * @param {string} code De artikelcode.
   * @returns {string} Het deel van het adres na /product/.
   */
  const slug = (code) => `artikel-${code.toLowerCase()}-${code.toLowerCase()}`;
  /**
   * Haalt de productpagina van een testartikel op.
   * @param {string} code De artikelcode.
   * @returns {Promise<{ page: object }>} Het antwoord.
   */
  const pageOf = async (code) => ({ page: await world.customer.get(`/product/${slug(code)}/`) });
  const standard = await pageOf('LOS');
  assert.strictEqual(standard.page.status, 200, slug('LOS'));
  assert.match(standard.page.text, /Levertijd ca\. 1-2 dagen/);
  const override = await pageOf('VRIJ');
  assert.match(override.page.text, /Levertijd ca\. 2-3 dagen/, 'eigen levertijd van het artikel');
  // Niet op voorraad: zonder inkoop of leverancier is de levertijd onbekend; met een leverancier of inkooporder volgt hij daaruit.
  world.db.prepare("UPDATE stock_items SET on_hand = 0 WHERE code = 'LOS'").run();
  world.db.prepare("UPDATE stock_items SET lead_days_min = NULL, lead_days_max = NULL WHERE code = 'VRIJ'").run();
  world.db.prepare("UPDATE stock_items SET on_hand = 0 WHERE code = 'VRIJ'").run();
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: OTHER.slug, discountPct: 2 }] })).status, 200, 'nieuwe catalogus');
  const unknown = await pageOf('LOS');
  assert.match(unknown.page.text, /Niet op voorraad/);
  assert.match(unknown.page.text, /Levertijd op aanvraag/);
  // Met een leverancier met levertijd volgt de levertijd daaruit: 5 dagen aanleveren + 1-2 dagen bezorgen.
  const supplier = await world.admin.post('/app/api/suppliers', { name: 'Groothandel Noord' });
  world.db.prepare("UPDATE stock_items SET on_hand = 0 WHERE code = 'EIG'").run();
  assert.strictEqual((await world.admin.put(`/app/api/stock/items/${world.ids.EIG}/suppliers`, { suppliers: [{ supplierId: supplier.body.id, leadDays: 5, preferred: true }] })).status, 200);
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: OTHER.slug, discountPct: 3 }] })).status, 200, 'nieuwe catalogus');
  assert.match((await pageOf('EIG')).page.text, /Levertijd ca\. 6-7 dagen/);
});

test('beheerroutes: lezen, controleren, opslaan, rechten en tenantgrens', async () => {
  const world = await setup();
  const empty = await world.admin.get('/app/api/admin/delivery-rules');
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(empty.body.categories, []);
  assert.ok(empty.body.menu.some((node) => node.slug === CHILD.slug && node.depth === 2), 'het menu komt mee');
  const bad = [
    [{ categories: [{ categorySlug: 'bestaat-niet', rules: [{ method: 'dpd', minQty: 1 }] }] }, 'onbekende categorie'],
    [{ categories: [{ categorySlug: CHILD.slug, rules: [{ method: 'trein', minQty: 1 }] }] }, 'onbekende methode'],
    [{ categories: [{ categorySlug: CHILD.slug, rules: [{ method: 'dpd', minQty: 5, maxQty: 2 }] }] }, 'max onder min'],
    [{ categories: [{ categorySlug: CHILD.slug, rules: [{ method: 'dpd', minQty: 1 }] }, { categorySlug: CHILD.slug, rules: [{ method: 'pallet', minQty: 1 }] }] }, 'dubbel'],
    [{ regels: [] }, 'verkeerde vorm'],
  ];
  for (const [body, why] of bad) assert.strictEqual((await world.admin.put('/app/api/admin/delivery-rules', body)).status, 400, why);
  const saved = await world.admin.put('/app/api/admin/delivery-rules', { categories: [{ categorySlug: CHILD.slug, rules: [{ method: 'pallet', minQty: '100', maxQty: '' }] }, { categorySlug: PARENT.slug, rules: [] }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.deepStrictEqual(saved.body.categories, [{ categorySlug: CHILD.slug, rules: [{ method: 'pallet', minQty: 100, maxQty: null }] }], 'een categorie zonder regels valt weg');
  assert.deepStrictEqual((await world.admin.get('/app/api/admin/delivery-rules')).body.categories.length, 1);
  assert.strictEqual((await world.shoppers[0].client.get('/app/api/admin/delivery-rules')).status === 403, true, 'een klant mag niet bij het beheer');
  const other = await world.vreemd.get('/app/api/admin/delivery-rules');
  assert.notStrictEqual(other.status, 500);
  assert.ok(!other.body.categories || other.body.categories.length === 0, 'een andere organisatie ziet de regels niet');
});

test('artikel: regels en levertijd bewaren, controleren en bij een variant erven; leveranciertijd', async () => {
  const world = await setup();
  const { admin } = world;
  const made = await admin.post('/app/api/stock/items', { code: 'LEV', name: 'Levering', onHand: 5, salePrice: 5, deliveryRules: [{ method: 'pallet', minQty: 10 }], leadDays: { min: 4, max: 6 } });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const read = (await admin.get(`/app/api/stock/items/${made.body.id}`)).body;
  assert.deepStrictEqual(read.deliveryRules, [{ method: 'pallet', minQty: 10, maxQty: null }]);
  assert.deepStrictEqual(read.leadDays, { min: 4, max: 6 });
  const bad = await admin.put(`/app/api/stock/items/${made.body.id}`, { deliveryRules: [{ method: 'dpd', minQty: 9, maxQty: 2 }] });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.field, 'deliveryRules');
  const badLead = await admin.put(`/app/api/stock/items/${made.body.id}`, { leadDays: { min: 9, max: 2 } });
  assert.strictEqual(badLead.status, 400);
  assert.strictEqual(badLead.body.field, 'leadDays');
  assert.strictEqual((await admin.put(`/app/api/stock/items/${made.body.id}`, { name: 'Nieuwe naam' })).status, 200);
  const kept = (await admin.get(`/app/api/stock/items/${made.body.id}`)).body;
  assert.strictEqual(kept.deliveryRules.length, 1, 'een wijziging van iets anders laat de regels staan');
  assert.deepStrictEqual(kept.leadDays, { min: 4, max: 6 });
  const cleared = await admin.put(`/app/api/stock/items/${made.body.id}`, { deliveryRules: [], leadDays: { min: '', max: '' } });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  const empty = (await admin.get(`/app/api/stock/items/${made.body.id}`)).body;
  assert.deepStrictEqual([empty.deliveryRules, empty.leadDays], [[], null]);
  const supplier = await admin.post('/app/api/suppliers', { name: 'Groothandel Noord' });
  assert.strictEqual(supplier.status, 201, JSON.stringify(supplier.body));
  const linked = await admin.put(`/app/api/stock/items/${made.body.id}/suppliers`, { suppliers: [{ supplierId: supplier.body.id, leadDays: '5', preferred: true }] });
  assert.strictEqual(linked.status, 200, JSON.stringify(linked.body));
  assert.strictEqual((await admin.get(`/app/api/stock/items/${made.body.id}/suppliers`)).body.items[0].leadDays, 5);
  const wrong = await admin.put(`/app/api/stock/items/${made.body.id}/suppliers`, { suppliers: [{ supplierId: supplier.body.id, leadDays: '-3' }] });
  assert.strictEqual(wrong.status, 400);
  assert.strictEqual(wrong.body.field, 'leadDays');
});

test('levertijd tonen: zin voor mail en pagina, regels in gewone taal', () => {
  assert.strictEqual(Times.etaPhrase(null), '');
  assert.strictEqual(Times.etaPhrase({ text: '1-2 dagen', min: 1, max: 2 }), 'ca. 1-2 dagen');
  assert.strictEqual(Times.etaPhrase({ text: 'Direct', min: 0, max: 0 }), 'direct');
  assert.strictEqual(Times.etaPhrase({ text: 'Levertijd op aanvraag', min: null, max: null }), 'op aanvraag');
  assert.strictEqual(Times.etaSentence(null), '');
  assert.strictEqual(Times.etaSentence({ method: 'ophalen', eta: { text: 'Direct', min: 0, max: 0 } }), '', 'afhalen heeft geen levertijd');
  assert.strictEqual(Times.etaSentence({ method: 'dpd' }), '', 'oudere bestelling zonder momentopname');
  assert.match(Times.etaSentence({ method: 'dpd', eta: { text: '3-5 werkdagen', min: 3, max: 5 } }), /Verwachte levertijd: ca\. 3-5 werkdagen\. Dit is een indicatie en geen toezegging/);
  assert.match(Times.etaSentence({ method: 'dpd', eta: { text: 'Levertijd op aanvraag', min: null, max: null } }), /^Levertijd op aanvraag/);
  /**
   * De naam van een methode in de test.
   * @param {string} method De methode.
   * @returns {string} De naam.
   */
  const labelOf = (method) => ({ dpd: 'DPD', pallet: 'Pallet' }[method]);
  assert.strictEqual(Rules.describeRules(null, labelOf, 'st'), '');
  assert.strictEqual(Rules.describeRules([{ method: 'pallet', minQty: 100, maxQty: null }, { method: 'dpd', minQty: 1, maxQty: 99 }], labelOf, 'st'), 'DPD tot 99 st · Pallet vanaf 100 st');
  assert.strictEqual(Rules.describeRules([{ method: 'dpd', minQty: 5, maxQty: 9 }], labelOf, ''), 'DPD van 5 tot 9 stuks');
});

test('levertijd zichtbaar: mail, bestelpagina, productpagina en artikeloverzicht in Beheer', async () => {
  const world = await deliveryWorld();
  // Productpagina: de beperking staat in gewone taal bij het artikel (regels van de categorie).
  /**
   * Het adres van de productpagina van een testartikel.
   * @param {string} code De artikelcode.
   * @returns {string} Het deel van het adres na /product/.
   */
  const slug = (code) => `artikel-${code.toLowerCase()}-${code.toLowerCase()}`;
  const page = await world.customer.get(`/product/${slug('LOS')}/`);
  assert.match(page.text, /Bezorging: Bezorging door DPD tot 9 st · Bezorging per pallet vanaf 10 st/);
  assert.doesNotMatch((await world.customer.get(`/product/${slug('VRIJ')}/`)).text, /class="delivery-note/, 'zonder regels geen melding');
  // Bestelling: de bestelpagina toont de indicatieve levertijd, de mail de zin.
  await optionsAfter(world, [['VRIJ', 1]]);
  const placed = await postCheckout(world.base, world.customer, { ...PERSON, shippingMethod: 'dpd' });
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 300));
  const order = (await world.admin.get(`/app/api/admin/web-orders/${(await world.admin.get('/app/api/admin/web-orders')).body.items[0].id}`)).body.order;
  assert.strictEqual(order.shipping.eta.text, '2-3 dagen');
  const detail = await world.customer.get(`/bestelling/${order.id}/`);
  assert.match(detail.text, /Verwachte levertijd<\/strong><br>Ca\. 2-3 dagen/);
  assert.match(detail.text, /geen toezegging/);
  // De bevestigingsmail (op rekening) noemt de levertijd als indicatie en de melding aan het bedrijf ook.
  const confirmation = await until(() => world.sent.find((message) => /Bevestiging van je bestelling/.test(message.subject)));
  assert.match(confirmation.text, /Verwachte levertijd: ca\. 2-3 dagen\. Dit is een indicatie en geen toezegging/);
  // Afhalen: geen levertijdzin in de mail.
  await optionsAfter(world, [['VRIJ', 1]]);
  assert.strictEqual((await postCheckout(world.base, world.customer, { ...PERSON, shippingMethod: 'ophalen' })).status, 303);
  const pickup = await until(() => world.sent.filter((message) => /Bevestiging van je bestelling/.test(message.subject) && true)[1]);
  assert.doesNotMatch(pickup.text, /Verwachte levertijd/);
  // Artikeloverzicht in Beheer: per methode aantallen en levertijd, op en niet op voorraad.
  // Een afhaalbestelling toont geen levertijd op de bestelpagina, ook niet met een momentopname.
  assert.strictEqual((await postCheckout(world.base, world.customer, { ...PERSON, shippingMethod: 'ophalen' })).status, 303);
  const pickupId = (await world.admin.get('/app/api/admin/web-orders')).body.items.find((entry) => entry.id !== order.id).id;
  const pickupPage = await world.customer.get(`/bestelling/${pickupId}/`);
  assert.doesNotMatch(pickupPage.text, /Verwachte levertijd/);
  // Het overzicht in Beheer toont direct wat net is opgeslagen (de shop onthoudt levertijden 30 seconden).
  const before = (await world.admin.get(`/app/api/stock/items/${world.ids.VRIJ}/delivery-preview`)).body;
  assert.ok(before.methods.every((method) => /^2-3 /.test(method.leadInStock)));
  assert.strictEqual((await world.admin.put(`/app/api/stock/items/${world.ids.VRIJ}`, { leadDays: { min: 4, max: 6 } })).status, 200);
  assert.ok((await world.admin.get(`/app/api/stock/items/${world.ids.VRIJ}/delivery-preview`)).body.methods.every((method) => /^4-6 /.test(method.leadInStock)), 'geen oude gegevens uit het geheugen');
  const preview = await world.admin.get(`/app/api/stock/items/${world.ids.LOS}/delivery-preview`);
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  assert.strictEqual(preview.body.rulesSource, 'regels van de categorie');
  const dpd = preview.body.methods.find((method) => method.method === 'dpd');
  assert.deepStrictEqual([dpd.quantities, dpd.leadInStock, dpd.leadOutOfStock], ['tot 9 st', '1-2 dagen', 'op aanvraag']);
  assert.strictEqual(preview.body.methods.find((method) => method.method === 'pallet').quantities, 'vanaf 10 st');
  const own = before;
  assert.strictEqual(own.rulesSource, 'geen beperkingen');
  assert.ok(own.methods.every((method) => /^2-3 (werk)?dagen$/.test(method.leadInStock)), 'het artikel overschrijft elke methode');
  assert.ok(own.methods.some((method) => method.method === 'ophalen'));
  // Rechten en tenantgrens.
  assert.strictEqual((await world.shoppers[0].client.get(`/app/api/stock/items/${world.ids.LOS}/delivery-preview`)).status, 403);
  assert.strictEqual((await world.vreemd.get(`/app/api/stock/items/${world.ids.LOS}/delivery-preview`)).status, 404);
  assert.strictEqual((await world.admin.get('/app/api/stock/items/bestaat-niet/delivery-preview')).status, 404);
});
