// Instellingen van uitgeschakelde modules: het moduleregister (frontend/dashboard/modules.js, veld `configuration`) bepaalt
// welke Beheer-secties verdwijnen, welke instellingen de server niet meer wijzigt en welke API-adressen geen
// schrijfacties meer toelaten. Getest: de zuivere hulpfuncties, de klopt-het-met-de-code-controles, de server en de scheiding tussen organisaties.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { FIELDS } = require('../src/platform/settings');
const { FRONTEND_DIR } = require('../src/paths');
const { createLogin, listen } = require('./helpers/http-client');

const MODULES = require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
const Tools = MODULES.tools;
const SECRET = 'm'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Twee organisaties met elk een beheerder; multitenancy aan.
 * @returns {Promise<object>} adminA (hoofdtenant), adminB (organisatie "ander") en de basis-URL.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { base, adminA: await as('baas'), adminB: await as('vreemd', 'ander') };
}

test('export: de server krijgt de hulpfuncties via de lijst zelf, zonder browseromgeving', () => {
  assert.ok(Array.isArray(MODULES));
  assert.strictEqual(typeof MODULES.tools.isOn, 'function');
  assert.ok(!Object.keys(MODULES).includes('tools'), 'niet-opsombaar');
});

test('hulpfuncties: onderdelen volgen hun hoofdmodule, beheer staat altijd aan', () => {
  assert.strictEqual(Tools.isOn({}, 'voorraad'), true);
  assert.strictEqual(Tools.isOn({ voorraad: false }, 'voorraad'), false);
  assert.strictEqual(Tools.isOn({ voorraad: false }, 'bestelvoorstel'), false, 'onderdeel volgt voorraad');
  assert.strictEqual(Tools.isOn({ voorraad: true }, 'bestelvoorstel'), true);
  assert.strictEqual(Tools.isOn({ beheer: false, hoofdbeheer: false }, 'beheer'), true);
  assert.strictEqual(Tools.isOn({ beheer: false, hoofdbeheer: false }, 'hoofdbeheer'), true);
  assert.strictEqual(Tools.isOn(undefined, 'voorraad'), true, 'geen vlaggen = alles aan');
  assert.strictEqual(Tools.isOn({ nietbestaand: false }, 'nietbestaand'), false);
});

test('hulpfuncties: secties, instellingen en adressen van uitgezette modules', () => {
  assert.deepStrictEqual([...Tools.hiddenSections({})], []);
  assert.deepStrictEqual([...Tools.lockedSettings({})], []);
  assert.deepStrictEqual(Tools.lockedRoutes({}), []);
  const off = { voorraad: false, uitbesteden: false };
  assert.deepStrictEqual([...Tools.hiddenSections(off)].sort(), ['labels', 'outsourcing']);
  assert.deepStrictEqual([...Tools.lockedSettings(off)].sort(), ['labelTemplates', 'outsourcing', 'priceFactors']);
  assert.ok(Tools.lockedRoutes(off).includes('/api/stock/labels'));
  assert.ok(!Tools.lockedRoutes(off).includes('/api/sprinkler-library'), 'planner staat nog aan');
  // Alleen een onderdeel uit (kan niet via Beheer, wel via de data) laat de hoofdmodule met rust.
  assert.deepStrictEqual([...Tools.hiddenSections({ bestelvoorstel: false })], []);
});

test('register klopt met de code: secties bestaan in Beheer, instellingen in settings.js, adressen zijn API-adressen', () => {
  const indexing = fs.readFileSync(path.join(FRONTEND_DIR, 'beheer', 'indeling.js'), 'utf8');
  const sectionIds = new Set([...indexing.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((match) => match[1]));
  const withConfiguration = MODULES.filter((module) => module.configuration);
  assert.ok(withConfiguration.length >= 4);
  for (const module of withConfiguration) {
    for (const section of module.configuration.sections || []) assert.ok(sectionIds.has(section), `${module.id}: sectie ${section} staat niet in beheer/indeling.js`);
    for (const key of module.configuration.settings || []) assert.ok(FIELDS[key], `${module.id}: instelling ${key} bestaat niet`);
    for (const route of module.configuration.routes || []) assert.match(route, /^\/api\/[a-z-]+(\/[a-z-]+)*$/, `${module.id}: ${route}`);
    assert.ok(!module.partOf, `${module.id}: een onderdeel heeft geen eigen configuratie (hoort bij de hoofdmodule)`);
  }
});

test('server: instellingen van een uitgezette module worden niet gewijzigd, lezen blijft kunnen', async () => {
  const { adminA } = await setup();
  const labels = { labelTemplates: { templates: [{ name: 'Bak 40 × 20', widthMm: 40, heightMm: 20, showPrice: false }] } };
  assert.strictEqual((await adminA.put('/app/api/admin/settings', labels)).status, 200, 'module aan');
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { modules: { voorraad: false } })).status, 200);

  const blocked = await adminA.put('/app/api/admin/settings', labels);
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.error, 'module_off');
  assert.strictEqual(blocked.body.field, 'labelTemplates');
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { reset: ['labelTemplates'] })).status, 409, 'terugzetten telt ook');
  // Alles of niets: een mix met een vrije instelling slaat niets op.
  const mixed = await adminA.put('/app/api/admin/settings', { aiDailyLimit: 77, labelTemplates: labels.labelTemplates });
  assert.strictEqual(mixed.status, 409);
  assert.notStrictEqual((await adminA.get('/app/api/admin/settings')).body.settings.aiDailyLimit.value, 77);
  // Een andere instelling blijft gewoon kunnen en de bewaarde waarde blijft staan.
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { aiDailyLimit: 77 })).status, 200);
  const view = (await adminA.get('/app/api/admin/settings')).body.settings;
  assert.strictEqual(view.labelTemplates.value.templates[0].name, 'Bak 40 × 20', 'bewaarde waarde blijft bij uitzetten');

  // Tegelijk aanzetten en wijzigen mag: de patch telt mee.
  const together = await adminA.put('/app/api/admin/settings', { modules: { voorraad: true }, labelTemplates: labels.labelTemplates });
  assert.strictEqual(together.status, 200);
  // Tegelijk uitzetten en wijzigen mag niet.
  const both = await adminA.put('/app/api/admin/settings', { modules: { voorraad: false }, labelTemplates: labels.labelTemplates });
  assert.strictEqual(both.status, 409);
  assert.strictEqual((await adminA.get('/app/api/config')).body.modules.voorraad, true, 'de mislukte patch zette niets');
});

test('server: schrijfacties op de adressen van een uitgezette module geven 409, lezen niet', async () => {
  const { adminA } = await setup();
  await adminA.put('/app/api/admin/settings', { modules: { voorraad: false, beregening: false } });
  assert.strictEqual((await adminA.get('/app/api/stock/label-templates')).status, 200);
  assert.strictEqual((await adminA.get('/app/api/stock/price-factors')).status, 200);
  assert.strictEqual((await adminA.get('/app/api/sprinkler-library')).status, 200, 'planner leest zijn bibliotheek');
  for (const [method, url, body] of [
    ['post', '/app/api/stock/labels', { items: [{ id: 'x', qty: 1 }] }],
    ['put', '/app/api/stock/price-factors', { defaultFactor: 2 }],
    ['post', '/app/api/stock/price-factors/apply', { items: [] }],
    ['put', '/app/api/sprinkler-library', { bodies: [] }],
    ['del', '/app/api/sprinkler-library'],
  ]) {
    const response = await adminA[method](url, body);
    assert.strictEqual(response.status, 409, `${method} ${url}`);
    assert.strictEqual(response.body.error, 'module_off', `${method} ${url}`);
  }
  // Weer aan: de routes werken weer (hier alleen: geen 409 meer).
  await adminA.put('/app/api/admin/settings', { modules: { voorraad: true, beregening: true } });
  assert.notStrictEqual((await adminA.post('/app/api/stock/labels', { items: [] })).status, 409);
  assert.notStrictEqual((await adminA.del('/app/api/sprinkler-library')).status, 409);
});

test('server: een andere organisatie houdt haar eigen modules', async () => {
  const { adminA, adminB } = await setup();
  await adminA.put('/app/api/admin/settings', { modules: { voorraad: false } });
  const labels = { labelTemplates: { templates: [{ name: 'Bak', widthMm: 40, heightMm: 20, showPrice: false }] } };
  assert.strictEqual((await adminA.put('/app/api/admin/settings', labels)).status, 409);
  assert.strictEqual((await adminB.put('/app/api/admin/settings', labels)).status, 200, 'B heeft voorraad nog aan');
  assert.notStrictEqual((await adminB.post('/app/api/stock/labels', { items: [] })).status, 409);
});

test('server: uitbesteden staat uit zonder multitenancy, ook de instelling', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  const blocked = await admin.put('/app/api/admin/settings', { outsourcing: { send: true } });
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.field, 'outsourcing');
});

test('seizoensherinneringen: zonder klantportaal (module uit) wordt er niets verstuurd', async () => {
  const { createSeasonReminderRunner } = require('../src/uitvoering/season-reminders');
  let asked = 0;
  const runner = createSeasonReminderRunner({}, {
    enabled: () => false,
    settingsFor: () => { asked += 1; return { get: () => ({ enabled: true }) }; },
    mailerFor: () => ({ configured: () => true }),
    userTenantsOf: (id) => [id],
  });
  assert.deepStrictEqual(await runner.runEnvironment('t1', new Date('2026-03-20T12:00:00Z')), { sent: 0, skipped: 0, failed: 0 });
  assert.strictEqual(asked, 0, 'de instellingen worden niet eens opgevraagd');
});
