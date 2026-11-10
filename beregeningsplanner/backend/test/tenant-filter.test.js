// Tenantfilter (T-02 uit de audit van 1.7.3): elke nieuwe SQL-tekst op een tabel met
// tenant_id moet op de tenant filteren. De bestaande uitzonderingen staan in
// tools/tenant-filter-baseline.json (alleen korter maken); zie tools/tenant-filter.js.
const test = require('node:test');
const assert = require('node:assert');
const { scanAll, readBaseline, compare } = require('../tools/tenant-filter');

test('geen nieuwe query zonder tenantfilter op een tabel met tenant_id', () => {
  const { added, gone } = compare(scanAll(), readBaseline());
  assert.deepStrictEqual(added.map((entry) => `${entry.file}:${entry.line}: ${entry.sql}`), [],
    'Filter op tenant_id (WHERE tenant_id = ?). Is het echt een uitzondering (bijv. een uniek id uit een rij die al op de tenant is gefilterd)? Leg dan uit waarom in de PR en werk de lijst bij met node tools/tenant-filter.js --update.');
  assert.deepStrictEqual(gone.map((entry) => `${entry.file}: ${entry.sql}`), [], 'Deze uitzonderingen bestaan niet meer: haal ze uit tools/tenant-filter-baseline.json (node tools/tenant-filter.js --update).');
});

test('de controle herkent een query zonder tenantfilter', () => {
  const { scanSource } = require('../tools/tenant-filter');
  const source = "const sql = 'SELECT id FROM quotes WHERE id = ?';\nconst safe = `SELECT id FROM quotes WHERE tenant_id = ? AND id = ${'?'}`;\nconst other = 'SELECT id FROM tenants WHERE id = ?';\n";
  const found = scanSource('proef.js', source, new Set(['quotes']));
  assert.deepStrictEqual(found.map((entry) => [entry.line, entry.sql]), [[1, 'SELECT id FROM quotes WHERE id = ?']]);
});

test('tenant_id alleen in de gekozen kolommen of in een koppeling telt niet als tenantfilter', () => {
  const { scanSource } = require('../tools/tenant-filter');
  const source = "const sql = 'SELECT tenant_id, id FROM quotes WHERE id = ?';\nconst insert = 'INSERT INTO quotes (id, tenant_id) VALUES (?, ?)';\nconst joined = 'SELECT r.id FROM quotes r JOIN users u ON u.tenant_id = r.tenant_id WHERE r.id = ?';\n";
  const found = scanSource('proef.js', source, new Set(['quotes', 'users']));
  assert.deepStrictEqual(found.map((entry) => entry.line), [1, 3]);
  const bound = "const joined = 'SELECT r.id FROM quotes r JOIN users u ON u.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.id = ?';\nconst template = `SELECT id FROM quotes WHERE tenant_id = ${'x'} AND id = ?`;\n";
  assert.deepStrictEqual(scanSource('proef.js', bound, new Set(['quotes', 'users'])), []);
});
