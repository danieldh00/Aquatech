// AVG per persoon: inzage-export in Excel en wissen met bewaarplicht, rechten en scheiding tussen organisaties.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const zlib = require('zlib');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, een klant met gegevens in meerdere soorten stukken en een andere organisatie.
 * @returns {Promise<object>} base, db, store, main, customer, admin, installer en other.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const owner = store.listUsers(main).find((user) => user.username === 'baas');
  const customer = store.createCustomer(main, { displayName: 'Piet Jansen', email: 'piet@example.nl', phone: '0612345678', address: 'Dorpsstraat 1, 1234 AB Dorp' }).user;
  store.markEmailVerified(main, customer.id, 'piet@example.nl');
  const now = '2026-11-01T10:00:00.000Z';
  /**
   * Voegt een offerte van de klant toe.
   * @param {string} id Id.
   * @param {string} number Nummer.
   * @param {string} status Status.
   * @returns {object} Het resultaat van de insert.
   */
  const quote = (id, number, status) => db.prepare(`INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, data, created_at, updated_at, customer_id, sent_to)
    VALUES (?, ?, ?, ?, ?, 'Tuin', 'Piet Jansen', ?, ?, ?, ?, 'piet@example.nl')`).run(id, main, owner.id, number, status, JSON.stringify({ customer: { name: 'Piet Jansen', address: 'Dorpsstraat 1', email: 'piet@example.nl', phone: '0612345678' }, internalNote: 'lastig' }), now, now, customer.id);
  quote('q-keep', 'O-1', 'akkoord');
  quote('q-wipe', 'O-2', 'concept');
  quote('q-gone', 'O-3', 'concept');
  db.prepare("INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at) VALUES ('p-1', ?, ?, 'Tuinplan', 'Piet Jansen', 'Dorpsstraat 1', '{}', ?, ?)").run(main, customer.id, now, now);
  db.prepare("UPDATE quotes SET deleted_at = ? WHERE id = 'q-gone'").run(now);
  /**
   * Voegt een factuur van de klant toe.
   * @param {string} id Id.
   * @param {?string} number Nummer.
   * @param {string} status Status.
   * @param {?string} quoteId Gekoppelde offerte.
   * @returns {object} Het resultaat van de insert.
   */
  const invoice = (id, number, status, quoteId) => db.prepare(`INSERT INTO invoices (id, tenant_id, number, status, customer_id, customer_name, quote_id, invoice_date, due_date, total, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Piet Jansen', ?, '2026-11-01', '2026-12-01', 100, ?, ?, ?)`).run(id, main, number, status, customer.id, quoteId, JSON.stringify({ customer: { name: 'Piet Jansen', address: 'Dorpsstraat 1' } }), now, now);
  invoice('i-def', 'F-1', 'definitief', 'q-keep');
  invoice('i-con', null, 'concept', null);
  db.prepare(`INSERT INTO web_orders (id, tenant_id, number, user_id, status, customer_name, email, total, data, created_at, updated_at)
    VALUES ('o-1', ?, 'B-1', ?, 'afgerond', 'Piet Jansen', 'piet@example.nl', 10, ?, ?, ?)`).run(main, customer.id, JSON.stringify({ customer: { name: 'Piet Jansen', phone: '0612345678' }, address: { street: 'Dorpsstraat' } }), now, now);
  db.prepare(`INSERT INTO stock_alerts (id, tenant_id, item_code, email, created_at) VALUES ('a-1', ?, 'X1', 'piet@example.nl', ?)`).run(main, now);
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { db, customer, admin: await as('baas'), installer: await as('monteur'), other: await as('vreemd', 'ander') };
}

/**
 * Leest de tekst van alle XML-bestanden uit een .xlsx (zip met deflate).
 * @param {Buffer} buffer Het bestand.
 * @returns {string} De samengevoegde tekst.
 */
function xlsxText(buffer) {
  let text = '';
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + size);
    text += (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    offset = start + size;
  }
  return text;
}

test('inzage geeft een Excel met de gegevens van de klant, alleen voor beheerders', async () => {
  const { admin, installer, customer } = await setup();
  const out = await admin.get(`/app/api/customers/${customer.id}/privacy-export`);
  assert.strictEqual(out.status, 200);
  assert.match(out.type, /spreadsheetml/);
  const text = xlsxText(out.raw);
  for (const expected of ['Piet Jansen', 'piet@example.nl', 'O-1', 'F-1', 'B-1', 'X1', 'O-3']) assert.ok(text.includes(expected), expected);
  assert.strictEqual((await installer.get(`/app/api/customers/${customer.id}/privacy-export`)).status, 403);
  assert.strictEqual((await admin.get('/app/api/customers/onbekend/privacy-export')).status, 404);
});

test('een beheerder van een andere organisatie ziet de klant niet', async () => {
  const { other, customer } = await setup();
  assert.strictEqual((await other.get(`/app/api/customers/${customer.id}/privacy-export`)).status, 404);
  assert.strictEqual((await other.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' })).status, 404);
});

test('wissen vraagt de naam, anonimiseert en bewaart wat de bewaarplicht beschermt', async () => {
  const { admin, installer, db, customer } = await setup();
  assert.strictEqual((await installer.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' })).status, 403);
  assert.strictEqual((await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'fout' })).status, 409);
  const done = await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(done.body.result.kept.invoices, 1);
  assert.strictEqual(done.body.result.kept.quotes, 1);
  const user = db.prepare('SELECT username, display_name, email, phone, address, password_hash, disabled FROM users WHERE id = ?').get(customer.id);
  assert.strictEqual(user.display_name, 'Verwijderde persoon');
  assert.strictEqual(user.email, '');
  assert.strictEqual(user.password_hash, null);
  assert.strictEqual(Number(user.disabled), 1);
  const wiped = db.prepare("SELECT customer, customer_id, sent_to, data FROM quotes WHERE id = 'q-wipe'").get();
  assert.strictEqual(wiped.customer, 'Verwijderde persoon');
  assert.strictEqual(wiped.customer_id, null);
  assert.ok(!wiped.data.includes('piet@example.nl') && !wiped.data.includes('lastig'));
  assert.ok(db.prepare("SELECT data FROM quotes WHERE id = 'q-keep'").get().data.includes('piet@example.nl'));
  assert.strictEqual(db.prepare("SELECT customer_name FROM invoices WHERE id = 'i-def'").get().customer_name, 'Piet Jansen');
  assert.strictEqual(db.prepare("SELECT customer_name FROM invoices WHERE id = 'i-con'").get().customer_name, 'Verwijderde persoon');
  const order = db.prepare("SELECT customer_name, email, data FROM web_orders WHERE id = 'o-1'").get();
  assert.strictEqual(order.email, '');
  assert.ok(!order.data.includes('0612345678'));
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM stock_alerts').get().n), 0);
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM plans WHERE owner_id = ?').get(customer.id).n), 0);
  assert.strictEqual((await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Verwijderde persoon' })).status, 409);
  assert.ok(db.prepare("SELECT id FROM audit WHERE action = 'klant_geanonimiseerd'").get());
});

test('een gastbestelling op een onbevestigd e-mailadres wordt niet gekoppeld of gewist', async () => {
  const { admin, db, customer } = await setup();
  const now = '2026-11-01T10:00:00.000Z';
  db.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').run(customer.id);
  db.prepare(`INSERT INTO web_orders (id, tenant_id, number, user_id, status, customer_name, email, total, data, created_at, updated_at)
    VALUES ('o-gast', (SELECT tenant_id FROM users WHERE id = ?), 'B-2', NULL, 'afgerond', 'Andere Gast', 'piet@example.nl', 5, '{}', ?, ?)`).run(customer.id, now, now);
  assert.ok(!xlsxText((await admin.get(`/app/api/customers/${customer.id}/privacy-export`)).raw).includes('B-2'));
  assert.strictEqual((await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' })).status, 200);
  assert.strictEqual(db.prepare("SELECT customer_name FROM web_orders WHERE id = 'o-gast'").get().customer_name, 'Andere Gast');
});

test('een open werkorder uit een melding van de klant houdt het wissen tegen', async () => {
  const { admin, db, customer } = await setup();
  const now = '2026-11-01T10:00:00.000Z';
  const owner = db.prepare("SELECT id, tenant_id FROM users WHERE username = 'baas'").get();
  db.prepare(`INSERT INTO work_orders (id, tenant_id, owner_id, number, status, data, created_at, updated_at) VALUES ('w-1', ?, ?, 'W-1', 'open', '{}', ?, ?)`).run(owner.tenant_id, owner.id, now, now);
  db.prepare(`INSERT INTO service_requests (id, tenant_id, number, customer_id, subject, work_order_id, created_at, updated_at) VALUES ('s-1', ?, 'M-1', ?, 'Storing', 'w-1', ?, ?)`).run(owner.tenant_id, customer.id, now, now);
  const refused = await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.blockers.workOrders, 1);
});

test('wissen wordt geweigerd zolang er een onafgehandelde bestelling of werkorder is', async () => {
  const { admin, db, customer } = await setup();
  db.prepare("UPDATE web_orders SET status = 'nieuw' WHERE id = 'o-1'").run();
  const refused = await admin.post(`/app/api/customers/${customer.id}/anonymize`, { confirm: 'Piet Jansen' });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'open_items');
  assert.strictEqual(db.prepare('SELECT display_name FROM users WHERE id = ?').get(customer.id).display_name, 'Piet Jansen');
});
