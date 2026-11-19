// Voorraadtelling (artikelen/stock-counts.js): bevroren tellijst, blind tellen door de picker, een mutatie tijdens het tellen geeft geen vals verschil,
// hertellen, afsluiten met wachtwoord en alles-of-niets boeken, een jaartelling per jaar, idempotente ingaven, rechten en andere organisatie.
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/platform/store');
const { createLogin } = require('./helpers/http-client');
const { setup, PW } = require('./helpers/webshop-world');

/**
 * Wereld met een picker, drie artikelen met voorraad, prijs en locatie (BUS staat er al: 50 stuks, zonder prijs).
 * @returns {Promise<object>} De wereld met `picker` en `ids` per code.
 */
async function countWorld() {
  const world = await setup();
  const store = createStore(world.db);
  await store.createAccount(store.ensureTenant().id, { username: 'piet', displayName: 'Piet Picker', role: 'picker', password: PW, mustChangePassword: false });
  world.picker = await createLogin(world.base, { password: PW })('piet');
  world.ids = {};
  for (const [code, onHand, costPrice, location] of [['PIJP', 20, 2, 'A-2'], ['KRAAN', 10, 5, 'A-10']]) {
    const made = await world.admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, onHand, costPrice, salePrice: 9, location });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    world.ids[code] = made.body.id;
  }
  world.ids.BUS = world.db.prepare("SELECT id FROM stock_items WHERE code = 'BUS'").get().id;
  return world;
}

/**
 * Legt een getelde hoeveelheid vast als picker.
 * @param {object} world De wereld.
 * @param {string} countId Id van de telling.
 * @param {object} line De regel (id).
 * @param {number} qty Het getelde aantal.
 * @param {string} clientId Sleutel van de ingave.
 * @returns {Promise<object>} Het antwoord.
 */
const countLine = (world, countId, line, qty, clientId) => world.picker.post(`/app/api/orderpick/counts/${countId}/lines/${line.id}/count`, { qty, clientId });

test('jaartelling: bevroren lijst, blind tellen, verschil ten opzichte van het telmoment, afsluiten boekt alles', async () => {
  const world = await countWorld();
  const started = await world.admin.post('/app/api/stock-counts', { kind: 'jaar', referenceDate: '2025-12-31' });
  assert.strictEqual(started.status, 201, JSON.stringify(started.body));
  const count = started.body.count;
  assert.match(count.number, /^VT2025-01$/);
  assert.strictEqual(count.totals.lines, 3);
  // Een tweede lopende telling en een tweede jaartelling voor hetzelfde jaar kunnen niet.
  assert.strictEqual((await world.admin.post('/app/api/stock-counts', { kind: 'tussentijds' })).status, 409);

  // De picker ziet de open telling en de regels van een locatie, zonder verwacht aantal of prijs.
  const open = (await world.picker.get('/app/api/orderpick/counts/open')).body.count;
  assert.strictEqual(open.id, count.id);
  assert.ok(open.locations.some((location) => location.location === 'A-2'));
  const blind = (await world.picker.get(`/app/api/orderpick/counts/${count.id}/lines?location=A-2`)).body.lines;
  assert.strictEqual(blind.length, 1);
  assert.ok(!('expectedQty' in blind[0]) && !('unitCost' in blind[0]) && !('difference' in blind[0]));

  const staff = (await world.admin.get(`/app/api/stock-counts/${count.id}/lines`)).body.lines;
  const byCode = Object.fromEntries(staff.map((line) => [line.code, line]));
  assert.strictEqual(byCode.PIJP.expectedQty, 20);
  assert.strictEqual(byCode.PIJP.unitCost, 2);
  assert.strictEqual(byCode.PIJP.costSource, 'fifo');
  assert.strictEqual(byCode.BUS.costSource, 'onbekend');

  // PIJP: geteld 18 (verschil −2). KRAAN wordt geteld nadat er 5 zijn ontvangen (mutatie na het bevriezen): geteld 15 = geen verschil.
  assert.strictEqual((await countLine(world, count.id, byCode.PIJP, 18, 'tel-pijp-0001')).status, 200);
  assert.strictEqual((await world.admin.post(`/app/api/stock/items/${world.ids.KRAAN}/movements`, { kind: 'ontvangst', qty: 5, note: 'Tijdens de telling' })).status, 201);
  assert.strictEqual((await countLine(world, count.id, byCode.KRAAN, 15, 'tel-kraan-0001')).status, 200);
  // Dezelfde ingave nog eens (herhaalde tik) wijzigt niets en boekt niet dubbel.
  const repeated = await countLine(world, count.id, byCode.PIJP, 18, 'tel-pijp-0001');
  assert.strictEqual(repeated.status, 200);
  assert.strictEqual(repeated.body.repeated, true);
  assert.strictEqual((await countLine(world, count.id, byCode.KRAAN, 15, 'tel-pijp-0001')).status, 409, 'dezelfde sleutel voor een andere regel kan niet');

  const mid = (await world.admin.get(`/app/api/stock-counts/${count.id}/lines?filter=verschillen`)).body.lines;
  assert.deepStrictEqual(mid.map((line) => line.code), ['PIJP'], 'KRAAN geeft geen vals verschil');
  assert.strictEqual(mid[0].difference, -2);
  assert.strictEqual(mid[0].differenceValue, -4);

  // Afsluiten: wachtwoord nodig, niet-getelde regels (BUS) vragen een keuze, de picker mag niet afsluiten.
  assert.strictEqual((await world.picker.post(`/app/api/stock-counts/${count.id}/close`, { password: PW, open: 'nul' })).status, 403);
  assert.strictEqual((await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: 'fout', open: 'nul' })).status, 401);
  const needChoice = await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: PW });
  assert.strictEqual(needChoice.status, 409);
  assert.strictEqual(needChoice.body.error, 'open_lines');
  const closed = await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: PW, open: 'ongewijzigd' });
  assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
  assert.strictEqual(closed.body.booked, 1);
  assert.strictEqual(closed.body.count.status, 'afgesloten');
  assert.strictEqual(closed.body.count.totals.valueCounted, 18 * 2 + 15 * 5);

  /**
   * De voorraadstand van een artikel uit de database.
   * @param {string} code De artikelcode.
   * @returns {number} De stand.
   */
  const onHand = (code) => world.db.prepare('SELECT on_hand FROM stock_items WHERE id = ?').get(world.ids[code]).on_hand;
  assert.strictEqual(onHand('PIJP'), 18);
  assert.strictEqual(onHand('KRAAN'), 15);
  assert.strictEqual(onHand('BUS'), 50);
  const move = world.db.prepare("SELECT qty, source, kind FROM stock_movements WHERE item_id = ? AND kind = 'telling'").get(world.ids.PIJP);
  assert.deepStrictEqual({ ...move }, { qty: -2, source: 'telling:VT2025-01', kind: 'telling' });

  // Vergrendeld: niet meer tellen, niet nog eens afsluiten; een tweede jaartelling voor 2025 kan niet.
  assert.strictEqual((await countLine(world, count.id, byCode.PIJP, 1, 'tel-pijp-0002')).status, 409);
  assert.strictEqual((await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: PW, open: 'nul' })).status, 409);
  const again = await world.admin.post('/app/api/stock-counts', { kind: 'jaar', referenceDate: '2025-06-30' });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'year_done');

  // Het verslag bevat regels met verschil en het logboek van alle ingaven; de audit kent de gebeurtenissen.
  const report = (await world.admin.get(`/app/api/stock-counts/${count.id}/report`)).body;
  assert.strictEqual(report.lines.length, 3);
  assert.strictEqual(report.entries.length, 2);
  const actions = world.db.prepare("SELECT action FROM audit WHERE action LIKE 'voorraadtelling_%'").all().map((row) => row.action);
  for (const action of ['voorraadtelling_gestart', 'voorraadtelling_ingave', 'voorraadtelling_afgesloten']) assert.ok(actions.includes(action), action);
  // Een artikel met telregels wordt gearchiveerd in plaats van verwijderd.
  const removed = await world.admin.del(`/app/api/stock/items/${world.ids.PIJP}`);
  assert.strictEqual(removed.status, 200);
  assert.ok(world.db.prepare('SELECT archived FROM stock_items WHERE id = ?').get(world.ids.PIJP).archived);
});

test('hertellen: regels boven de drempel gaan terug naar de teller en moeten opnieuw geteld of geaccepteerd worden', async () => {
  const world = await countWorld();
  const count = (await world.admin.post('/app/api/stock-counts', { kind: 'tussentijds', threshold: { amount: 5, pct: 0 } })).body.count;
  const lines = (await world.admin.get(`/app/api/stock-counts/${count.id}/lines`)).body.lines;
  const pijp = lines.find((line) => line.code === 'PIJP');
  await countLine(world, count.id, pijp, 10, 'tel-herhaal-01');
  const flagged = (await world.admin.get(`/app/api/stock-counts/${count.id}/lines?filter=hertellen`)).body.lines;
  assert.deepStrictEqual(flagged.map((line) => line.code), ['PIJP'], 'verschil van 20 euro is boven de drempel van 5');
  const marked = await world.admin.post(`/app/api/stock-counts/${count.id}/recount`, { overThreshold: true });
  assert.strictEqual(marked.body.marked, 1);
  const blind = (await world.picker.get(`/app/api/orderpick/counts/${count.id}/lines?location=A-2`)).body.lines[0];
  assert.strictEqual(blind.status, 'hertellen');
  assert.strictEqual(blind.countedQty, null, 'de teller ziet het eerdere aantal niet');
  const refused = await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: PW, open: 'ongewijzigd' });
  assert.strictEqual(refused.body.error, 'recount_open');
  assert.strictEqual((await countLine(world, count.id, pijp, 20, 'tel-herhaal-02')).status, 200);
  const closed = await world.admin.post(`/app/api/stock-counts/${count.id}/close`, { password: PW, open: 'nul' });
  assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
  // Niet geteld + "als 0 tellen": BUS en KRAAN gaan naar 0.
  assert.strictEqual(world.db.prepare('SELECT on_hand FROM stock_items WHERE id = ?').get(world.ids.KRAAN).on_hand, 0);
  assert.strictEqual(closed.body.booked, 2);
});

test('voorraadtelling: annuleren, locatiebereik, invoer controleren, rechten en andere organisatie', async () => {
  const world = await countWorld();
  assert.strictEqual((await world.admin.post('/app/api/stock-counts', { kind: 'jaar', locations: ['A-2'] })).status, 400, 'een jaartelling omvat alle locaties');
  assert.strictEqual((await world.admin.post('/app/api/stock-counts', { kind: 'onzin' })).status, 400);
  assert.strictEqual((await world.admin.post('/app/api/stock-counts', { referenceDate: '2999-01-01' })).status, 400);
  const partial = (await world.admin.post('/app/api/stock-counts', { kind: 'tussentijds', locations: ['A-2'] })).body.count;
  assert.strictEqual(partial.totals.lines, 1);
  const line = (await world.admin.get(`/app/api/stock-counts/${partial.id}/lines`)).body.lines[0];
  assert.strictEqual((await countLine(world, partial.id, line, -1, 'tel-ongeldig-01')).status, 400);
  assert.strictEqual((await world.picker.post(`/app/api/orderpick/counts/${partial.id}/lines/${line.id}/count`, { qty: 1, clientId: 'x' })).status, 400);
  // Rechten: de picker beheert niet; een andere organisatie ziet de telling niet.
  assert.strictEqual((await world.picker.get('/app/api/stock-counts')).status, 403);
  assert.strictEqual((await world.picker.post('/app/api/stock-counts', { kind: 'tussentijds' })).status, 403);
  assert.strictEqual((await world.vreemd.get(`/app/api/stock-counts/${partial.id}`)).status, 404);
  assert.strictEqual((await world.vreemd.get(`/app/api/stock-counts/${partial.id}/report`)).status, 404);
  assert.strictEqual((await world.vreemd.post(`/app/api/stock-counts/${partial.id}/cancel`, {})).status, 404);
  assert.strictEqual((await world.vreemd.get('/app/api/orderpick/counts/open')).body.count, null);
  const cancelled = await world.admin.post(`/app/api/stock-counts/${partial.id}/cancel`, {});
  assert.strictEqual(cancelled.status, 200);
  assert.strictEqual(cancelled.body.count.status, 'geannuleerd');
  assert.strictEqual((await countLine(world, partial.id, line, 3, 'tel-na-annuleren')).status, 409);
  assert.strictEqual((await world.picker.get('/app/api/orderpick/counts/open')).body.count, null);
  assert.strictEqual(world.db.prepare('SELECT on_hand FROM stock_items WHERE id = ?').get(world.ids.PIJP).on_hand, 20, 'annuleren boekt niets');
});

test('ingave met het tijdstip van de teller: een late ingave telt voor het juiste moment, een onmogelijk tijdstip wordt servertijd', async () => {
  const world = await countWorld();
  const count = (await world.admin.post('/app/api/stock-counts', { kind: 'tussentijds', locations: ['A-2'] })).body.count;
  const line = (await world.admin.get(`/app/api/stock-counts/${count.id}/lines`)).body.lines[0];
  const early = new Date(Date.now() - 1000).toISOString();
  const frozen = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.ok(frozen < early);
  // Een tijdstip vóór het bevriezen en een tijdstip in de toekomst worden genegeerd (servertijd).
  await world.picker.post(`/app/api/orderpick/counts/${count.id}/lines/${line.id}/count`, { qty: 20, clientId: 'tel-moment-0001', countedAt: frozen });
  let stored = world.db.prepare('SELECT counted_at FROM stock_count_lines WHERE id = ?').get(line.id).counted_at;
  assert.ok(stored > early, 'tijdstip vóór het bevriezen wordt servertijd');
  await world.picker.post(`/app/api/orderpick/counts/${count.id}/lines/${line.id}/count`, { qty: 20, clientId: 'tel-moment-0002', countedAt: '2999-01-01T00:00:00.000Z' });
  stored = world.db.prepare('SELECT counted_at FROM stock_count_lines WHERE id = ?').get(line.id).counted_at;
  assert.ok(stored < '2999', 'tijdstip in de toekomst wordt servertijd');
  // Een geldig tijdstip tussen bevriezen en nu wordt overgenomen.
  const frozenAt = world.db.prepare('SELECT frozen_at FROM stock_counts WHERE id = ?').get(count.id).frozen_at;
  const middle = new Date(new Date(frozenAt).getTime() + 1).toISOString();
  await world.picker.post(`/app/api/orderpick/counts/${count.id}/lines/${line.id}/count`, { qty: 20, clientId: 'tel-moment-0003', countedAt: middle });
  assert.strictEqual(world.db.prepare('SELECT counted_at FROM stock_count_lines WHERE id = ?').get(line.id).counted_at, middle);
});
