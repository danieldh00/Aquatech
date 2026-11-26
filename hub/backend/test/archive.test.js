// Archief: archiveren, terughalen, bulkselectie, lijstfilter en definitief verwijderen (met bewaarplicht voor facturen en behoud van leerdata).
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createArchive } = require('../src/platform/archive');

/**
 * Maakt een database met één omgeving, een eigenaar en een archief-object.
 * @returns {{ db: object, store: object, archive: object, tenantId: string, ownerId: string, otherId: string }} De onderdelen.
 */
function setup() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant('archief-hoofd', 'Hoofd').id;
  const otherId = store.ensureTenant('archief-ander', 'Ander').id;
  const ownerId = store.systemUser(tenantId, 'archief-systeem', 'Systeem').id;
  const archive = createArchive(db, { customerRoleKeys: () => [], purgePlan: (tenant, id) => store.purgePlan(tenant, id), today: () => new Date('2026-11-26T12:00:00Z') });
  return { db, store, archive, tenantId, ownerId, otherId };
}

/**
 * Voegt een offerte toe.
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string} ownerId De eigenaar.
 * @param {string} number Het nummer.
 * @param {string} customer De klantnaam.
 * @param {string} createdAt Aanmaakdatum.
 * @returns {string} Het id.
 */
function addQuote(db, tenantId, ownerId, number, customer, createdAt = '2026-11-01') {
  const id = randomUUID();
  db.prepare('INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tenantId, ownerId, number, 'verzonden', 'Tuin', customer, 100, '{}', createdAt, createdAt);
  return id;
}

/**
 * Voegt een factuur toe.
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string} number Het nummer.
 * @param {string} status Status.
 * @param {string} date Factuurdatum.
 * @returns {string} Het id.
 */
function addInvoice(db, tenantId, number, status, date) {
  const id = randomUUID();
  db.prepare('INSERT INTO invoices (id, tenant_id, number, status, invoice_date, due_date, total, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tenantId, number, status, date, date, 10, '{}', date, date);
  return id;
}

test('archiveren haalt een offerte uit de standaardselectie en terughalen zet hem terug', () => {
  const { db, archive, tenantId, ownerId } = setup();
  const id = addQuote(db, tenantId, ownerId, 'T1', 'Test BV');
  assert.strictEqual(archive.archive(tenantId, 'offertes', [id]).changed, 1);
  assert.strictEqual(archive.counts(tenantId).offertes.active, 0);
  assert.strictEqual(archive.counts(tenantId).offertes.archived, 1);
  assert.strictEqual(archive.archive(tenantId, 'offertes', [id]).changed, 0, 'al gearchiveerd');
  assert.strictEqual(archive.restore(tenantId, 'offertes', [id]), 1);
  assert.strictEqual(archive.counts(tenantId).offertes.active, 1);
});

test('een andere omgeving kan niets archiveren en niets zien', () => {
  const { db, archive, tenantId, ownerId, otherId } = setup();
  const id = addQuote(db, tenantId, ownerId, 'T1', 'Test BV');
  assert.strictEqual(archive.archive(otherId, 'offertes', [id]).changed, 0);
  assert.strictEqual(archive.preview(otherId, {}).total, 0);
});

test('bulk: voorbeeld en archiveren op datum en zoekterm', () => {
  const { db, archive, tenantId, ownerId } = setup();
  addQuote(db, tenantId, ownerId, 'T1', 'Test BV', '2026-09-01');
  addQuote(db, tenantId, ownerId, 'T2', 'Test BV', '2026-11-20');
  addQuote(db, tenantId, ownerId, 'T3', 'Familie Jansen', '2026-09-01');
  const preview = archive.preview(tenantId, { kinds: ['offertes'], before: '2026-10-01', query: 'test' });
  assert.strictEqual(preview.total, 1);
  assert.strictEqual(preview.kinds.offertes.sample[0].number, 'T1');
  assert.deepStrictEqual(archive.archiveMatching(tenantId, { kinds: ['offertes'], before: '2026-10-01', query: 'test' }), { offertes: { changed: 1, skipped: 0 } });
  assert.strictEqual(archive.counts(tenantId).offertes.active, 2);
});

test('definitief verwijderen: concept weg, recente definitieve factuur geblokkeerd, oude definitieve factuur weg', () => {
  const { db, archive, tenantId } = setup();
  const concept = addInvoice(db, tenantId, null, 'concept', '2026-11-01');
  const recent = addInvoice(db, tenantId, 'F2026-0001', 'betaald', '2026-10-01');
  const old = addInvoice(db, tenantId, 'F2017-0001', 'betaald', '2017-01-01');
  archive.archive(tenantId, 'facturen', [concept, recent, old]);
  const result = archive.purge(tenantId, { kinds: ['facturen'] });
  assert.strictEqual(result.deleted.facturen, 2);
  assert.strictEqual(result.blocked.length, 1);
  assert.match(result.blocked[0].reason, /Bewaarplicht/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ?').get(tenantId).n, 1);
});

test('verwijderen raakt alleen gearchiveerde stukken', () => {
  const { db, archive, tenantId, ownerId } = setup();
  addQuote(db, tenantId, ownerId, 'T1', 'Test BV');
  const result = archive.purge(tenantId, {});
  assert.strictEqual(result.deleted.offertes, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE tenant_id = ?').get(tenantId).n, 1);
});

test('een plan verwijderen laat de geleerde herkenning staan', () => {
  const { db, archive, tenantId, ownerId } = setup();
  const planId = randomUUID();
  db.prepare('INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(planId, tenantId, ownerId, 'Testplan', 'Test BV', '', '{}', '2026-11-01', '2026-11-01');
  db.prepare('INSERT INTO plan_recognitions (id, tenant_id, source, plan_id, samples, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), tenantId, 'plan', planId, '[{"a":1}]', '2026-11-01', '2026-11-01');
  archive.archive(tenantId, 'plannen', [planId]);
  assert.strictEqual(archive.purge(tenantId, { kinds: ['plannen'] }).deleted.plannen, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans WHERE tenant_id = ?').get(tenantId).n, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ? AND samples <> ''").get(tenantId).n, 1);
});

test('routes: beheerder archiveert en haalt terug, installateur krijgt 403, verwijderen vraagt bevestiging, lijsten en KPI volgen het filter', async () => {
  const { createApp } = require('../src/server');
  const { createLogin, listen } = require('./helpers/http-client');
  const PW = 'Tuin-Plan-2026!';
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const quoteId = addQuote(db, main, store.systemUser(main, 'archief-route', 'Systeem').id, 'R1', 'Test BV');
  const app = createApp({ env: {}, secret: 'k'.repeat(64), db });
  const { server, base } = await listen(app);
  try {
    const as = createLogin(base, { password: PW });
    const admin = await as('baas');
    const staff = await as('kees');
    assert.strictEqual((await staff.get('/app/api/admin/archive')).status, 403);
    assert.strictEqual((await admin.get('/app/api/admin/archive')).body.counts.offertes.active, 1);
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { kinds: ['offertes'] })).status, 400, 'bulk zonder datum of zoekterm');
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { kind: 'offertes', ids: [quoteId] })).body.archived.offertes, 1);
    assert.strictEqual((await admin.get('/app/api/quotes?all=1')).body.items.length, 0, 'verborgen in de lijst');
    assert.strictEqual((await admin.get('/app/api/quotes?all=1&archief=toon')).body.items.length, 1);
    assert.strictEqual((await admin.post('/app/api/admin/archive/purge', {})).status, 409, 'zonder bevestiging');
    assert.strictEqual((await admin.post('/app/api/admin/archive/purge', { confirm: 'VERWIJDEREN' })).status, 400, 'zonder soorten');
    assert.strictEqual((await admin.post('/app/api/admin/archive/purge', { confirm: 'VERWIJDEREN', kinds: ['offertes'], password: 'fout' })).status, 401, 'verkeerd wachtwoord');
    assert.strictEqual((await staff.post('/app/api/admin/archive/purge', { confirm: 'VERWIJDEREN', kinds: ['offertes'], password: PW })).status, 403, 'installateur');
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { kinds: ['offertes'], query: 'test' })).status, 409, 'zonder verwacht aantal uit het voorbeeld');
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { query: 'test', expected: 0 })).status, 400, 'bulk zonder soorten');
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { kinds: ['offertes'], query: 'test', expected: 99 })).status, 409, 'voorbeeld klopt niet meer');
    assert.strictEqual((await admin.post('/app/api/admin/archive/archive', { kinds: ['offertes'], query: 'test', expected: 0 })).body.archived.offertes, 0, 'de offerte is al gearchiveerd, dus het voorbeeld telt 0');
    assert.strictEqual((await admin.post('/app/api/admin/archive/restore', { kind: 'offertes', ids: [quoteId] })).body.restored.offertes, 1);
    assert.strictEqual((await admin.get('/app/api/quotes?all=1')).body.items.length, 1);
  } finally { server.close(); }
});

test('een definitief verwijderd nummer komt nooit terug (offerte, factuur)', () => {
  const { db, archive, tenantId, ownerId } = setup();
  addQuote(db, tenantId, ownerId, 'O2026-0001', 'Test BV');
  const second = addQuote(db, tenantId, ownerId, 'O2026-0002', 'Test BV');
  archive.archive(tenantId, 'offertes', [second]);
  archive.purge(tenantId, { kinds: ['offertes'] });
  const { floorOf } = require('../src/platform/number-floors');
  assert.strictEqual(floorOf((sql) => db.prepare(sql), tenantId, 'offertes', 'O2026-'), 2);
});

test('alleen afgeronde stukken mogen in het archief; open bestelling, onbetaalde definitieve factuur en lopende werkorder blijven zichtbaar', () => {
  const { db, archive, tenantId } = setup();
  const open = addInvoice(db, tenantId, 'F2026-0100', 'definitief', '2026-11-01');
  const paid = addInvoice(db, tenantId, 'F2026-0101', 'betaald', '2026-11-01');
  const out = archive.archive(tenantId, 'facturen', [open, paid]);
  assert.deepStrictEqual(out, { changed: 1, skipped: 1 });
  const preview = archive.preview(tenantId, { kinds: ['facturen'] });
  assert.strictEqual(preview.kinds.facturen.count, 0);
  assert.strictEqual(preview.kinds.facturen.notAllowed, 1);
  assert.match(preview.kinds.facturen.reason, /betaald of gecrediteerd/);
});

test('definitief verwijderen weigert een offerte waar een werkorder of factuur naar verwijst', () => {
  const { db, archive, tenantId, ownerId } = setup();
  const quoteId = addQuote(db, tenantId, ownerId, 'O2026-0050', 'Test BV');
  const invoiceId = addInvoice(db, tenantId, 'F2026-0050', 'betaald', '2026-11-01');
  db.prepare('UPDATE invoices SET quote_id = ? WHERE id = ?').run(quoteId, invoiceId);
  archive.archive(tenantId, 'offertes', [quoteId]);
  const result = archive.purge(tenantId, { kinds: ['offertes'] });
  assert.strictEqual(result.deleted.offertes, 0);
  assert.match(result.blocked[0].reason, /gekoppeld aan facturen/);
});

test('na het definitief verwijderen van het archief geeft de generator het volgende nummer, niet het gewiste', () => {
  const { createQuoteStore } = require('../src/verkoop/quotes');
  const { db, archive, tenantId, ownerId } = setup();
  const quotes = createQuoteStore(db);
  const year = '2026';
  addQuote(db, tenantId, ownerId, 'O2026-0001', 'Test BV');
  const second = addQuote(db, tenantId, ownerId, 'O2026-0002', 'Test BV');
  assert.strictEqual(quotes.nextNumber(tenantId, 'O', year), 'O2026-0003');
  archive.archive(tenantId, 'offertes', [second]);
  archive.purge(tenantId, { kinds: ['offertes'] });
  assert.strictEqual(quotes.nextNumber(tenantId, 'O', year), 'O2026-0003', 'het gewiste nummer 2 komt niet terug en 3 blijft de volgende');
});
