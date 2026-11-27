// Hoofdgroepen (merken), subgroepen (soorten), het codevoorstel en oude nummers (artikelen/code-groups.js, migratie 104):
// invoer, routes, de vaste code zodra er artikelen aan hangen, uniciteit, rechten en scheiding tussen organisaties.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeGroup, sanitizeAliases } = require('../src/artikelen/code-groups');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} db, server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  return { db, server, as: createLogin(base, { password: PW }) };
}

test('groepen en oude nummers: invoer opschonen en controleren', () => {
  assert.deepStrictEqual(sanitizeGroup({ code: ' ud ', name: ' Unidelta ' }).value, { code: 'UD', name: 'Unidelta' });
  assert.strictEqual(sanitizeGroup({ code: '1AB', name: 'X' }).field, 'code');
  assert.strictEqual(sanitizeGroup({ code: 'UD', name: ' ' }).field, 'name');
  assert.strictEqual(sanitizeGroup({ sort: 1.5 }, { partial: true }).field, 'sort');
  assert.deepStrictEqual(sanitizeAliases(['A-1', { alias: 'a-1' }, { alias: 'EAN1', kind: 'ean' }, '']).value, [{ alias: 'A-1', kind: 'oud' }, { alias: 'EAN1', kind: 'ean' }]);
  assert.strictEqual(sanitizeAliases([{ alias: 'X', kind: 'raar' }]).field, 'aliases');
  assert.strictEqual(sanitizeAliases('x').field, 'aliases');
});

test('groepen: merk en soort aanmaken, codevoorstel met en zonder merk, uniciteit en vaste code', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const brand = await kees.post('/app/api/stock/main-groups', { code: 'ud', name: 'Unidelta' });
    assert.strictEqual(brand.status, 201, JSON.stringify(brand.body));
    assert.strictEqual(brand.body.code, 'UD');
    assert.strictEqual((await kees.post('/app/api/stock/main-groups', { code: 'UD', name: 'Dubbel' })).status, 409);
    const kind = (await kees.post('/app/api/stock/sub-groups', { mainGroupId: brand.body.id, code: 'KBI', name: 'Koppeling buitendraad' })).body;
    const plain = (await kees.post('/app/api/stock/sub-groups', { code: 'KBI', name: 'Zonder merk' })).body;
    // Dezelfde soortcode mag onder een ander merk of zonder merk, maar niet twee keer op dezelfde plek.
    assert.strictEqual((await kees.post('/app/api/stock/sub-groups', { mainGroupId: brand.body.id, code: 'KBI', name: 'Nog een' })).status, 409);
    assert.strictEqual((await kees.post('/app/api/stock/sub-groups', { code: 'KBI', name: 'Nog een' })).status, 409);
    assert.strictEqual((await kees.post('/app/api/stock/sub-groups', { mainGroupId: 'bestaat-niet', code: 'KBA', name: 'X' })).status, 400);

    const proposal = await kees.get(`/app/api/stock/code-proposal?subGroupId=${kind.id}&diameter=20&thread=${encodeURIComponent('3/4"')}`);
    assert.deepStrictEqual(proposal.body, { code: 'UD.KBI.20.34', taken: false });
    assert.strictEqual((await kees.get(`/app/api/stock/code-proposal?subGroupId=${plain.id}&diameter=20&thread=12`)).body.code, 'KBI.20.12');
    assert.strictEqual((await kees.get(`/app/api/stock/code-proposal?subGroupId=${kind.id}&diameter=abc`)).status, 400);
    assert.strictEqual((await kees.get('/app/api/stock/code-proposal?subGroupId=bestaat-niet')).status, 400);

    // Een bestaande code is bezet; een artikelgroep krijgt MERK.SOORT en daarna een volgnummer.
    await kees.post('/app/api/stock/items', { code: 'UD.KBI.20.34', name: 'KBI 20 x 3/4' });
    const taken = (await kees.get(`/app/api/stock/code-proposal?subGroupId=${kind.id}&diameter=20&thread=34`)).body;
    assert.deepStrictEqual(taken, { code: 'UD.KBI.20.34', taken: true, takenBy: 'UD.KBI.20.34' });
    assert.strictEqual((await kees.get(`/app/api/stock/code-proposal?subGroupId=${kind.id}&group=1`)).body.code, 'UD.KBI');
    await kees.post('/app/api/stock/items', { code: 'UD.KBI', name: 'Groep' });
    assert.strictEqual((await kees.get(`/app/api/stock/code-proposal?subGroupId=${kind.id}&group=1`)).body.code, 'UD.KBI-2');

    const listed = (await kees.get('/app/api/stock/code-groups')).body;
    assert.deepStrictEqual(listed.mainGroups.map((group) => group.code), ['UD']);
    assert.strictEqual(listed.subGroups.length, 2);
    // Wijzigen mag zolang er niets aan hangt; verwijderen zonder artikelen is echt weg.
    assert.strictEqual((await kees.patch(`/app/api/stock/sub-groups/${plain.id}`, { code: 'KBX' })).body.code, 'KBX');
    assert.deepStrictEqual((await kees.del(`/app/api/stock/sub-groups/${plain.id}`)).body, { deleted: true });
    // Een merk met een soort hangt eraan: code blijft vast en verwijderen archiveert.
    assert.strictEqual((await kees.patch(`/app/api/stock/main-groups/${brand.body.id}`, { code: 'XX' })).status, 409);
    assert.strictEqual((await kees.patch(`/app/api/stock/main-groups/${brand.body.id}`, { name: 'Unidelta BV' })).body.name, 'Unidelta BV');
    assert.deepStrictEqual((await kees.del(`/app/api/stock/main-groups/${brand.body.id}`)).body, { archived: true });
    assert.strictEqual((await kees.get('/app/api/stock/code-groups')).body.mainGroups.length, 0);
    assert.strictEqual((await kees.get('/app/api/stock/code-groups?archived=1')).body.mainGroups.length, 1);
    assert.strictEqual((await kees.del(`/app/api/stock/main-groups/${brand.body.id}x`)).status, 404);
  } finally {
    server.close();
  }
});

test('oude nummers: vervangen, uniek per omgeving, rechten en andere organisatie', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const klant = await as('klant');
    const itemA = (await kees.post('/app/api/stock/items', { code: 'UD.KBI.20.12', name: 'A' })).body;
    const itemB = (await kees.post('/app/api/stock/items', { code: 'UD.KBI.20.34', name: 'B' })).body;
    const saved = await kees.put(`/app/api/stock/items/${itemA.id}/aliases`, { aliases: [{ alias: 'KBI-20-12', kind: 'oud' }, '8712345678906'] });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.deepStrictEqual((await kees.get(`/app/api/stock/items/${itemA.id}/aliases`)).body.items.map((entry) => entry.alias).sort(), ['8712345678906', 'KBI-20-12']);
    // Een nummer van een ander artikel of de code van een ander artikel is bezet (ook met andere hoofdletters).
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/aliases`, { aliases: ['kbi-20-12'] })).status, 409);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/aliases`, { aliases: ['UD.KBI.20.12'] })).status, 409);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemA.id}/aliases`, { aliases: 'x' })).status, 400);
    assert.strictEqual((await kees.put('/app/api/stock/items/bestaat-niet/aliases', { aliases: [] })).status, 404);
    // Leegmaken kan; verwijderen van het artikel wist ook de nummers.
    assert.deepStrictEqual((await kees.put(`/app/api/stock/items/${itemA.id}/aliases`, { aliases: [] })).body.items, []);
    await kees.put(`/app/api/stock/items/${itemB.id}/aliases`, { aliases: ['OUD-B'] });
    assert.strictEqual((await kees.del(`/app/api/stock/items/${itemB.id}`)).status, 200);

    assert.strictEqual((await klant.get('/app/api/stock/code-groups')).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/main-groups', { code: 'UD', name: 'X' })).status, 403);
    assert.strictEqual((await klant.get(`/app/api/stock/items/${itemA.id}/aliases`)).status, 403);

    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    const brand = (await kees.post('/app/api/stock/main-groups', { code: 'UD', name: 'Unidelta' })).body;
    assert.deepStrictEqual((await piet.get('/app/api/stock/code-groups')).body, { mainGroups: [], subGroups: [] });
    assert.strictEqual((await piet.patch(`/app/api/stock/main-groups/${brand.id}`, { name: 'Gekaapt' })).status, 404);
    assert.strictEqual((await piet.del(`/app/api/stock/main-groups/${brand.id}`)).status, 404);
    assert.strictEqual((await piet.get(`/app/api/stock/items/${itemA.id}/aliases`)).status, 404);
    assert.strictEqual((await piet.post('/app/api/stock/sub-groups', { mainGroupId: brand.id, code: 'KBI', name: 'X' })).status, 400);
    // Dezelfde merkcode mag in de andere organisatie.
    assert.strictEqual((await piet.post('/app/api/stock/main-groups', { code: 'UD', name: 'Eigen' })).status, 201);
  } finally {
    server.close();
  }
});

test('artikel met soort: code wordt vast, soort kiezen en oude nummers als code geweigerd', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const brand = (await kees.post('/app/api/stock/main-groups', { code: 'UD', name: 'Unidelta' })).body;
    const kind = (await kees.post('/app/api/stock/sub-groups', { mainGroupId: brand.id, code: 'KBI', name: 'Koppeling buitendraad' })).body;
    const created = await kees.post('/app/api/stock/items', { code: 'UD.KBI.20.34', name: 'KBI 20 x 3/4"', subGroupId: kind.id });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const item = created.body.item || created.body;
    assert.strictEqual(item.subGroupId, kind.id);
    assert.strictEqual(item.mainGroupId, brand.id);
    // De uitgegeven code verandert nooit meer, de soort ook niet.
    const rename = await kees.put(`/app/api/stock/items/${item.id}`, { code: 'UD.KBI.20.12' });
    assert.strictEqual(rename.status, 409);
    assert.strictEqual(rename.body.field, 'code');
    assert.strictEqual((await kees.put(`/app/api/stock/items/${item.id}`, { subGroupId: null })).status, 409);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${item.id}`, { name: 'Nieuwe naam' })).status, 200);
    // Een soort met artikelen houdt zijn code en wordt gearchiveerd.
    const removed = await kees.del(`/app/api/stock/sub-groups/${kind.id}`);
    assert.strictEqual(removed.body.archived, true);
    assert.strictEqual((await kees.post('/app/api/stock/items', { code: 'UD.KBI.25', name: 'x', subGroupId: kind.id })).status, 409);
    // Een code die al een oud nummer van een ander artikel is, kan niet.
    const other = (await kees.post('/app/api/stock/items', { code: 'LOS-1', name: 'Los artikel' })).body;
    const otherItem = other.item || other;
    assert.strictEqual((await kees.put(`/app/api/stock/items/${otherItem.id}/aliases`, { aliases: ['OUD-77'] })).status, 200);
    assert.strictEqual((await kees.post('/app/api/stock/items', { code: 'oud-77', name: 'Dubbel' })).status, 409);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${item.id}`, { code: 'OUD-77' })).status, 409);
    const free = (await kees.post('/app/api/stock/items', { code: 'LOS-2', name: 'Tweede' })).body;
    assert.strictEqual((await kees.put(`/app/api/stock/items/${(free.item || free).id}`, { code: 'OUD-77' })).status, 409);
    assert.strictEqual((await kees.post('/app/api/stock/items', { code: 'X1', name: 'x', subGroupId: 'bestaat-niet' })).status, 404);
  } finally {
    server.close();
  }
});

test('artikellijst: oude nummers komen mee om op te zoeken', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const made = (await kees.post('/app/api/stock/items', { code: 'LIJST-1', name: 'Lijstartikel' })).body;
    const item = made.item || made;
    assert.strictEqual((await kees.put(`/app/api/stock/items/${item.id}/aliases`, { aliases: ['OUD-1', { alias: '8712345678906', kind: 'ean' }] })).status, 200);
    const list = (await kees.get('/app/api/stock')).body.items;
    assert.deepStrictEqual(list.find((row) => row.id === item.id).aliases.sort(), ['8712345678906', 'OUD-1']);
  } finally {
    server.close();
  }
});

test('keuzelijst: subartikelen van klein naar groot uit de code en zoeken op oude nummers', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const codes = [['KBI.100.2', '100 mm'], ['KBI.20.12', '20 mm'], ['KBI.20.1', '20 mm 1"'], ['KBI.25.34', '25 mm']];
    const made = [];
    for (const [code, size] of codes) made.push((await kees.post('/app/api/stock/items', { code, name: `Koppeling ${size}`, unit: 'st', salePrice: 5, vatRate: 21 })).body);
    const items = made.map((entry) => entry.item || entry);
    const merged = await kees.post('/app/api/stock/merge', { ids: items.map((item) => item.id), code: 'KBI', name: 'Koppeling', attributeName: 'Maat',
      values: Object.fromEntries(items.map((item, index) => [item.id, codes[index][1]])) });
    assert.strictEqual(merged.status, 201);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${items[1].id}/aliases`, { aliases: ['OUD-20'] })).status, 200);
    const choices = (await kees.get('/app/api/stock/articles')).body.items;
    const articleGroup = choices.find((choice) => choice.code === 'KBI');
    assert.deepStrictEqual(articleGroup.subItems.map((subItem) => subItem.code), ['KBI.20.12', 'KBI.20.1', 'KBI.25.34', 'KBI.100.2']);
    assert.deepStrictEqual(articleGroup.subItems.find((subItem) => subItem.code === 'KBI.20.12').aliases, ['OUD-20']);
  } finally {
    server.close();
  }
});
