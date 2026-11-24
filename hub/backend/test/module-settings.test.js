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
  assert.deepStrictEqual([...Tools.hiddenSections(off)].sort(), ['bestelvoorstellen', 'labels', 'outsourcing']);
  assert.deepStrictEqual([...Tools.lockedSettings(off)].sort(), ['labelTemplates', 'outsourcing', 'priceFactors', 'purchaseProposals']);
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
  // Hoofdletters en een slash aan het eind omzeilen de blokkade niet (Express routeert zonder hoofdlettergevoeligheid).
  for (const [method, url, body] of [['put', '/app/api/Sprinkler-Library', { bodies: [] }], ['del', '/app/api/SPRINKLER-LIBRARY/'], ['put', '/app/api/Stock/price-factors', { defaultFactor: 2 }]]) {
    const response = await adminA[method](url, body);
    assert.strictEqual(response.status, 409, `${method} ${url}`);
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

test('register: elke schakelaar hoort bij een categorie, heeft een unieke id en een bestaande instelling', () => {
  const tree = Tools.switchTree();
  assert.deepStrictEqual(tree.map((category) => category.key), ['verkoop', 'werk', 'magazijn', 'webshop', 'klantcontact', 'koppelingen']);
  const ids = Tools.switchIds();
  assert.strictEqual(new Set(ids).size, ids.length, 'geen dubbele id');
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,40}$/, `${id}: past in de vlaggen`);
  assert.ok(!ids.includes('beheer') && !ids.includes('hoofdbeheer') && !ids.includes('klanten'), 'altijd aan heeft geen schakelaar');
  for (const category of tree) for (const card of category.cards) assert.ok(card.title && card.summary, `${card.id}: titel en korte tekst`);
  const categoryKeys = new Set(Tools.CATEGORIES.map((category) => category.key));
  for (const module of MODULES) if (module.category) assert.ok(categoryKeys.has(module.category), `${module.id}: categorie ${module.category}`);
  for (const feature of Tools.FEATURES) {
    assert.ok(Boolean(feature.category) !== Boolean(feature.partOf), `${feature.id}: een kaart of een onderdeel, niet allebei`);
    assert.ok(!MODULES.some((module) => module.id === feature.id), `${feature.id}: id bestaat al als module`);
    if (feature.partOf) assert.ok(ids.includes(feature.partOf), `${feature.id}: hoort bij een kaart die bestaat`);
    if (feature.setting) {
      const definition = FIELDS[feature.setting.key];
      assert.ok(definition, `${feature.id}: instelling ${feature.setting.key} bestaat niet`);
      assert.strictEqual(definition.type, feature.setting.field ? 'object' : 'bool', `${feature.id}: soort instelling`);
      assert.ok(!definition.internal && !definition.platform, `${feature.id}: instelling is via Beheer te wijzigen`);
      if (feature.setting.field) assert.strictEqual(typeof definition.sanitize({ [feature.setting.field]: true })[feature.setting.field], 'boolean', `${feature.id}: veld bestaat`);
    }
  }
  const indexing = fs.readFileSync(path.join(FRONTEND_DIR, 'beheer', 'indeling.js'), 'utf8');
  for (const feature of Tools.FEATURES) if (feature.section) assert.ok(indexing.includes(`{ id: '${feature.section}', label:`), `${feature.id}: sectie ${feature.section} staat niet in beheer/indeling.js`);
  for (const entry of [...MODULES, ...Tools.FEATURES]) if (entry.needs) assert.ok(ids.includes(entry.needs), `${entry.id}: nodig ${entry.needs}`);
  assert.strictEqual(Tools.titleOf('offerte-opvolging'), 'Automatische opvolging');
});

test('hulpfuncties: een onderdeel volgt zijn kaart en `needs` de module die het nodig heeft', () => {
  assert.strictEqual(Tools.isOn({}, 'offerte-opvolging'), true);
  assert.strictEqual(Tools.isOn({ offertes: false }, 'offerte-opvolging'), false);
  assert.strictEqual(Tools.isOn({ beregening: false }, 'plannen'), false);
  assert.strictEqual(Tools.isOn({ plannen: false }, 'beregening'), true);
  assert.strictEqual(Tools.isOn({ werkorders: false }, 'uitbesteden'), false, 'uitbesteden heeft werkorders nodig');
  assert.strictEqual(Tools.isOn({ webshop: false }, 'webshop-bestellingen'), false, 'bestellingen horen bij de webshop');
  assert.strictEqual(Tools.isOn({ webshop: false }, 'webshop-gast'), false);
});

test('server: Beheer > Modules leest en schrijft vlaggen en de instellingen achter een schakelaar', async () => {
  const { adminA } = await setup();
  const start = (await adminA.get('/app/api/admin/modules')).body;
  assert.strictEqual(start.flags.webshop, false, 'de webshop staat standaard uit');
  assert.strictEqual(start.flags['bestelvoorstellen-automatisch'], true);
  assert.strictEqual(start.flags['offerte-opvolging'], false);
  assert.deepStrictEqual(start.locked, {});

  const saved = await adminA.put('/app/api/admin/modules', { flags: { planning: false, 'offerte-opvolging': true, 'bestelvoorstellen-automatisch': false, webshop: true, 'webshop-gast': false, 'ai-koppeling': true, facturen: true } });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.on.sort(), ['ai-koppeling', 'offerte-opvolging', 'webshop']);
  assert.deepStrictEqual(saved.body.off.sort(), ['bestelvoorstellen-automatisch', 'planning', 'webshop-gast'], 'facturen stond al aan en telt niet als wijziging');
  const settings = (await adminA.get('/app/api/admin/settings')).body.settings;
  assert.strictEqual(settings.modules.value.planning, false);
  assert.strictEqual(settings.quoteFollowUp.value.enabled, true);
  assert.strictEqual(settings.quoteFollowUp.value.afterDays, 7, 'de rest van de instelling blijft');
  assert.strictEqual(settings.purchaseProposals.value.enabled, false);
  assert.strictEqual(settings.storefront.value, true);
  assert.strictEqual(settings.shopPayment.value.guestCheckout, false);
  assert.strictEqual(settings.shopPayment.value.quoteRequest, true);
  assert.strictEqual(settings.aiConnector.value, true);
  const config = (await adminA.get('/app/api/config')).body.modules;
  assert.strictEqual(config.planning, false);
  assert.strictEqual(config.webshop, true);
  assert.strictEqual(config['webshop-gast'], false);

  // De instelling zelf wijzigen (het oude formulier) is direct zichtbaar in Modules: één waarheid.
  await adminA.put('/app/api/admin/settings', { aiConnector: false });
  assert.strictEqual((await adminA.get('/app/api/admin/modules')).body.flags['ai-koppeling'], false);

  const audit = (await adminA.get('/app/api/admin/audit')).body;
  const entry = (audit.items || audit.entries || audit).find((row) => row.action === 'modules_gewijzigd');
  assert.ok(entry, 'auditregel');
});

test('server: Beheer > Modules weigert onbekende id\'s, verkeerde waarden en onderdelen van een uitgezette module', async () => {
  const { adminA } = await setup();
  for (const body of [{}, { flags: [] }, { flags: { nietbestaand: false } }, { flags: { beheer: false } }, { flags: { klanten: false } }, { flags: { planning: 'nee' } }, { flags: { bestelvoorstel: false } }]) {
    const response = await adminA.put('/app/api/admin/modules', body);
    assert.strictEqual(response.status, 400, JSON.stringify(body));
    assert.strictEqual(response.body.error, 'invalid_module');
  }
  // Alles of niets: een geldige vlag naast een ongeldige wordt niet bewaard.
  await adminA.put('/app/api/admin/modules', { flags: { planning: false, nietbestaand: false } });
  assert.strictEqual((await adminA.get('/app/api/config')).body.modules.planning, undefined);

  assert.strictEqual((await adminA.put('/app/api/admin/modules', { flags: { voorraad: false } })).status, 200);
  const hidden = await adminA.put('/app/api/admin/modules', { flags: { 'bestelvoorstellen-automatisch': false } });
  assert.strictEqual(hidden.status, 409);
  assert.strictEqual(hidden.body.error, 'module_off');
  // Tegelijk aanzetten en het onderdeel wijzigen mag.
  assert.strictEqual((await adminA.put('/app/api/admin/modules', { flags: { voorraad: true, 'bestelvoorstellen-automatisch': false } })).status, 200);
});

test('server: Beheer > Modules per organisatie, alleen voor beheerders, en de webshop alleen in de hoofdorganisatie', async () => {
  const { base, adminA, adminB } = await setup();
  const lockedB = (await adminB.get('/app/api/admin/modules')).body.locked;
  assert.ok(lockedB.webshop && lockedB['webshop-gast'], 'webshop op slot buiten de hoofdorganisatie');
  const refused = await adminB.put('/app/api/admin/modules', { flags: { webshop: true } });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'module_locked');
  assert.strictEqual((await adminB.put('/app/api/admin/modules', { flags: { webshop: false, planning: false } })).status, 200, 'uit laten staan is geen wijziging');
  assert.strictEqual((await adminA.get('/app/api/config')).body.modules.planning, undefined, 'A houdt haar eigen modules');
  assert.strictEqual((await adminB.get('/app/api/config')).body.modules.planning, false);

  await adminA.post('/app/api/admin/users', { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW, mustChangePassword: false });
  const fitter = await createLogin(base, { password: PW })('monteur');
  assert.strictEqual((await fitter.get('/app/api/admin/modules')).status, 403);
  assert.strictEqual((await fitter.put('/app/api/admin/modules', { flags: { planning: false } })).status, 403);
});

test('server: zonder multitenancy staat uitbesteden op slot in Beheer > Modules', async () => {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  const view = (await admin.get('/app/api/admin/modules')).body;
  assert.strictEqual(view.flags.uitbesteden, false);
  assert.ok(view.locked.uitbesteden);
  assert.strictEqual((await admin.put('/app/api/admin/modules', { flags: { uitbesteden: true } })).status, 409);
});

test('hulpfuncties: adressen van een uitgezet onderdeel zijn helemaal dicht (patronen met een sterretje)', () => {
  assert.deepStrictEqual(Tools.blockedRoutes({}), []);
  assert.deepStrictEqual(Tools.blockedRoutes({ nacalculatie: false }), ['/api/workorders/*/costing']);
  assert.deepStrictEqual(Tools.blockedRoutes({ werkorders: false, offertes: false }), [], 'alleen de module uit: de regel van de module geldt (lezen blijft)');
  assert.strictEqual(Tools.matchesRoute('/api/workorders/*/costing', '/api/workorders/abc/costing'), true);
  assert.strictEqual(Tools.matchesRoute('/api/workorders/*/costing', '/api/workorders/abc/costing/extra'), false);
  assert.strictEqual(Tools.matchesRoute('/api/workorders/*/costing', '/api/workorders/costing'), false);
  assert.strictEqual(Tools.matchesRoute('/api/quote-templates/**', '/api/quote-templates'), true);
  assert.strictEqual(Tools.matchesRoute('/api/quote-templates/**', '/api/quote-templates/abc/nog-iets'), true);
  assert.strictEqual(Tools.matchesRoute('/api/quote-templates/**', '/api/quote-templatesx'), false);
  assert.strictEqual(Tools.matchesRoute('/api/quote-templates/**', '/api'), false);
  for (const entry of [...MODULES, ...Tools.FEATURES]) {
    for (const pattern of (entry.configuration && entry.configuration.blocked) || []) assert.match(pattern, /^\/api\/[a-z-]+(\/([a-z-]+|\*))*(\/\*\*)?$/, `${entry.id}: ${pattern}`);
  }
});

test('server: een uitgezet onderdeel weigert ook lezen op zijn adressen, aan werkt het weer', async () => {
  const { adminA, adminB } = await setup();
  const id = '3f0e6f5c-0d5e-4d0b-9a57-0c1f1b9d2a11';
  const routes = [
    ['get', `/app/api/workorders/${id}/costing`], ['get', '/app/api/quote-templates'], ['put', '/app/api/quote-templates', { template: { name: 'Gazon' } }],
    ['post', `/app/api/workorders/${id}/share`, { url: 'https://voorbeeld.nl/' }], ['post', `/app/api/workorders/${id}/send`, {}], ['get', `/app/api/portal/locations/l-${'a'.repeat(64)}`],
    ['post', '/app/api/plan/analyze', {}],
  ];
  for (const [method, url, body] of routes) assert.notStrictEqual((await adminA[method](url, body)).status, 409, `aan: ${method} ${url}`);
  const off = { nacalculatie: false, offertesjablonen: false, afspraaklink: false, installatiedossier: false, 'plan-herkennen-ai': false };
  assert.strictEqual((await adminA.put('/app/api/admin/modules', { flags: off })).status, 200);
  for (const [method, url, body] of routes) {
    const response = await adminA[method](url, body);
    assert.strictEqual(response.status, 409, `uit: ${method} ${url}`);
    assert.strictEqual(response.body.error, 'module_off');
  }
  // Hoofdletters en een slash aan het eind omzeilen de blokkade niet; een andere organisatie merkt er niets van.
  assert.strictEqual((await adminA.get(`/app/api/Workorders/${id}/Costing/`)).status, 409);
  assert.strictEqual((await adminA.get('/app/api/QUOTE-TEMPLATES/')).status, 409);
  assert.notStrictEqual((await adminB.get('/app/api/quote-templates')).status, 409);
  // De werkorders zelf blijven gewoon werken.
  assert.strictEqual((await adminA.get('/app/api/workorders')).status, 200);
  assert.strictEqual((await adminA.put('/app/api/admin/modules', { flags: Object.fromEntries(Object.keys(off).map((key) => [key, true])) })).status, 200);
  for (const [method, url, body] of routes) assert.notStrictEqual((await adminA[method](url, body)).status, 409, `weer aan: ${method} ${url}`);
});
