// Bestaande artikelen omzetten naar sprekende codes (artikelen/code-conversion.js): herkenning van diameter, draadmaat en soort,
// het voorstel, het omzetten met oude code als zoeknaam, bezette en dubbele codes, en rechten.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { readDiameter, readThread, pickSubGroup, normalize } = require('../src/artikelen/code-conversion');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met installateur en klant, plus een testserver.
 * @returns {Promise<object>} server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  return { server, as: createLogin(base, { password: PW }) };
}

test('herkenning: diameter en draadmaat uit de naam, soort uit de woorden', () => {
  assert.strictEqual(readDiameter(normalize('Koppeling buitendraad 20 mm x 3/4"')), '20');
  assert.strictEqual(readDiameter(normalize('Bocht Ø32')), '32');
  assert.strictEqual(readDiameter(normalize('Kogelkraan')), '');
  assert.strictEqual(readThread(normalize('Koppeling 20 mm x 3/4"')), '34');
  assert.strictEqual(readThread(normalize('Nippel ½" binnendraad')), '12');
  assert.strictEqual(readThread(normalize('Verloop 1 1/4 inch')), '114');
  assert.strictEqual(readThread(normalize('Kraan G1')), '1');
  assert.strictEqual(readThread(normalize('Buis 25 mm')), '');
  const subGroups = [{ id: 'a', code: 'KBI', name: 'Koppeling buitendraad', main_group_id: 'm1' }, { id: 'b', code: 'KBI', name: 'Koppeling buitendraad', main_group_id: null }, { id: 'c', code: 'BOC', name: 'Bocht', main_group_id: null }];
  const mainGroups = [{ id: 'm1', code: 'UD', name: 'Unidelta' }];
  assert.strictEqual(pickSubGroup(normalize('Unidelta koppeling buitendraad 20'), subGroups, mainGroups).id, 'a');
  assert.strictEqual(pickSubGroup(normalize('Koppeling buitendraad 20'), subGroups, mainGroups).id, 'b');
  assert.strictEqual(pickSubGroup(normalize('Bocht 90 graden'), subGroups, mainGroups).id, 'c');
  assert.strictEqual(pickSubGroup(normalize('Slang'), subGroups, mainGroups), null);
});

test('omzetten: voorstel, omzetten met oude code als zoeknaam, bezet en dubbel, rechten', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const klant = await as('klant');
    const kind = (await kees.post('/app/api/stock/sub-groups', { code: 'KBI', name: 'Koppeling buitendraad' })).body;
    await kees.post('/app/api/stock/sub-groups', { code: 'BOC', name: 'Bocht' });
    /**
     * Maakt een artikel aan.
     * @param {string} code De code.
     * @param {string} name De naam.
     * @returns {Promise<string>} Het id van het artikel.
     */
    const idOf = async (code, name) => { const out = (await kees.post('/app/api/stock/items', { code, name })).body; return (out.item || out).id; };
    const first = await idOf('OUD-1', 'Koppeling buitendraad 20 mm 3/4"');
    const second = await idOf('OUD-2', 'Koppeling buitendraad 20 mm 3/4" (tweede)');
    const third = await idOf('OUD-3', 'Slang rood');
    await idOf('KBI.25.1', 'Bezet door ander artikel');
    const fourth = await idOf('OUD-4', 'Koppeling buitendraad 25 mm 1"');

    const proposal = (await kees.get('/app/api/stock/code-conversion')).body;
    const byId = Object.fromEntries(proposal.items.map((item) => [item.id, item]));
    assert.strictEqual(byId[first].newCode, 'KBI.20.34');
    assert.strictEqual(byId[first].status, 'klaar');
    assert.strictEqual(byId[second].status, 'dubbel');
    assert.strictEqual(byId[third].status, 'geen_soort');
    assert.strictEqual(byId[fourth].status, 'bezet');

    // Alleen wat klopt wordt omgezet; de rest komt terug met de reden.
    const applied = await kees.post('/app/api/stock/code-conversion/apply', { rows: [
      { id: first, subGroupId: kind.id, diameter: '20', thread: '3/4"' },
      { id: second, subGroupId: kind.id, diameter: '20', thread: '3/4"' },
      { id: third, subGroupId: '', diameter: '' },
      { id: fourth, subGroupId: kind.id, diameter: '25', thread: '1"' },
    ] });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(applied.body.converted, 1);
    assert.deepStrictEqual(applied.body.results.map((result) => result.ok), [true, false, false, false]);
    assert.strictEqual(applied.body.results[1].status, 'dubbel');
    const list = (await kees.get('/app/api/stock')).body.items;
    const converted = list.find((item) => item.id === first);
    assert.strictEqual(converted.code, 'KBI.20.34');
    assert.strictEqual(converted.subGroupId, kind.id);
    assert.deepStrictEqual(converted.aliases, ['OUD-1']);
    assert.strictEqual(list.find((item) => item.id === second).code, 'OUD-2');
    // Een omgezet artikel is niet nog een keer om te zetten.
    const again = await kees.post('/app/api/stock/code-conversion/apply', { rows: [{ id: first, subGroupId: kind.id, diameter: '20', thread: '3/4"' }] });
    assert.strictEqual(again.body.results[0].status, 'al_omgezet');
    assert.strictEqual((await kees.get('/app/api/stock/code-conversion')).body.converted, 1);

    assert.strictEqual((await kees.post('/app/api/stock/code-conversion/apply', { rows: [] })).status, 400);
    assert.strictEqual((await klant.get('/app/api/stock/code-conversion')).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/code-conversion/apply', { rows: [{ id: first }] })).status, 403);
  } finally {
    server.close();
  }
});
