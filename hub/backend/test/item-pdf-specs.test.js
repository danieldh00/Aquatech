// Specificaties uit PDF's van de leverancier: controle van bron en zin per kenmerk, de AI-aanroep met de PDF als bijlage,
// de route (kenmerken worden specificaties, eigen specificaties blijven staan, eerder opgezochte kenmerken blijven bewaard) en rechten.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { validatePdfFeatures } = require('../src/artikelen/related-compat');
const { createSpecResearcher } = require('../src/artikelen/related-research');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

test('validatePdfFeatures: alleen een aangeleverd bestand, een bronzin en getallen uit die zin', () => {
  const allowed = new Set(['fiche.pdf']);
  const kept = validatePdfFeatures([
    { name: 'Werkdruk', value: '2,5 bar', source: 'fiche.pdf', quote: 'Werkdruk: 2.5 bar' },
    { name: 'Materiaal', value: 'Messing', source: 'fiche.pdf', quote: 'Materiaal messing' },
    { name: 'Gewicht', value: '300 g', source: 'fiche.pdf', quote: 'Gewicht 250 g' },
    { name: 'Kleur', value: 'Zwart', source: 'andere.pdf', quote: 'Kleur zwart' },
    { name: 'Materiaal', value: 'Koper', source: 'fiche.pdf', quote: 'Materiaal koper' },
    { name: 'Zonder zin', value: 'x', source: 'fiche.pdf', quote: '' },
  ], allowed);
  assert.deepStrictEqual(kept.map((feature) => feature.name), ['Werkdruk', 'Materiaal']);
  assert.deepStrictEqual(validatePdfFeatures('onzin', allowed), []);
});

test('researchPdfFeatures: de PDF gaat als bijlage mee en een kenmerk zonder bron uit de PDF vervalt', async () => {
  const sent = [];
  const client = { messages: { async create(request) {
    sent.push(request);
    return { model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ found: true, features: [
      { name: 'Materiaal', value: 'Messing', source: 'fiche.pdf', quote: 'Materiaal: messing' },
      { name: 'Verzonnen', value: '12 mm', source: 'fiche.pdf', quote: 'geen getal hier' },
    ] }) }] };
  } } };
  const found = await createSpecResearcher({ client }).researchPdfFeatures({ fields: [{ label: 'Naam', value: 'Kraan' }], documents: [{ name: 'fiche.pdf', data: 'JVBERi0=' }] });
  assert.strictEqual(found.status, 'gevonden');
  assert.deepStrictEqual(found.features.map((feature) => feature.name), ['Materiaal']);
  const blocks = sent[0].messages[0].content;
  assert.ok(blocks.some((block) => block.type === 'document' && block.source.media_type === 'application/pdf'));
  assert.strictEqual(sent[0].tools, undefined);
});

/**
 * Wereld met een nep-zoeker die vaste PDF-kenmerken teruggeeft.
 * @returns {Promise<object>} db, main, admin, klant, vreemd en de teller van aanroepen.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const calls = { pdf: 0, names: [] };
  /**
   * Nep-zoeker.
   * @returns {object} De zoeker.
   */
  const createFakeResearcher = () => ({
    available: true, model: 'claude-sonnet-5-5',
    /**
     * Geeft twee kenmerken uit de PDF.
     * @param {{ documents: { name: string }[] }} input De PDF's.
     * @returns {Promise<object>} Kenmerken met model en verbruik.
     */
    async researchPdfFeatures({ documents }) {
      calls.pdf += 1; calls.names = documents.map((document) => document.name);
      return { status: 'gevonden', features: [
        { name: 'Materiaal', value: 'Messing', source: documents[0].name, quote: 'Materiaal: messing' },
        { name: 'Werkdruk', value: '2,5 bar', source: documents[0].name, quote: 'Werkdruk 2.5 bar' },
      ], model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 50 } };
    },
  });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, anthropicApiKey: 'sk-ant-test-test-test-test', createSpecResearcher: createFakeResearcher }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  return { db, main, base, calls, admin: await login('baas'), klant: await login('klant'), vreemd: await login('vreemd', 'ander') };
}

/**
 * Maakt een artikel en uploadt er een PDF bij.
 * @param {object} world De testwereld.
 * @param {string} code Artikelcode.
 * @param {object} [extra] Extra velden voor het artikel.
 * @returns {Promise<object>} Het artikel.
 */
async function articleWithPdf(world, code, extra = {}) {
  const created = await world.admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, brand: 'Merk', onHand: 0, salePrice: 10, ...extra });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText(`Fiche ${code}`, { x: 50, y: 700, size: 12 });
  const response = await fetch(`${world.base}/app/api/stock/items/${created.body.id}/documents`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-bestandsnaam': encodeURIComponent('Fiche.pdf'), cookie: [...world.admin.jar].map(([key, value]) => `${key}=${value}`).join('; ') }, body: Buffer.from(await doc.save()) });
  assert.strictEqual(response.status, 201);
  return created.body;
}

test('PDF-specs: kenmerken worden specificaties, eigen specificaties blijven staan', async () => {
  const world = await setup();
  const item = await articleWithPdf(world, 'PS-1', { specifications: [{ name: 'Materiaal', value: 'Eigen waarde' }] });
  const out = await world.admin.post(`/app/api/stock/items/${item.id}/documents/specs`, {});
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.deepStrictEqual(out.body, { status: 'gevonden', features: 2, added: 1 });
  assert.deepStrictEqual(world.calls.names, ['Fiche.pdf']);
  const stored = JSON.parse(world.db.prepare('SELECT specifications FROM stock_items WHERE tenant_id = ? AND id = ?').get(world.main, item.id).specifications);
  const specs = Object.fromEntries(stored.map((entry) => [entry.name, entry.value]));
  assert.strictEqual(specs.Materiaal, 'Eigen waarde');
  assert.strictEqual(specs.Werkdruk, '2,5 bar');
  const usage = world.db.prepare("SELECT feature FROM ai_usage WHERE tenant_id = ? AND feature = 'kenmerken_pdf'").all(world.main);
  assert.strictEqual(usage.length, 1);
});

test('PDF-specs: eerder opgezochte kenmerken blijven bewaard', async () => {
  const world = await setup();
  const item = await articleWithPdf(world, 'PS-2');
  world.db.prepare('INSERT INTO item_specs (tenant_id, item_id, status, specs, model, checked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(world.main, item.id, 'gevonden', JSON.stringify({ kenmerken: [{ name: 'Gewicht', value: '250 g', url: 'https://x.nl/a', quote: 'Gewicht 250 g' }, { name: 'Materiaal', value: 'Kunststof', url: 'https://x.nl/a', quote: 'Materiaal kunststof' }], kenmerkenAt: '2026-11-01T00:00:00Z' }), '', '2026-11-01T00:00:00Z');
  assert.strictEqual((await world.admin.post(`/app/api/stock/items/${item.id}/documents/specs`, {})).status, 200);
  const saved = JSON.parse(world.db.prepare('SELECT specs FROM item_specs WHERE tenant_id = ? AND item_id = ?').get(world.main, item.id).specs);
  assert.deepStrictEqual(saved.kenmerken.map((feature) => feature.name).sort(), ['Gewicht', 'Materiaal', 'Werkdruk']);
  assert.strictEqual(saved.kenmerken.find((feature) => feature.name === 'Materiaal').value, 'Messing');
});

test('PDF-specs: zonder PDF 409, onbekend artikel 404, rechten en andere organisatie', async () => {
  const world = await setup();
  const bare = (await world.admin.post('/app/api/stock/items', { code: 'PS-3', name: 'Zonder PDF', onHand: 0, salePrice: 1 })).body;
  assert.strictEqual((await world.admin.post(`/app/api/stock/items/${bare.id}/documents/specs`, {})).status, 409);
  assert.strictEqual((await world.admin.post('/app/api/stock/items/00000000-0000-0000-0000-000000000000/documents/specs', {})).status, 404);
  const item = await articleWithPdf(world, 'PS-4');
  assert.strictEqual((await world.klant.post(`/app/api/stock/items/${item.id}/documents/specs`, {})).status, 403);
  assert.strictEqual((await world.vreemd.post(`/app/api/stock/items/${item.id}/documents/specs`, {})).status, 404);
  assert.strictEqual(world.calls.pdf, 0);
});
