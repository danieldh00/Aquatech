// Een hele app-back-up terugzetten in een lege, gemigreerde database (platform/backup-restore-all.js), zoals de hersteltest
// van de Google Drive-back-up doet: alle tabellen komen identiek terug, en zonder de schakelaar weigert het.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { createBackup } = require('../src/backup');
const { fingerprint } = require('../src/database/table-rows');
const { restoreAll } = require('../src/platform/backup-restore-all');

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
    await restoreAll({ db: target, file: path.join(dir, backup.name), vault, env: { AQUATECH_RESTORE_TEST: '1' }, tempDir: dir });
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
