// Artikelen (voorheen Voorraadbeheer): artikelen, mutaties, reserveren vanuit de materiaallijst van
// een werkorder en afboeken (met de hand, via verbruik of bij Gereed).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore, sanitizeItem, needsOf } = require('../src/artikelen/stock');
const { transaction } = require('../src/database/db');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder, installateur, planner en klant, plus een testserver.
 * @returns {Promise<object>} db, server, as (inloggen) en main.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  const as = createLogin(base, { password: PW });
  return { db, server, as, main };
}

/**
 * Maakt een geaccordeerde offerte met materiaalregels en daaruit een werkorder.
 * @param {object} client Ingelogde client.
 * @param {Array<[string, number]>} lines Materiaal als [code, aantal].
 * @returns {Promise<object>} De werkorder.
 */
async function workOrder(client, lines) {
  const quote = (await client.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet' },
    lines: [...lines.map(([code, qty]) => ({ section: 'materiaal', code, description: code, qty, unit: 'st', price: 1 })),
      { section: 'arbeid', description: 'Sleuven graven', qty: 4, unit: 'uur', price: 55 }] } })).body;
  assert.strictEqual((await client.put(`/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
  const wo = await client.post('/api/workorders', { quoteId: quote.id });
  assert.strictEqual(wo.status, 201, JSON.stringify(wo.body));
  return wo.body;
}

test('voorraad: artikel opschonen en benodigd per code', () => {
  assert.deepStrictEqual(sanitizeItem({ code: ' pe-25 ', name: ' PE-buis ', minQty: '5', costPrice: '0.849' }).value,
    { code: 'PE-25', name: 'PE-buis', unit: 'st', location: '', notes: '', minQty: 5, reorderQty: null, costPrice: 0.85, salePrice: null, vatRate: 21, revenueGroup: 'producten', shopSync: true });
  assert.strictEqual(sanitizeItem({ code: '', name: 'x' }).field, 'code');
  assert.strictEqual(sanitizeItem({ code: 'A B;C', name: 'x' }).field, 'code');
  assert.strictEqual(sanitizeItem({ code: 'A', name: '' }).field, 'name');
  assert.strictEqual(sanitizeItem({ code: 'A', name: 'x', minQty: -1 }).field, 'minQty');
  assert.strictEqual(sanitizeItem({ code: 'A', name: 'x', reorderQty: 'veel' }).field, 'reorderQty');
  const need = needsOf([{ code: 'pe-25', qty: 10 }, { code: 'PE-25', qty: 2.5 }, { code: '', qty: 3 }, { code: 'X', qty: -1 }]);
  assert.deepStrictEqual([...need.entries()].map(([code, need]) => [code, need.qty]), [['PE-25', 12.5]]);
});

test('voorraad: reserveren vanuit de werkorder, afboeken bij Gereed, mutaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const wo = await workOrder(kees, [['PE-25', 50], ['VAL-24V', 3], ['TAPE', 1]]);

    // Uit de catalogus op voorraad: de open werkorder reserveert meteen.
    const imp = await kees.post('/api/stock/import', { codes: ['PE-25', 'val-24v', 'FIT-T-25'] });
    assert.deepStrictEqual(imp.body, { created: 3, existing: 0 });
    assert.strictEqual((await kees.post('/api/stock/import', { codes: ['BESTAAT-NIET'] })).status, 400);
    let items = (await kees.get('/api/stock')).body.items;
    const pe = items.find((i) => i.code === 'PE-25');
    const val = items.find((i) => i.code === 'VAL-24V');
    assert.strictEqual(pe.name, 'PE-buis 25 mm PN6');
    assert.strictEqual(pe.unit, 'm');
    assert.strictEqual(pe.reserved, 50);
    assert.strictEqual(pe.available, -50);

    // Ontvangst, telling en correctie.
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'ontvangst', qty: 100, note: 'Pakbon 1' })).status, 201);
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'ontvangst', qty: -5 })).status, 400);
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'correctie', qty: -2 })).status, 400, 'correctie vraagt een reden');
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'correctie', qty: -2, note: 'Beschadigd' })).status, 201);
    const counted = (await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'telling', qty: 95 })).body;
    assert.strictEqual(counted.onHand, 95);
    assert.deepStrictEqual(counted.movements.map((movement) => [movement.kind, movement.qty, movement.balance]), [['telling', -3, 95], ['correctie', -2, 98], ['ontvangst', 100, 100]]);
    await kees.post(`/api/stock/items/${val.id}/movements`, { kind: 'ontvangst', qty: 2 });

    // Op de werkorder: nodig, gereserveerd, tekort en wat niet op voorraad is.
    let overview = (await kees.get(`/api/stock/workorders/${wo.id}`)).body;
    /**
     * Regel van de voorraadweergave voor één artikelcode.
     * @param {string} code Artikelcode.
     * @returns {object} De regel.
     */
    const line = (code) => overview.lines.find((line) => line.code === code);
    assert.deepStrictEqual([line('PE-25').needed, line('PE-25').reserved, line('PE-25').shortage], [50, 50, 0]);
    assert.deepStrictEqual([line('VAL-24V').needed, line('VAL-24V').shortage], [3, 1]);
    assert.deepStrictEqual(overview.notInStock.map((material) => material.code), ['TAPE']);

    // Materiaallijst aanpassen: de reservering volgt.
    const data = (await kees.get(`/api/workorders/${wo.id}`)).body.data;
    data.materials.find((material) => material.code === 'PE-25').qty = 60;
    assert.strictEqual((await kees.put(`/api/workorders/${wo.id}`, { data })).status, 200);
    assert.strictEqual((await kees.get('/api/stock')).body.items.find((i) => i.code === 'PE-25').reserved, 60);

    // Met de hand afboeken (en een retour).
    overview = (await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'pe-25', qty: 40 }] })).body;
    assert.deepStrictEqual([line('PE-25').issued, line('PE-25').reserved], [40, 20]);
    overview = (await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'PE-25', qty: -5 }] })).body;
    assert.deepStrictEqual([line('PE-25').issued, line('PE-25').reserved], [35, 25]);
    assert.strictEqual((await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'TAPE', qty: 1 }] })).status, 400);

    // Gereed: de rest van de reservering wordt afgeboekt.
    assert.strictEqual((await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' })).status, 200);
    items = (await kees.get('/api/stock')).body.items;
    assert.strictEqual(items.find((i) => i.code === 'PE-25').onHand, 95 - 60);
    assert.strictEqual(items.find((i) => i.code === 'VAL-24V').onHand, -1, 'tekort wordt zichtbaar als negatieve stand');
    assert.ok(items.every((i) => i.reserved === 0));
    overview = (await kees.get(`/api/stock/workorders/${wo.id}`)).body;
    assert.ok(overview.movements.some((movement) => movement.source === 'gereed' && movement.workOrderNumber === wo.number));
    // Nogmaals opslaan als gereed boekt niets dubbel.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' });
    assert.strictEqual((await kees.get('/api/stock')).body.items.find((i) => i.code === 'PE-25').onHand, 35);

    // Een geannuleerde werkorder geeft zijn reservering vrij.
    const wo2 = await workOrder(kees, [['PE-25', 10]]);
    assert.strictEqual((await kees.get('/api/stock/reservations')).body.items.length, 1);
    await kees.put(`/api/workorders/${wo2.id}`, { status: 'geannuleerd' });
    assert.strictEqual((await kees.get('/api/stock/reservations')).body.items.length, 0);

    // Mutaties voor de export, met een periode.
    const all = (await baas.get('/api/stock/movements')).body.items;
    assert.ok(all.length >= 8);
    assert.strictEqual((await baas.get('/api/stock/movements?from=2000-01-01&to=2000-01-02')).body.items.length, 0);
    assert.strictEqual((await baas.get('/api/stock/movements?from=gisteren')).status, 400);

    // Code wijzigen kan niet meer na boekingen op werkorders; verwijderen archiveert.
    assert.strictEqual((await kees.put(`/api/stock/items/${pe.id}`, { code: 'PE-25-OUD' })).status, 409);
    const fit = items.find((i) => i.code === 'FIT-T-25');
    assert.strictEqual((await kees.put(`/api/stock/items/${fit.id}`, { code: 'FIT-T-25B', location: 'Bus 2' })).body.location, 'Bus 2');
    assert.deepStrictEqual((await kees.del(`/api/stock/items/${fit.id}`)).body, { deleted: true, code: 'FIT-T-25B' });
    assert.strictEqual((await kees.del(`/api/stock/items/${pe.id}`)).body.archived, true);
    assert.ok(!(await kees.get('/api/stock')).body.items.some((i) => i.code === 'PE-25'));
    assert.ok((await kees.get('/api/stock?archived=1')).body.items.some((i) => i.code === 'PE-25' && i.archived));
    assert.strictEqual((await kees.post('/api/stock/items', { code: 'VAL-24V', name: 'Dubbel' })).status, 409);
  } finally {
    server.close();
  }
});

test('voorraad: verbruik boeken is idempotent per verbruiksregel; met verbruik vervalt de rest bij Gereed', async () => {
  const { db, server, as, main } = await setup();
  try {
    const kees = await as('kees');
    const wo = await workOrder(kees, [['PE-25', 50]]);
    const item = (await kees.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis', unit: 'm', onHand: 80 })).body;
    assert.strictEqual(item.onHand, 80);
    assert.strictEqual(item.reserved, 50);
    const stock = createStockStore(db);
    const user = { id: 'u1', display_name: 'Kees' };
    /**
     * Huidige stand van het artikel.
     * @returns {number} Aantal op voorraad.
     */
    const onHand = () => stock.get(main, item.id).onHand;
    const first = stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'pe-25', qty: 30, user });
    assert.ok(first);
    assert.strictEqual(onHand(), 50);
    assert.strictEqual(stock.get(main, item.id).reserved, 20);
    assert.strictEqual(stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'PE-25', qty: 30, user }), first, 'zelfde regel nogmaals: niets nieuws');
    assert.strictEqual(onHand(), 50);
    stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'PE-25', qty: 35, user });
    assert.strictEqual(onHand(), 45, 'alleen het verschil');
    stock.syncUsage(main, { usageId: 'v2', workOrderId: wo.id, code: 'PE-25', qty: -2, user });
    assert.strictEqual(onHand(), 47, 'negatief = retour');
    stock.syncUsage(main, { usageId: 'v2', workOrderId: wo.id, code: 'PE-25', qty: 0, user });
    assert.strictEqual(onHand(), 45, 'regel verwijderd');
    // Binnen de transactie van de materiaalregistratie (nested).
    transaction(db, () => stock.syncUsage(main, { usageId: 'v4', workOrderId: wo.id, code: 'PE-25', qty: 1, user }, { nested: true }));
    assert.strictEqual(onHand(), 44);
    stock.syncUsage(main, { usageId: 'v4', workOrderId: wo.id, code: 'PE-25', qty: 0, user });
    assert.strictEqual(stock.syncUsage(main, { usageId: 'v3', workOrderId: wo.id, code: 'GEEN-VOORRAAD', qty: 3, user }), null);
    // Via de materiaalregistratie op de werkorder (zelfde transactie, id terug in stock_movement_id).
    const day = new Date().toISOString().slice(0, 10);
    const used = await kees.post(`/api/workorders/${wo.id}/materials`, { usedOn: day, code: 'PE-25', description: 'PE-buis', unit: 'm', qty: 5 });
    assert.strictEqual(used.status, 201, JSON.stringify(used.body));
    assert.strictEqual(onHand(), 40);
    const entry = used.body.entry || used.body;
    assert.ok(entry.stockMovementId, 'afboeking gekoppeld aan de verbruiksregel');
    assert.strictEqual((await kees.del(`/api/workorders/${wo.id}/materials/${entry.id}`)).status, 200);
    assert.strictEqual(onHand(), 45, 'verwijderde regel wordt teruggeboekt');
    // Gereed: er is verbruik, dus de rest van de reservering (15) vervalt zonder afboeking.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' });
    assert.strictEqual(onHand(), 45);
    assert.strictEqual(stock.get(main, item.id).reserved, 0);
  } finally {
    server.close();
  }
});

test('voorraad: rechten en scheiding tussen organisaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const pien = await as('pien');
    const klant = await as('klant');
    const wo = await workOrder(kees, [['PE-25', 5]]);
    const item = (await kees.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis' })).body;

    // Planner: geen voorraadbeheer, wel de voorraad van een werkorder.
    assert.strictEqual((await pien.get('/api/stock')).status, 403);
    assert.strictEqual((await pien.post('/api/stock/items', { code: 'X', name: 'X' })).status, 403);
    assert.strictEqual((await pien.get('/api/stock/reorder')).status, 403);
    assert.strictEqual((await pien.get(`/api/stock/workorders/${wo.id}`)).status, 200);
    // Klant: niets.
    assert.strictEqual((await klant.get('/api/stock')).status, 403);
    assert.strictEqual((await klant.get(`/api/stock/workorders/${wo.id}`)).status, 403);
    assert.strictEqual((await klant.post(`/api/stock/workorders/${wo.id}/issue`, {})).status, 403);

    // Andere organisatie: 404 op artikel en werkorder.
    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/api/stock')).body.items, []);
    assert.deepStrictEqual((await piet.get('/api/stock/reorder')).body, { items: [], total: null });
    assert.strictEqual((await piet.get(`/api/stock/items/${item.id}`)).status, 404);
    assert.strictEqual((await piet.put(`/api/stock/items/${item.id}`, { name: 'Gekaapt' })).status, 404);
    assert.strictEqual((await piet.post(`/api/stock/items/${item.id}/movements`, { kind: 'ontvangst', qty: 1 })).status, 404);
    assert.strictEqual((await piet.del(`/api/stock/items/${item.id}`)).status, 404);
    assert.strictEqual((await piet.get(`/api/stock/workorders/${wo.id}`)).status, 404);
    assert.strictEqual((await piet.post(`/api/stock/workorders/${wo.id}/issue`, {})).status, 404);
    // Een eigen artikel met dezelfde code mag in de andere organisatie.
    assert.strictEqual((await piet.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis' })).status, 201);
  } finally {
    server.close();
  }
});

test('voorraad: bestelvoorstel vult aan tot Bestellen tot (leeg = 2× minimum), gereserveerd telt mee', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    // Ruim voorraad: niet in het voorstel.
    await kees.post('/api/stock/items', { code: 'VOL', name: 'Genoeg', minQty: 2, onHand: 10, costPrice: 1 });
    // Onder het minimum, zonder Bestellen tot: aanvullen tot 2× minimum (10 − 3 = 7).
    await kees.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis', unit: 'm', minQty: 5, onHand: 3, costPrice: 0.85 });
    // Met Bestellen tot en een reservering: beschikbaar 4 − 3 = 1, aanvullen tot 20,5 = 19,5 → 20 hele eenheden.
    await kees.post('/api/stock/items', { code: 'VAL-24V', name: 'Klep', minQty: 2, reorderQty: 20.5, onHand: 4 });
    await workOrder(kees, [['VAL-24V', 3]]);
    // Minimum 0 maar meer gereserveerd dan er ligt: het tekort (2) komt erin.
    await kees.post('/api/stock/items', { code: 'BOX-STD', name: 'Kleppenput', onHand: 1 });
    await workOrder(kees, [['BOX-STD', 3]]);
    // Gearchiveerd telt niet mee.
    const old = (await kees.post('/api/stock/items', { code: 'OUD', name: 'Oud', minQty: 5 })).body;
    await kees.put(`/api/stock/items/${old.id}`, { archived: true });

    const proposal = (await kees.get('/api/stock/reorder')).body;
    assert.deepStrictEqual(proposal.items.map((item) => [item.code, item.available, item.target, item.orderQty, item.amount]),
      [['BOX-STD', -2, 0, 2, null], ['PE-25', 3, 10, 7, 5.95], ['VAL-24V', 1, 20.5, 20, null]]);
    assert.strictEqual(proposal.total, 5.95);
    // Bestellen tot leegmaken: terug naar 2× minimum.
    const valve = proposal.items[2];
    assert.strictEqual((await kees.put(`/api/stock/items/${valve.id}`, { reorderQty: '' })).body.reorderQty, null);
    assert.strictEqual((await kees.get('/api/stock/reorder')).body.items[2].orderQty, 3);
  } finally {
    server.close();
  }
});

test('voorraad: eenheden beheren, een gebruikte eenheid blijft staan, andere organisatie en rechten', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const pien = await as('pien');
    const standard = (await kees.get('/api/stock/units')).body.items;
    assert.ok(['st', 'm', 'rol'].every((name) => standard.some((unit) => unit.name === name)));

    // Aanmaken: dubbel (ook met andere hoofdletters) en leeg worden geweigerd.
    const made = await kees.post('/api/stock/units', { name: 'Pallet' });
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await kees.post('/api/stock/units', { name: 'pallet' })).status, 409);
    assert.strictEqual((await kees.post('/api/stock/units', { name: '  ' })).status, 400);

    // Een artikel met een nieuwe eenheid zet die vanzelf in de lijst; in gebruik = niet te verwijderen.
    const item = (await kees.post('/api/stock/items', { code: 'ZAND', name: 'Zand', unit: 'Pallet' })).body;
    const used = (await kees.get('/api/stock/units')).body.items.find((unit) => unit.name === 'Pallet');
    assert.strictEqual(used.items, 1);
    assert.strictEqual((await kees.del(`/api/stock/units/${made.body.id}`)).status, 409);
    await kees.put(`/api/stock/items/${item.id}`, { unit: 'rol' });
    assert.strictEqual((await kees.del(`/api/stock/units/${made.body.id}`)).status, 200);
    assert.strictEqual((await kees.del(`/api/stock/units/${made.body.id}`)).status, 404);

    // Een onbekende eenheid bij een nieuw artikel komt atomair in de lijst; ook via de catalogusimport.
    assert.strictEqual((await kees.post('/api/stock/items', { code: 'BAK-1', name: 'Bak', unit: 'bak' })).status, 201);
    await kees.post('/api/stock/import', { codes: ['PE-25'] });
    const names = (await kees.get('/api/stock/units')).body.items.map((unit) => unit.name);
    assert.ok(names.includes('bak') && names.includes('m'));
    assert.strictEqual(names.filter((name) => name === 'bak').length, 1);

    // Rechten en scheiding tussen organisaties.
    assert.strictEqual((await pien.get('/api/stock/units')).status, 403);
    assert.strictEqual((await pien.post('/api/stock/units', { name: 'x' })).status, 403);
    await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    const other = (await piet.get('/api/stock/units')).body.items;
    assert.ok(!other.some((unit) => unit.name === 'Pallet'));
    assert.strictEqual((await piet.del(`/api/stock/units/${used.id}`)).status, 404);
    // De laatste eenheid blijft staan (anders zou de standaardlijst terugkomen).
    for (const unit of other.slice(0, -1)) assert.strictEqual((await piet.del(`/api/stock/units/${unit.id}`)).status, 200);
    const last = (await piet.get('/api/stock/units')).body.items;
    assert.strictEqual(last.length, 1);
    assert.strictEqual((await piet.del(`/api/stock/units/${last[0].id}`)).status, 409);
    assert.strictEqual((await piet.get('/api/stock/units')).body.items.length, 1);
  } finally {
    server.close();
  }
});
