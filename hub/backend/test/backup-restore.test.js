// Terugzetten uit een back-up: verwijderde records komen terug (met onderliggende rijen), gewijzigde velden gaan per veld terug,
// gevoelige velden en vergrendelde records blijven met rust, en alles gebeurt alleen binnen de eigen omgeving.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { createBackup } = require('../src/backup');
const restore = require('../src/platform/backup-restore');

const NOW = '2026-11-01T10:00:00.000Z';

/**
 * Een omgeving met records van elke soort, een back-up ervan en een tweede omgeving.
 * @returns {Promise<object>} db, store, tenantId, otherTenantId, vault, dir, backupName en cleanup().
 */
async function world() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const other = db.prepare('SELECT id FROM tenants WHERE id <> ? LIMIT 1').get(tenantId);
  const otherTenantId = other ? other.id : crypto.randomUUID();
  if (!other) db.prepare("INSERT INTO tenants (id, slug, name, created_at, environment) VALUES (?, 'ander', 'Ander', ?, 'live')").run(otherTenantId, NOW);
  const { user: owner } = await store.createAccount(tenantId, { username: 'jan', displayName: 'Jan', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  const { user: piet } = await store.createAccount(tenantId, { username: 'piet', displayName: 'Piet', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  /**
   * Voegt een rij toe met SQL en parameters.
   * @param {string} sql De INSERT.
   * @param {...*} args De parameters.
   * @returns {void}
   */
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  ins("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('q1', ?, ?, 'O2026-0001', 'concept', 'Tuin Jansen', 'Jansen', 100, 121, ?, ?, ?)", tenantId, piet.id, JSON.stringify({ lines: [{ code: 'A', qty: 1 }], note: 'oud' }), NOW, NOW);
  ins("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, acceptance) VALUES ('q2', ?, ?, 'O2026-0002', 'akkoord', 'Vergrendeld', 'Piet', 10, 12, ?, ?, ?, ?)", tenantId, owner.id, JSON.stringify({ lines: [] }), NOW, NOW, JSON.stringify({ at: NOW }));
  ins("INSERT INTO work_orders (id, tenant_id, owner_id, number, status, title, customer, address, data, created_at, updated_at) VALUES ('w1', ?, ?, 'WO-2026-0001', 'open', 'Aanleg', 'Jansen', 'Dorpsstraat 1', '{}', ?, ?)", tenantId, owner.id, NOW, NOW);
  ins("INSERT INTO work_order_hours (id, tenant_id, work_order_id, user_name, work_date, start_time, end_time, break_minutes, minutes, kind, step_id, note, created_at, updated_at) VALUES ('h1', ?, 'w1', 'Jan', '2026-11-01', '08:00', '12:00', 0, 240, 'werk', '', '', ?, ?)", tenantId, NOW, NOW);
  ins("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES ('o1', ?, 'WEB-2026-0001', 'nieuw', 'Klant', 'k@example.nl', 50, '{}', ?, ?)", tenantId, NOW, NOW);
  ins("INSERT INTO stock_items (id, tenant_id, code, name, on_hand, created_at, updated_at, sale_price) VALUES ('s1', ?, 'SPR-1', 'Sproeier', 7, ?, ?, 4.5)", tenantId, NOW, NOW);
  ins("INSERT INTO item_packagings (id, tenant_id, item_id, code, name, factor, created_at) VALUES ('p1', ?, 's1', 'DOOS', 'Doos 10', 10, ?)", tenantId, NOW);
  ins("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('qx', ?, ?, 'O-ANDER-1', 'concept', 'Andere omgeving', 'X', 1, 1, '{}', ?, ?)", otherTenantId, owner.id, NOW, NOW);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-restore-'));
  const vault = createVault(crypto.randomBytes(32));
  const made = await createBackup({ db, dir, vault });
  return { db, store, tenantId, otherTenantId, owner, piet, vault, dir, backupName: made.name, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Opent de back-up en voert een functie uit; sluit hem daarna altijd.
 * @param {object} scene De omgeving uit world().
 * @param {Function} callback Krijgt { backup, current, context }.
 * @returns {Promise<*>} Wat de functie teruggeeft.
 */
async function withBackup(scene, callback) {
  const opened = await restore.openBackup({ dir: scene.dir, name: scene.backupName, vault: scene.vault });
  try { return await callback({ backup: opened.db, current: scene.db, context: { tenantId: scene.tenantId, customerRoleKeys: ['klant'] } }); } finally { opened.close(); }
}

test('openen: verkeerde sleutel of onbekende naam wordt geweigerd en er blijft niets achter', async () => {
  const scene = await world();
  try {
    await assert.rejects(restore.openBackup({ dir: scene.dir, name: scene.backupName, vault: createVault(crypto.randomBytes(32)) }), /Ontsleutelen mislukt/);
    await assert.rejects(restore.openBackup({ dir: scene.dir, name: '../x.db.enc', vault: scene.vault }), /niet gevonden/);
    assert.deepStrictEqual(fs.readdirSync(scene.dir).filter((name) => name.startsWith('.restore-')), []);
    await withBackup(scene, async () => {});
    assert.deepStrictEqual(fs.readdirSync(scene.dir).filter((name) => name.startsWith('.restore-')), [], 'tijdelijk bestand gewist');
  } finally { scene.cleanup(); }
});

test('zoeken: toont de stand per record en blijft in de eigen omgeving', async () => {
  const scene = await world();
  try {
    scene.db.prepare("DELETE FROM quotes WHERE id = 'q1'").run();
    scene.db.prepare("UPDATE quotes SET title = 'Anders' WHERE id = 'q2'").run();
    await withBackup(scene, ({ backup, current, context }) => {
      const found = restore.listRecords({ backup, current, context, kind: 'quote' });
      assert.deepStrictEqual(found.items.map((item) => [item.id, item.state]).sort(), [['q1', 'ontbreekt'], ['q2', 'gewijzigd']]);
      assert.ok(!found.items.some((item) => item.id === 'qx'), 'andere omgeving is onzichtbaar');
      assert.deepStrictEqual(restore.listRecords({ backup, current, context, kind: 'quote', query: 'jansen' }).items.map((item) => item.id), ['q1']);
      assert.deepStrictEqual(restore.listRecords({ backup, current, context, kind: 'quote', query: '%' }).items, [], 'een procent is geen jokerteken');
      assert.throws(() => restore.listRecords({ backup, current, context, kind: 'bestaat-niet' }), /Onbekende soort/);
      // Een record van een andere omgeving is ook niet via het id op te vragen.
      assert.strictEqual(restore.preview({ backup, current, context, kind: 'quote', id: 'qx' }).state, 'niet_in_back-up');
    });
  } finally { scene.cleanup(); }
});

test('een verwijderd record komt terug met zijn onderliggende rijen; opnieuw terugzetten doet niets', async () => {
  const scene = await world();
  try {
    scene.db.prepare("DELETE FROM work_order_hours WHERE work_order_id = 'w1'").run();
    scene.db.prepare("DELETE FROM work_orders WHERE id = 'w1'").run();
    await withBackup(scene, ({ backup, current, context }) => {
      const plan = restore.preview({ backup, current, context, kind: 'work_order', id: 'w1' });
      assert.strictEqual(plan.state, 'ontbreekt');
      assert.deepStrictEqual(plan.children.find((child) => child.table === 'work_order_hours'), { table: 'work_order_hours', inBackup: 1, missing: 1 });
      const out = restore.applyRestore({ backup, current, context, kind: 'work_order', items: [{ id: 'w1' }] });
      assert.strictEqual(out.results[0].status, 'hersteld');
      assert.strictEqual(scene.db.prepare("SELECT title FROM work_orders WHERE id = 'w1'").get().title, 'Aanleg');
      assert.strictEqual(scene.db.prepare("SELECT minutes FROM work_order_hours WHERE id = 'h1'").get().minutes, 240);
      assert.strictEqual(restore.applyRestore({ backup, current, context, kind: 'work_order', items: [{ id: 'w1' }] }).results[0].status, 'overgeslagen');
    });
  } finally { scene.cleanup(); }
});

test('status en nummer gaan nooit per veld terug (de vergrendeling is niet te omzeilen)', async () => {
  const scene = await world();
  try {
    await withBackup(scene, ({ backup, current, context }) => {
      scene.db.prepare("UPDATE quotes SET status = 'verzonden', number = 'O2026-0099' WHERE id = 'q1'").run();
      const plan = restore.preview({ backup, current, context, kind: 'quote', id: 'q1' });
      assert.ok(!plan.fields.includes('status') && !plan.fields.includes('number'), 'niet aangeboden');
      const out = restore.applyRestore({ backup, current, context, kind: 'quote', items: [{ id: 'q1', fields: ['status', 'number'] }] });
      assert.strictEqual(out.results[0].status, 'overgeslagen');
      assert.deepStrictEqual({ ...scene.db.prepare("SELECT status, number FROM quotes WHERE id = 'q1'").get() }, { status: 'verzonden', number: 'O2026-0099' });
      // Een klantkoppeling terugzetten zou de offerte zichtbaar maken in het portaal van een andere klant.
      scene.db.prepare("UPDATE quotes SET customer_id = ? WHERE id = 'q1'").run(scene.piet.id);
      assert.ok(!restore.preview({ backup, current, context, kind: 'quote', id: 'q1' }).fields.includes('customer_id'));
      assert.strictEqual(restore.applyRestore({ backup, current, context, kind: 'quote', items: [{ id: 'q1', fields: ['customer_id'] }] }).results[0].status, 'overgeslagen');
    });
  } finally { scene.cleanup(); }
});

test('een gewijzigd record: alleen de gekozen velden gaan terug, ook één sleutel uit data', async () => {
  const scene = await world();
  try {
    scene.db.prepare("UPDATE quotes SET title = 'Nieuwe titel', data = ? WHERE id = 'q1'").run(JSON.stringify({ lines: [{ code: 'B', qty: 9 }], note: 'nieuw', extra: 1 }));
    await withBackup(scene, ({ backup, current, context }) => {
      const plan = restore.preview({ backup, current, context, kind: 'quote', id: 'q1' });
      assert.deepStrictEqual(plan.fields.sort(), ['data.extra', 'data.lines', 'data.note', 'title']);
      assert.deepStrictEqual(plan.diffs.find((diff) => diff.field === 'data.lines').backup, [{ code: 'A', qty: 1 }]);
      const out = restore.applyRestore({ backup, current, context, kind: 'quote', items: [{ id: 'q1', fields: ['data.lines', 'data.extra'] }] });
      assert.strictEqual(out.results[0].status, 'bijgewerkt');
      const row = scene.db.prepare("SELECT title, data FROM quotes WHERE id = 'q1'").get();
      assert.strictEqual(row.title, 'Nieuwe titel', 'niet gekozen = ongemoeid');
      assert.deepStrictEqual(JSON.parse(row.data), { lines: [{ code: 'A', qty: 1 }], note: 'nieuw' }, 'regels terug, extra weg, notitie ongemoeid');
      // Een veld dat niet in het voorbeeld stond kan niet worden meegestuurd.
      assert.strictEqual(restore.applyRestore({ backup, current, context, kind: 'quote', items: [{ id: 'q1', fields: ['owner_id', 'tenant_id'] }] }).results[0].status, 'overgeslagen');
    });
  } finally { scene.cleanup(); }
});

test('vergrendeld, bestelling en voorraad: nooit overschreven; gevoelige velden en de stand blijven', async () => {
  const scene = await world();
  try {
    scene.db.prepare("UPDATE quotes SET title = 'Gewijzigd' WHERE id = 'q2'").run();
    scene.db.prepare("UPDATE web_orders SET status = 'verzonden' WHERE id = 'o1'").run();
    scene.db.prepare("UPDATE stock_items SET on_hand = 99, name = 'Nieuwe naam' WHERE id = 's1'").run();
    scene.db.prepare("UPDATE users SET password_hash = 'nieuwe-hash' WHERE id = ?").run(scene.owner.id);
    await withBackup(scene, ({ backup, current, context }) => {
      assert.match(restore.preview({ backup, current, context, kind: 'quote', id: 'q2' }).blocked, /geaccordeerd/);
      assert.match(restore.preview({ backup, current, context, kind: 'web_order', id: 'o1' }).blocked, /nooit overschreven/);
      assert.strictEqual(restore.applyRestore({ backup, current, context, kind: 'web_order', items: [{ id: 'o1', fields: ['status'] }] }).results[0].status, 'geblokkeerd');
      assert.strictEqual(scene.db.prepare("SELECT status FROM web_orders WHERE id = 'o1'").get().status, 'verzonden');
      const stock = restore.preview({ backup, current, context, kind: 'stock_item', id: 's1' });
      assert.deepStrictEqual(stock.fields, ['name'], 'on_hand wordt niet eens aangeboden');
      restore.applyRestore({ backup, current, context, kind: 'stock_item', items: [{ id: 's1', fields: ['name', 'on_hand'] }] });
      assert.deepStrictEqual({ ...scene.db.prepare("SELECT name, on_hand FROM stock_items WHERE id = 's1'").get() }, { name: 'Sproeier', on_hand: 99 });
      assert.deepStrictEqual(restore.listRecords({ backup, current, context, kind: 'customer' }).items.filter((item) => item.id === scene.owner.id), [], 'een beheerder is geen klant');
    });
  } finally { scene.cleanup(); }
});

test('een verwijderd artikel komt terug zonder voorraadstand en met zijn verpakkingen; een nummer dat intussen is vergeven blokkeert', async () => {
  const scene = await world();
  try {
    scene.db.prepare("DELETE FROM item_packagings WHERE id = 'p1'").run();
    scene.db.prepare("DELETE FROM stock_items WHERE id = 's1'").run();
    scene.db.prepare("INSERT INTO stock_items (id, tenant_id, code, name, created_at, updated_at) VALUES ('s9', ?, 'SPR-1', 'Ander artikel', ?, ?)").run(scene.tenantId, NOW, NOW);
    await withBackup(scene, ({ backup, current, context }) => {
      assert.match(restore.preview({ backup, current, context, kind: 'stock_item', id: 's1' }).blocked, /SPR-1 is intussen/);
      scene.db.prepare("DELETE FROM stock_items WHERE id = 's9'").run();
      const out = restore.applyRestore({ backup, current, context, kind: 'stock_item', items: [{ id: 's1' }] });
      assert.strictEqual(out.results[0].status, 'hersteld');
      assert.strictEqual(scene.db.prepare("SELECT on_hand FROM stock_items WHERE id = 's1'").get().on_hand, 0, 'de stand komt uit boekingen, niet uit de back-up');
      assert.strictEqual(scene.db.prepare("SELECT COUNT(*) AS n FROM item_packagings WHERE item_id = 's1'").get().n, 1);
    });
  } finally { scene.cleanup(); }
});

test('een record dat naar iets verwijst dat niet meer bestaat wordt gemeld, en een fout draait alles terug', async () => {
  const scene = await world();
  try {
    scene.db.prepare("DELETE FROM quotes WHERE id = 'q1'").run();
    scene.db.prepare('DELETE FROM users WHERE id = ?').run(scene.piet.id);
    await withBackup(scene, ({ backup, current, context }) => {
      const plan = restore.preview({ backup, current, context, kind: 'quote', id: 'q1' });
      assert.match(plan.blocked, /users-record .* dat niet meer bestaat/);
      assert.strictEqual(restore.applyRestore({ backup, current, context, kind: 'quote', items: [{ id: 'q1' }] }).results[0].status, 'geblokkeerd');
      assert.strictEqual(scene.db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE id = 'q1'").get().n, 0);
      assert.throws(() => restore.applyRestore({ backup, current, context, kind: 'quote', items: [] }), /minstens één/);
    });
  } finally { scene.cleanup(); }
});

test('API: alleen hoofdbeheerders, wachtwoord nodig, verse back-up vooraf en een auditregel', async () => {
  const { createApp } = require('../src/server');
  const { listen, createClient } = require('./helpers/http-client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-restore-api-'));
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const PW = 'Tuin-Plan-2026!';
  const { user: baas } = await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tenantId, { username: 'tweede', role: 'beheerder', password: PW });
  const app = createApp({ secret: 's'.repeat(64), db, loginDelayMs: 0, env: { MULTITENANCY: '1' }, backupDir: dir });
  const { server, base } = await listen(app);
  const URL = '/app/api/admin/backups/restore';
  try {
    db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('q1', ?, ?, 'O1', 'concept', 'Terug te zetten', 'Jansen', 1, 1, '{}', ?, ?)").run(tenantId, baas.id, NOW, NOW);
    assert.strictEqual((await createClient(base).get(`${URL}/kinds`)).status, 401);
    const tweede = createClient(base);
    await tweede.post('/app/api/auth/login', { username: 'tweede', password: PW });
    assert.strictEqual((await tweede.get(`${URL}/kinds`)).status, 403);
    assert.strictEqual((await tweede.post(`${URL}/apply`, { backup: 'x', kind: 'quote', items: [{ id: 'q1' }], password: PW })).status, 403);

    const admin = createClient(base);
    await admin.post('/app/api/auth/login', { username: 'baas', password: PW });
    assert.ok((await admin.get(`${URL}/kinds`)).body.kinds.some((kind) => kind.kind === 'quote'));
    const made = (await admin.post('/app/api/admin/backups')).body;
    db.prepare("DELETE FROM quotes WHERE id = 'q1'").run();

    assert.strictEqual((await admin.get(`${URL}/records?backup=../x&kind=quote`)).status, 404);
    assert.strictEqual((await admin.get(`${URL}/records?backup=${made.name}&kind=bestaat-niet`)).status, 400);
    const records = (await admin.get(`${URL}/records?backup=${made.name}&kind=quote&q=terug`)).body;
    assert.deepStrictEqual(records.items.map((item) => [item.id, item.state]), [['q1', 'ontbreekt']]);
    const previews = (await admin.post(`${URL}/preview`, { backup: made.name, kind: 'quote', ids: ['q1'] })).body.previews;
    assert.strictEqual(previews[0].state, 'ontbreekt');
    assert.strictEqual(previews[0].blocked, '');

    const body = { backup: made.name, kind: 'quote', items: [{ id: 'q1' }] };
    assert.strictEqual((await admin.post(`${URL}/apply`, { ...body, password: 'fout' })).status, 401);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE id = 'q1'").get().n, 0, 'met een fout wachtwoord gebeurt er niets');
    const done = await admin.post(`${URL}/apply`, { ...body, password: PW });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.results[0].status, 'hersteld');
    assert.ok(done.body.safetyBackup && fs.existsSync(path.join(dir, done.body.safetyBackup)), 'verse back-up vooraf');
    assert.strictEqual(db.prepare("SELECT title FROM quotes WHERE id = 'q1'").get().title, 'Terug te zetten');
    const actions = (await admin.get('/app/api/admin/audit')).body.items.map((entry) => entry.action);
    assert.ok(actions.includes('backup_teruggezet') && actions.includes('backup_terugzetten_wachtwoord_fout'));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.restore-')), []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
