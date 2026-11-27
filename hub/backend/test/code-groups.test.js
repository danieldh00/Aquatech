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
