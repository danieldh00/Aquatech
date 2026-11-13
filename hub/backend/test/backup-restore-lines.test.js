// Regels van een offerte of webshopbestelling afzonderlijk terugzetten uit een back-up: de totalen worden opnieuw berekend,
// de voorraadreservering volgt, en een bestelling die al in behandeling is blijft met rust.
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
const { createStockStore } = require('../src/artikelen/stock');
const { totalsOf, stockLinesOf } = require('../src/webshop/web-orders');
const restore = require('../src/platform/backup-restore');
const lines = require('../src/platform/backup-restore-lines');
const { FRONTEND_DIR } = require('../src/paths');
const QuoteCore = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));

const NOW = '2026-11-01T10:00:00.000Z';

/**
 * Een bestelregel voor artikel WS-1.
 * @param {number} qty Het aantal.
 * @returns {object} De regel met bedragen (€ 10,00 excl., 21% btw).
 */
function orderLine(qty) {
  return { itemId: 'si1', code: 'WS-1', name: 'Sproeier', unit: 'stuk', qty, unitExcl: 10, vatRate: 21, unitIncl: 12.1, lineTotal: Math.round(qty * 1210) / 100 };
}

/**
 * Een omgeving met een offerte (twee regels) en een webshopbestelling met voorraadreservering, plus een back-up daarvan.
 * @returns {Promise<object>} db, stock, tenantId, vault, dir, backupName, deps en cleanup().
 */
async function world() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const { user: owner } = await store.createAccount(tenantId, { username: 'jan', displayName: 'Jan', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  const stock = createStockStore(db);
  const quoteData = { lines: [
    { id: 'l1', section: 'materiaal', code: 'A', description: 'Pomp', qty: 1, unit: 'stuk', price: 100, vat: 21 },
    { id: 'l2', section: 'arbeid', code: '', description: 'Aanleg', qty: 2, unit: 'uur', price: 50, vat: 21 },
  ] };
  const totals = QuoteCore.totals(quoteData);
  db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('qa', ?, ?, 'O2026-0001', 'concept', 'Tuin', 'Jansen', ?, ?, ?, ?, ?)").run(tenantId, owner.id, totals.net, totals.total, JSON.stringify(quoteData), NOW, NOW);
  db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, acceptance) VALUES ('qb', ?, ?, 'O2026-0002', 'akkoord', 'Vast', 'Piet', 1, 1, ?, ?, ?, ?)").run(tenantId, owner.id, JSON.stringify(quoteData), NOW, NOW, JSON.stringify({ at: NOW }));
  db.prepare("INSERT INTO stock_items (id, tenant_id, code, name, on_hand, created_at, updated_at, sale_price) VALUES ('si1', ?, 'WS-1', 'Sproeier', 100, ?, ?, 10)").run(tenantId, NOW, NOW);
  const orderTotals = totalsOf([orderLine(2)]);
  const orderData = { lines: [orderLine(2)], totals: orderTotals, shipping: { price: 0, priceExcl: 0, vatRate: 21 }, payment: 'op rekening', history: [] };
  db.prepare("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES ('ow1', ?, 'WEB-2026-0001', 'nieuw', 'Klant', 'k@example.nl', ?, ?, ?, ?)").run(tenantId, orderTotals.total, JSON.stringify(orderData), NOW, NOW);
  stock.reserveOrder(tenantId, 'ow1', stockLinesOf(orderData.lines));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-restore-lines-'));
  const vault = createVault(crypto.randomBytes(32));
  const made = await createBackup({ db, dir, vault });
  return { db, stock, tenantId, vault, dir, backupName: made.name, deps: { QuoteCore, totalsOf, stockLinesOf, stock }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Opent de back-up van de omgeving en geeft de drie delen die de functies nodig hebben.
 * @param {object} scene De omgeving uit world().
 * @param {Function} callback Krijgt { backup, current, context }.
 * @returns {Promise<*>} Wat de functie teruggeeft.
 */
async function withBackup(scene, callback) {
  const opened = await restore.openBackup({ dir: scene.dir, name: scene.backupName, vault: scene.vault });
  try { return await callback({ backup: opened.db, current: scene.db, context: { tenantId: scene.tenantId, customerRoleKeys: ['klant'] } }); } finally { opened.close(); }
}

/**
 * De gereserveerde hoeveelheid van een bestelling.
 * @param {object} scene De omgeving.
 * @returns {number} Het aantal.
 */
function reserved(scene) {
  const row = scene.db.prepare("SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_reservations WHERE tenant_id = ? AND work_order_id = 'order:ow1'").get(scene.tenantId);
  return Number(row.qty);
}

test('offerteregels: een gewijzigde en een verwijderde regel komen apart terug en het totaal klopt weer', async () => {
  const scene = await world();
  try {
    const original = scene.db.prepare("SELECT total_excl, total_incl, data FROM quotes WHERE id = 'qa'").get();
    const data = JSON.parse(original.data);
    data.lines = [{ ...data.lines[0], qty: 5 }];
    const changed = QuoteCore.totals(data);
    scene.db.prepare("UPDATE quotes SET total_excl = ?, total_incl = ?, data = ? WHERE id = 'qa'").run(changed.net, changed.total, JSON.stringify(data));
    await withBackup(scene, ({ backup, current, context }) => {
      const view = lines.linesView({ backup, current, context }, { kind: 'quote', id: 'qa' });
      assert.deepStrictEqual(view.lines.map((line) => [line.key, line.state]), [['l1', 'gewijzigd'], ['l2', 'ontbreekt']]);
      // Alleen de verwijderde regel terug: de gewijzigde blijft zoals hij nu is.
      lines.applyLines({ backup, current, context }, { kind: 'quote', id: 'qa', keys: ['l2'] }, scene.deps);
      let row = scene.db.prepare("SELECT total_incl, data FROM quotes WHERE id = 'qa'").get();
      assert.deepStrictEqual(JSON.parse(row.data).lines.map((line) => [line.id, line.qty]), [['l1', 5], ['l2', 2]]);
      lines.applyLines({ backup, current, context }, { kind: 'quote', id: 'qa', keys: ['l1', 'l2'] }, scene.deps);
      row = scene.db.prepare("SELECT total_excl, total_incl, data FROM quotes WHERE id = 'qa'").get();
      assert.strictEqual(row.total_incl, original.total_incl);
      assert.strictEqual(row.total_excl, original.total_excl);
      assert.strictEqual(JSON.parse(row.data).lines[0].qty, 1);
    });
  } finally { scene.cleanup(); }
});

test('een geaccordeerde offerte laat zijn regels met rust', async () => {
  const scene = await world();
  try {
    await withBackup(scene, ({ backup, current, context }) => {
      assert.match(lines.linesView({ backup, current, context }, { kind: 'quote', id: 'qb' }).blocked, /geaccordeerd/);
      assert.throws(() => lines.applyLines({ backup, current, context }, { kind: 'quote', id: 'qb', keys: ['l1'] }, scene.deps), /geaccordeerd/);
    });
  } finally { scene.cleanup(); }
});

test('bestelregel: het aantal gaat terug, het totaal en de reservering volgen', async () => {
  const scene = await world();
  try {
    const original = scene.db.prepare("SELECT total, data FROM web_orders WHERE id = 'ow1'").get();
    const edited = { ...JSON.parse(original.data), lines: [orderLine(5)], totals: totalsOf([orderLine(5)]) };
    scene.db.prepare("UPDATE web_orders SET total = ?, data = ? WHERE id = 'ow1'").run(edited.totals.total, JSON.stringify(edited));
    scene.stock.releaseOrder(scene.tenantId, 'ow1');
    scene.stock.reserveOrder(scene.tenantId, 'ow1', stockLinesOf(edited.lines));
    assert.strictEqual(reserved(scene), 5);
    await withBackup(scene, ({ backup, current, context }) => {
      assert.deepStrictEqual(lines.linesView({ backup, current, context }, { kind: 'web_order', id: 'ow1' }).lines.map((line) => [line.key, line.state]), [['WS-1', 'gewijzigd']]);
      const out = lines.applyLines({ backup, current, context }, { kind: 'web_order', id: 'ow1', keys: ['WS-1'] }, scene.deps);
      assert.strictEqual(out.restored, 1);
      const row = scene.db.prepare("SELECT total, data FROM web_orders WHERE id = 'ow1'").get();
      assert.strictEqual(row.total, original.total);
      assert.deepStrictEqual(JSON.parse(row.data).totals, JSON.parse(original.data).totals);
      assert.strictEqual(JSON.parse(row.data).history.length, 1, 'het terugzetten staat in de geschiedenis');
      assert.strictEqual(reserved(scene), 2);
    });
  } finally { scene.cleanup(); }
});

test('een bestelling in behandeling, online betaald of met een tekort aan voorraad wordt niet aangepast', async () => {
  const scene = await world();
  try {
    const edited = { ...JSON.parse(scene.db.prepare("SELECT data FROM web_orders WHERE id = 'ow1'").get().data), lines: [orderLine(5)], totals: totalsOf([orderLine(5)]) };
    scene.db.prepare("UPDATE web_orders SET data = ?, total = ? WHERE id = 'ow1'").run(JSON.stringify(edited), edited.totals.total);
    await withBackup(scene, ({ backup, current, context }) => {
      /**
       * Probeert de regel van bestelling ow1 terug te zetten.
       * @returns {object} De uitkomst (of een fout).
       */
      const run = () => lines.applyLines({ backup, current, context }, { kind: 'web_order', id: 'ow1', keys: ['WS-1'] }, scene.deps);
      // Te weinig voorraad: een andere bestelling houdt alles vast.
      scene.db.prepare("UPDATE stock_items SET on_hand = 1 WHERE id = 'si1'").run();
      assert.throws(run, /Te weinig voorraad/);
      scene.db.prepare("UPDATE stock_items SET on_hand = 100 WHERE id = 'si1'").run();
      // Totaal dat niet bij de regels past.
      scene.db.prepare("UPDATE web_orders SET data = ? WHERE id = 'ow1'").run(JSON.stringify({ ...edited, totals: { ...edited.totals, total: 1 } }));
      assert.throws(run, /kloppen niet/);
      scene.db.prepare("UPDATE web_orders SET data = ? WHERE id = 'ow1'").run(JSON.stringify(edited));
      scene.db.prepare("UPDATE web_orders SET data = ? WHERE id = 'ow1'").run(JSON.stringify({ ...edited, payment: 'online' }));
      assert.throws(run, /online betaling/);
      scene.db.prepare("UPDATE web_orders SET data = ?, status = 'verzonden' WHERE id = 'ow1'").run(JSON.stringify(edited));
      assert.throws(run, /nieuwe bestelling/);
      assert.strictEqual(JSON.parse(scene.db.prepare("SELECT data FROM web_orders WHERE id = 'ow1'").get().data).lines[0].qty, 5, 'niets is gewijzigd');
    });
  } finally { scene.cleanup(); }
});

test('een verstuurde offerte en een regel met een verdwenen artikel worden niet teruggezet', async () => {
  const scene = await world();
  try {
    await withBackup(scene, ({ backup, current, context }) => {
      scene.db.prepare("UPDATE quotes SET status = 'verzonden' WHERE id = 'qa'").run();
      assert.match(lines.linesView({ backup, current, context }, { kind: 'quote', id: 'qa' }).blocked, /Alleen een conceptofferte/);
      scene.db.prepare("UPDATE quotes SET status = 'concept' WHERE id = 'qa'").run();
      const edited = { ...JSON.parse(scene.db.prepare("SELECT data FROM web_orders WHERE id = 'ow1'").get().data), lines: [orderLine(5)], totals: totalsOf([orderLine(5)]) };
      scene.db.prepare("UPDATE web_orders SET data = ?, total = ? WHERE id = 'ow1'").run(JSON.stringify(edited), edited.totals.total);
      scene.db.prepare("UPDATE stock_items SET archived = 1 WHERE id = 'si1'").run();
      assert.throws(() => lines.applyLines({ backup, current, context }, { kind: 'web_order', id: 'ow1', keys: ['WS-1'] }, scene.deps), /niet meer bestaat/);
    });
  } finally { scene.cleanup(); }
});

test('een record dat niet bestaat, of een soort zonder regels, geeft een duidelijke melding', async () => {
  const scene = await world();
  try {
    scene.db.prepare("DELETE FROM quotes WHERE id = 'qa'").run();
    await withBackup(scene, ({ backup, current, context }) => {
      assert.match(lines.linesView({ backup, current, context }, { kind: 'quote', id: 'qa' }).blocked, /eerst als geheel/);
      assert.match(lines.linesView({ backup, current, context }, { kind: 'quote', id: 'bestaat-niet' }).blocked, /niet in de back-up/);
      assert.throws(() => lines.linesView({ backup, current, context }, { kind: 'plan', id: 'x' }), /niet afzonderlijk/);
    });
  } finally { scene.cleanup(); }
});
