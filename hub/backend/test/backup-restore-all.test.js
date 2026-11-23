// Een hele app-back-up terugzetten in een lege, gemigreerde database (platform/backup-restore-all.js), zoals de hersteltest
// van de Google Drive-back-up doet: alle tabellen komen identiek terug, en zonder de schakelaar weigert het.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { createBackup } = require('../src/backup');
const { fingerprint } = require('../src/database/table-rows');
const { restoreAll, realDataOf } = require('../src/platform/backup-restore-all');

test('restoreAll zet een hele back-up identiek terug in een gemigreerde database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-restore-all-'));
  try {
    const vault = createVault(Buffer.alloc(32, 7));
    const source = openDb();
    const store = createStore(source);
    const tenantId = store.ensureTenant().id;
    await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
    const backup = await createBackup({ db: source, dir, vault });

    const target = openDb();
    // De gemigreerde database kan beginrijen hebben; die moeten verdwijnen.
    createStore(target).ensureTenant();
    await restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_RESTORE_TEST: '1', DATABASE_URL: 'postgres://postgres@db:5432/postgres' }, tempDir: dir });
    assert.deepStrictEqual(fingerprint(target), fingerprint(source));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.startsWith('restore-all-')), [], 'tussenbestand opgeruimd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreAll weigert zonder de schakelaar van de hersteltest', async () => {
  const database = openDb();
  await assert.rejects(restoreAll({ db: database, file: '/nergens', vault: createVault(Buffer.alloc(32, 7)), env: {} }), /alleen voor de hersteltest/);
});

test('restoreAll weigert een database die niet de wegwerpdatabase (host db) is', async () => {
  const database = openDb();
  await assert.rejects(restoreAll({ db: database, file: '/nergens', vault: createVault(Buffer.alloc(32, 7)), env: { AQUATECH_RESTORE_TEST: '1', DATABASE_URL: 'postgres://postgres@productie.example.nl:5432/aquatech' } }), /alleen in de wegwerpdatabase/);
});

test('restoreAll weigert zonder bekende verbindings-URL (faalt gesloten)', async () => {
  const database = openDb();
  const vault = createVault(Buffer.alloc(32, 7));
  await assert.rejects(restoreAll({ db: database, file: '/nergens', vault, env: { AQUATECH_RESTORE_TEST: '1' } }), /alleen in de wegwerpdatabase/);
  await assert.rejects(restoreAll({ db: database, file: '/nergens', vault, env: { AQUATECH_RESTORE_TEST: '1', DATABASE_URL_FILE: '/bestaat/niet' } }), /alleen in de wegwerpdatabase/);
});

test('noodherstel zet een hele back-up terug in een lege database, zonder host-controle van de hersteltest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-emergency-'));
  try {
    const vault = createVault(Buffer.alloc(32, 7));
    const source = openDb();
    const store = createStore(source);
    const tenantId = store.ensureTenant().id;
    await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
    const backup = await createBackup({ db: source, dir, vault });

    const target = openDb();
    createStore(target).ensureTenant();
    const result = await restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_EMERGENCY_RESTORE: '1', DATABASE_URL: 'postgres://aquatech@postgres:5432/aquatech' }, tempDir: dir, emergency: true });
    assert.ok(result.tables.users >= 1);
    assert.deepStrictEqual(fingerprint(target), fingerprint(source));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noodherstel weigert zonder de schakelaar', async () => {
  await assert.rejects(restoreAll({ db: openDb(), file: '/nergens', vault: createVault(Buffer.alloc(32, 7)), env: { AQUATECH_RESTORE_TEST: '1', DATABASE_URL: 'postgres://postgres@db:5432/postgres' }, emergency: true }), /AQUATECH_EMERGENCY_RESTORE=1/);
});

test('noodherstel weigert een database waar al een account in staat en laat die ongemoeid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-emergency-'));
  try {
    const vault = createVault(Buffer.alloc(32, 7));
    const source = openDb();
    const backup = await createBackup({ db: source, dir, vault });
    const target = openDb();
    const store = createStore(target);
    const tenantId = store.ensureTenant().id;
    await store.createAccount(tenantId, { username: 'echt', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
    const before = fingerprint(target);
    await assert.rejects(restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_EMERGENCY_RESTORE: '1' }, tempDir: dir, emergency: true }), /alleen in een lege database.*users: 1/);
    assert.deepStrictEqual(fingerprint(target), before, 'niets gewist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noodherstel met een verkeerde hoofdsleutel mislukt en laat de lege database leeg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-emergency-'));
  try {
    const source = openDb();
    const backup = await createBackup({ db: source, dir, vault: createVault(Buffer.alloc(32, 7)) });
    await assert.rejects(restoreAll({ db: openDb(), file: path.join(dir, backup.name), vault: createVault(Buffer.alloc(32, 9)), env: { AQUATECH_EMERGENCY_RESTORE: '1' }, tempDir: dir, emergency: true }));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.startsWith('restore-all-')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noodherstel weigert ook een database met alleen instellingen of voorraad (geen account) en laat die ongemoeid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-emergency-'));
  try {
    const vault = createVault(Buffer.alloc(32, 7));
    const backup = await createBackup({ db: openDb(), dir, vault });
    const target = openDb();
    const tenantId = createStore(target).ensureTenant().id;
    target.prepare('INSERT INTO stock_items (id, tenant_id, code, name, unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), tenantId, 'X-1', 'Slang', 'stuk', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
    const before = fingerprint(target);
    await assert.rejects(restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_EMERGENCY_RESTORE: '1' }, tempDir: dir, emergency: true }), /alleen in een lege database.*stock_items: 1/);
    assert.deepStrictEqual(fingerprint(target), before, 'niets gewist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noodherstel: alleen de hoofdtenant mag er al staan, een tweede tenant is al een gevulde database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-emergency-'));
  try {
    const vault = createVault(Buffer.alloc(32, 7));
    const backup = await createBackup({ db: openDb(), dir, vault });
    const target = openDb();
    createStore(target).ensureTenant();
    assert.deepStrictEqual(realDataOf(target), {}, 'alleen de hoofdtenant telt niet mee');
    target.prepare('INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), 'Tweede', 'tweede', '2026-11-23T00:00:00Z');
    assert.deepStrictEqual(realDataOf(target), { tenants: 2 });
    await assert.rejects(restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_EMERGENCY_RESTORE: '1' }, tempDir: dir, emergency: true }), /tenants: 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
