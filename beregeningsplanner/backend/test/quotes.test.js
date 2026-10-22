// Offertes: rekenkern (regels uit een plan, korting, btw) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { signaturePng } = require('../src/platform/test-data');
const Core = require('../../frontend/offertes/quote-core.js');
const { createClient, createLogin, listen } = require('./helpers/http-client');

// Plannerbibliotheken in een sandbox, zoals de offertemodule ze laadt.
const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox);
const lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };

/**
 * Een tuin met gazon, border, zes rotators en een druppelslang.
 * @returns {object} De plangegevens.
 */
const garden = () => ({
  meta: { name: 'Tuin Jansen', customer: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet' },
  settings: { level: 'expert', pressure: 3.5, flow: 2 },
  areas: [
    { id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }] },
    { id: 'a2', type: 'bed', pts: [{ x: 0, y: 9 }, { x: 12, y: 9 }, { x: 12, y: 10.5 }, { x: 0, y: 10.5 }] },
  ],
  sprinklers: [
    { id: 's1', type: 'rotator', x: 0, y: 0, r: 6, arc: 90, start: 0 },
    { id: 's2', type: 'rotator', x: 12, y: 0, r: 6, arc: 90, start: 90 },
    { id: 's3', type: 'rotator', x: 12, y: 8, r: 6, arc: 90, start: 180 },
    { id: 's4', type: 'rotator', x: 0, y: 8, r: 6, arc: 90, start: 270 },
    { id: 's5', type: 'rotator', x: 6, y: 0, r: 6, arc: 180, start: 0 },
    { id: 's6', type: 'rotator', x: 6, y: 8, r: 6, arc: 180, start: 180 },
  ],
  zones: [],
  elements: [
    { id: 'e1', kind: 'source', x: -2, y: 4 },
    { id: 'e2', kind: 'valvebox', x: -1, y: 5 },
    { id: 'e3', kind: 'controller', x: -3, y: 6 },
  ],
});

test('offerteregels uit een plan: materiaal uit de stuklijst plus arbeid', () => {
  // JSON: de regels komen deels uit de sandbox (ander realm).
  const { lines, summary } = JSON.parse(JSON.stringify(Core.fromPlan(garden(), lib, { hourlyRate: 60, markupPct: 10, vatRate: 21, callOutFee: 35 })));
  const materialLines = lines.filter((line) => line.section === 'materiaal');
  const laborLines = lines.filter((line) => line.section === 'arbeid');
  assert.ok(materialLines.length > 5, 'materialen overgenomen');
  const popup = materialLines.find((line) => line.code === 'ROT-POP10-PRS');
  assert.strictEqual(popup.qty, 6);
  assert.strictEqual(popup.price, Core.round2(lib.Catalog.articles['ROT-POP10-PRS'].price * 1.1), '10% opslag');
  assert.ok(materialLines.some((line) => line.code === 'DRIP-16'), 'druppelslang voor de border');
  assert.ok(laborLines.length >= 5);
  assert.ok(laborLines.every((line) => line.unit === 'uur' && line.price === 60 && line.qty > 0 && (line.qty * 4) % 1 === 0), 'hele kwartieren tegen het uurtarief');
  assert.ok(laborLines.find((line) => /Sproeiers plaatsen/.test(line.description)).qty === Core.round2(Math.ceil(6 * Core.LABOR.sprinkler * 4) / 4));
  assert.deepStrictEqual(lines.filter((line) => line.section === 'overig').map((line) => [line.description, line.price]), [['Voorrijkosten', 35]]);
  assert.strictEqual(summary.sprinklers, 6);
  assert.strictEqual(summary.lawnM2, 96);
  assert.ok(summary.zones >= 2);
  assert.strictEqual(summary.level, 'Standaard');
});

test('leeg plan: geen materialen, wel een waarschuwing', () => {
  const { lines, warnings } = Core.fromPlan({ areas: [], sprinklers: [] }, lib, {});
  assert.strictEqual(lines.length, 0);
  assert.match(warnings[0], /geen sproeiers/);
});

test('totalen: korting naar rato over de btw-tarieven', () => {
  const totals = Core.totals({
    discountPct: 10,
    lines: [
      { section: 'materiaal', qty: 2, price: 50, vat: 21 },
      { section: 'arbeid', qty: 4, price: 25, vat: 9 },
      { section: 'overig', qty: 1, price: 0.333, vat: 0 },
    ],
  });
  assert.strictEqual(totals.subtotal, 200.33);
  assert.strictEqual(totals.discount, 20.03);
  assert.strictEqual(totals.net, 180.3);
  assert.deepStrictEqual(totals.vat.map((vat) => [vat.rate, vat.base, vat.amount]), [[21, 90, 18.9], [9, 90, 8.1], [0, 0.3, 0]]);
  assert.strictEqual(totals.total, 207.3);
  assert.deepStrictEqual(totals.bySection, { materiaal: 100, arbeid: 100, overig: 0.33 });
});

test('opties: een niet gekozen optie telt niet mee; de klant kiest', () => {
  const data = Core.sanitize({ lines: [
    { id: 'a', section: 'materiaal', qty: 1, price: 100, vat: 21 },
    { id: 'b', section: 'materiaal', qty: 1, price: 50, vat: 21, optional: true },
    { id: 'c', section: 'arbeid', qty: 1, price: 30, vat: 21, optional: true, selected: true },
  ] });
  assert.deepStrictEqual(data.lines.map((line) => [line.optional, line.selected]), [[false, false], [true, false], [true, true]]);
  assert.strictEqual(Core.totals(data).subtotal, 130);
  const chosen = Core.chooseOptions(data, ['b', 'a']);
  assert.strictEqual(Core.totals(chosen).subtotal, 150, 'b aan, c uit; een vaste regel blijft');
  assert.strictEqual(Core.sanitizeLine({ selected: true }).selected, false, 'alleen een optie kan gekozen zijn');
});

test('opschonen: onbekende tarieven, te lange teksten en rommel', () => {
  const sanitized = Core.sanitize({ title: 'x'.repeat(500), discountPct: 400, lines: [{ section: 'hack', qty: 'abc', price: '12.5', vat: 7, description: '<b>' }], customer: 'nee' });
  assert.strictEqual(sanitized.title.length, 200);
  assert.strictEqual(sanitized.discountPct, 100);
  assert.deepStrictEqual([sanitized.lines[0].section, sanitized.lines[0].qty, sanitized.lines[0].price, sanitized.lines[0].vat], ['overig', 0, 12.5, 21]);
  assert.strictEqual(sanitized.customer.name, '');
  assert.match(sanitized.validUntil, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);
// Een echte (kleine) PNG als handtekening.
const SIGNATURE = signaturePng();

/**
 * Tenant met beheerder, gebruiker, installateur en twee klanten, plus een testserver.
 * @param {{ mailerFor?: Function }} [options] mailerFor: eigen mailer (zonder = standaard).
 * @returns {Promise<object>} server, base, as (inloggen), store, tid en db.
 */
async function setup({ mailerFor } = {}) {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'piet', displayName: 'Piet', role: 'gebruiker', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'mien', displayName: 'Mien', role: 'klant', password: 'Tuin-Plan-2026!' });
  const { server, base } = await listen(createApp({ secret: SECRET, db, ...(mailerFor ? { mailerFor } : {}) }));
  const as = createLogin(base, { password: 'Tuin-Plan-2026!' });
  return { server, base, as, store, tid, db };
}

test('API: offertes aanmaken, nummeren, afschermen en verwijderen', async () => {
  const { server, base, as } = await setup();
  try {
    assert.strictEqual((await createClient(base).post('/api/quotes', { data: {} })).status, 401);
    const piet = await as('piet'), kees = await as('kees'), baas = await as('baas');
    const year = new Date().getFullYear();
    const data = { title: 'Beregening tuin', date: `${year}-03-01`, customer: { name: 'Fam. Jansen' }, planId: 'plan-1',
      lines: [{ section: 'materiaal', description: 'Sproeier', qty: 4, price: 10, vat: 21 }, { section: 'arbeid', description: 'Montage', qty: 2, price: 50, vat: 21 }] };
    const first = await piet.post('/api/quotes', { data });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.number, `OF-${year}-0001`);
    assert.strictEqual(first.body.status, 'concept');
    assert.strictEqual(first.body.totalExcl, 140);
    assert.strictEqual(first.body.totalIncl, 169.4);
    assert.strictEqual(first.body.customer, 'Fam. Jansen');
    const second = await kees.post('/api/quotes', { data: { date: `${year}-03-02` } });
    assert.strictEqual(second.body.number, `OF-${year}-0002`, 'oplopend per tenant');
    assert.strictEqual(second.body.title, 'Offerte');

    assert.deepStrictEqual((await piet.get('/api/quotes')).body.items.map((quote) => quote.id), [first.body.id]);
    // Installateurs werken samen: ze zien en bewerken elkaars offertes.
    assert.strictEqual((await kees.get(`/api/quotes/${first.body.id}`)).status, 200);
    assert.strictEqual((await kees.get('/api/quotes?all=1')).body.items.length, 2);
    assert.strictEqual((await baas.get('/api/quotes?all=1')).body.items.length, 2);
    // Een klant maakt geen offertes en ziet geen concepten.
    const klaas = await as('klaas');
    assert.strictEqual((await klaas.post('/api/quotes', { data })).status, 403);
    assert.strictEqual((await klaas.get(`/api/quotes/${first.body.id}`)).status, 404);
    assert.strictEqual((await klaas.put(`/api/quotes/${first.body.id}`, { status: 'akkoord' })).status, 403);
    assert.deepStrictEqual((await klaas.get('/api/quotes?all=1')).body.items, []);
    assert.strictEqual((await piet.get('/api/quotes?plan=plan-1')).body.items.length, 1);

    const upd = await piet.put(`/api/quotes/${first.body.id}`, { status: 'verzonden', data: { ...data, discountPct: 10 } });
    assert.strictEqual(upd.body.status, 'verzonden');
    assert.strictEqual(upd.body.totalExcl, 126);
    assert.strictEqual(upd.body.number, first.body.number, 'nummer blijft');
    assert.strictEqual((await piet.put(`/api/quotes/${first.body.id}`, { status: 'weg' })).status, 400);

    assert.strictEqual((await piet.del(`/api/quotes/${first.body.id}`)).status, 200);
    assert.strictEqual((await piet.get(`/api/quotes/${first.body.id}`)).status, 404);
    const third = await piet.post('/api/quotes', { data: { date: `${year}-04-01` } });
    assert.strictEqual(third.body.number, `OF-${year}-0003`, 'een nummer komt nooit terug');

    assert.strictEqual((await piet.del(`/api/admin/quotes/${third.body.id}`)).status, 403, 'definitief wissen alleen door beheerders');
    assert.strictEqual((await baas.del(`/api/admin/quotes/${third.body.id}`)).status, 200);
  } finally {
    server.close();
  }
});

test('API: klant ziet alleen verzonden offertes voor zijn account en kan akkoord geven', async () => {
  const { server, as } = await setup();
  try {
    const piet = await as('piet'), klaas = await as('klaas'), mien = await as('mien'), baas = await as('baas');
    const custs = (await piet.get('/api/quote-customers')).body.items;
    assert.deepStrictEqual(custs.map((customer) => customer.displayName), ['Klaas', 'Mien']);
    assert.strictEqual((await klaas.get('/api/quote-customers')).status, 403);
    const klaasId = custs.find((customer) => customer.displayName === 'Klaas').id;
    const pietId = (await piet.get('/api/me')).body.user.id;
    assert.strictEqual((await piet.post('/api/quotes', { data: {}, customerId: pietId })).status, 400, 'alleen klantaccounts');

    const year = new Date().getFullYear();
    const data = { title: 'Beregening', date: `${year}-01-01`, validUntil: `${year + 1}-01-01`, layout: 'totaal',
      lines: [{ section: 'materiaal', description: 'Sproeier', qty: 4, price: 10, vat: 21 }] };
    const quote = (await piet.post('/api/quotes', { data, customerId: klaasId })).body;
    assert.strictEqual(quote.customerId, klaasId);
    assert.deepStrictEqual((await klaas.get('/api/quotes')).body.items, [], 'concept blijft intern');

    await piet.put(`/api/quotes/${quote.id}`, { status: 'verzonden' });
    const list = (await klaas.get('/api/quotes')).body.items;
    assert.deepStrictEqual(list.map((x) => x.id), [quote.id]);
    const seen = (await klaas.get(`/api/quotes/${quote.id}`)).body;
    assert.strictEqual(seen.totals.total, 48.4);
    assert.strictEqual(seen.data.lines[0].price, undefined, 'geen regelprijzen bij totaal per onderdeel');
    assert.deepStrictEqual((await mien.get('/api/quotes')).body.items, [], 'andere klant ziet niets');
    assert.strictEqual((await mien.get(`/api/quotes/${quote.id}`)).status, 404);
    assert.strictEqual((await mien.post(`/api/quotes/${quote.id}/respond`, { answer: 'akkoord' })).status, 404);
    assert.strictEqual((await klaas.del(`/api/quotes/${quote.id}`)).status, 403);

    assert.strictEqual((await klaas.post(`/api/quotes/${quote.id}/respond`, { answer: 'misschien' })).status, 400);
    assert.strictEqual((await klaas.post(`/api/quotes/${quote.id}/respond`, { answer: 'akkoord' })).status, 400, 'naam, handtekening en voorwaarden nodig');
    const ok = await klaas.post(`/api/quotes/${quote.id}/respond`, { answer: 'akkoord', name: 'Klaas Jansen', terms: true, signature: SIGNATURE });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.status, 'akkoord');
    assert.strictEqual((await klaas.post(`/api/quotes/${quote.id}/respond`, { answer: 'afgewezen' })).status, 409, 'maar één keer');
    assert.strictEqual((await piet.get(`/api/quotes/${quote.id}`)).body.status, 'akkoord');
    const audit = (await baas.get('/api/admin/audit')).body.items;
    assert.ok(audit.some((entry) => entry.action === 'offerte_akkoord'));

    // Verlopen: geen akkoord meer mogelijk.
    const old = (await piet.post('/api/quotes', { data: { ...data, validUntil: '2020-01-01' }, customerId: klaasId, status: 'verzonden' })).body;
    assert.strictEqual((await klaas.post(`/api/quotes/${old.id}/respond`, { answer: 'akkoord', name: 'Klaas', terms: true, signature: SIGNATURE })).status, 409);
    // Ontkoppelen: de klant ziet de offerte niet meer.
    await piet.put(`/api/quotes/${old.id}`, { customerId: null });
    assert.strictEqual((await klaas.get(`/api/quotes/${old.id}`)).status, 404);
  } finally {
    server.close();
  }
});

test('API: bedrijfsprofiel lezen voor iedereen, wijzigen alleen door beheerders', async () => {
  const { server, as } = await setup();
  try {
    const piet = await as('piet'), baas = await as('baas');
    const profile = (await piet.get('/api/quote-profile')).body;
    assert.strictEqual(profile.canEdit, false);
    assert.strictEqual(profile.profile.hourlyRate, 55);
    assert.strictEqual(profile.profile.companyName, 'AquaTech Service');
    assert.strictEqual((await piet.put('/api/quote-profile', { profile: { hourlyRate: 1 } })).status, 403);
    const response = await baas.put('/api/quote-profile', { profile: { hourlyRate: 62.5, vatRate: 7, numberPrefix: 'AQ-', kvk: '12345678', evil: 'x' } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.profile.hourlyRate, 62.5);
    assert.strictEqual(response.body.profile.vatRate, 21, 'alleen 0, 9 of 21%');
    assert.strictEqual(response.body.profile.evil, undefined);
    assert.strictEqual((await piet.get('/api/quote-profile')).body.profile.kvk, '12345678');
    const quote = await piet.post('/api/quotes', { data: {} });
    assert.match(quote.body.number, /^AQ-\d{4}-0001$/);
    // Ook zichtbaar in Beheer > Instellingen.
    assert.strictEqual((await baas.get('/api/admin/settings')).body.settings.quoteProfile.value.numberPrefix, 'AQ-');
  } finally {
    server.close();
  }
});

test('testomgeving leegmaken en verwijderen neemt de offertes mee; offertes zijn per tenant', async () => {
  const { createQuoteStore } = require('../src/verkoop/quotes');
  const db = openDb();
  const store = createStore(db);
  const live = store.ensureTenant();
  const out = await store.createAccount(live.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  const user = out.user || out;
  const env = store.createEnvironment(live.id, { name: 'Test' }).tenant;
  const quotes = createQuoteStore(db);
  const inLive = quotes.create({ ...user, tenant_id: live.id }, { date: '2026-05-01' });
  const inTest = quotes.create({ ...user, tenant_id: env.id }, { date: '2026-05-01' });
  assert.strictEqual(inLive.number, 'OF-2026-0001');
  assert.strictEqual(inTest.number, 'OF-2026-0001', 'eigen nummering per omgeving');
  assert.strictEqual(quotes.get({ ...user, tenant_id: live.id }, inTest.id), null, 'niet zichtbaar in een andere omgeving');
  assert.ok(!store.resetEnvironment(env.id).error);
  assert.strictEqual(quotes.list(env.id).length, 0);
  assert.strictEqual(quotes.list(live.id).length, 1);
  quotes.create({ ...user, tenant_id: env.id }, {});
  assert.ok(store.deleteEnvironment(env.id).ok);
});

test('digitale offerte: link, openbare pagina, opties, tekenen, vastleggen en e-mail', async () => {
  const { createMailer } = require('../src/platform/mailer');
  const sent = [];
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async (message) => { sent.push(message); return {}; } }) });
  const { server, base, as, tid, db } = await setup({ mailerFor });
  try {
    const piet = await as('piet'), baas = await as('baas'), anon = createClient(base);
    /**
     * Verzoek aan de openbare offerte-API met het token in de kop.
     * @param {string} token Token van de offertelink.
     * @param {string} [method] GET (bekijken) of POST (reageren).
     * @param {object} [body] JSON-body.
     * @param {string} [query] Querystring, bijv. ?print=1.
     * @returns {Promise<{ status: number, body: * }>} Status en JSON.
     */
    const publicRequest = async (token, method = 'GET', body, query = '') => {
      const res = await fetch(`${base}/api/public/quote${method === 'POST' ? '/respond' : ''}${query}`, {
        method, headers: { 'X-Offerte-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await baas.put('/api/quote-profile', { profile: { email: 'info@aquatech.test' } });
    const year = new Date().getFullYear();
    const data = { title: 'Beregening', date: `${year}-01-01`, validUntil: `${year + 1}-01-01`, layout: 'totaal', customer: { name: 'Fam. Jansen', email: 'jansen@klant.test' },
      lines: [
        { id: 'r1', section: 'materiaal', description: 'Sproeier', qty: 4, price: 10, vat: 21 },
        { id: 'r2', section: 'arbeid', description: 'Montage', qty: 1, price: 60, vat: 21 },
        { id: 'r3', section: 'materiaal', description: 'Regensensor', qty: 1, price: 50, vat: 21, optional: true },
      ] };
    const quote = (await piet.post('/api/quotes', { data })).body;
    assert.strictEqual(quote.share.active, false);
    const URL_OK = 'https://aquatech.example/pad/openbaar/offerte.html';
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/share`, { url: 'javascript:alert(1)//openbaar/offerte.html' })).status, 400);
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/share`, { url: 'https://evil.example/elders.html' })).status, 400);
    const shared = (await piet.post(`/api/quotes/${quote.id}/share`, { url: URL_OK })).body;
    assert.strictEqual(shared.status, 'verzonden', 'met de link is de offerte verzonden');
    assert.ok(shared.share.url.startsWith(`${URL_OK}#t=`));
    const token = shared.share.url.split('#t=')[1];
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/share`, { url: URL_OK })).body.share.url, shared.share.url, 'link blijft dezelfde');

    // Openbaar: zonder of met een fout token niets.
    assert.strictEqual((await publicRequest('')).status, 404);
    assert.strictEqual((await publicRequest('x'.repeat(32))).status, 404);
    const seen = await publicRequest(token);
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.body.profile.email, 'info@aquatech.test');
    assert.strictEqual(seen.body.quote.share, undefined, 'link en interne gegevens niet naar buiten');
    assert.strictEqual(seen.body.quote.owner, undefined);
    assert.strictEqual(seen.body.quote.data.lines.find((line) => line.id === 'r1').price, undefined, 'totaal per onderdeel: geen regelprijzen');
    assert.strictEqual(seen.body.quote.data.lines.find((line) => line.id === 'r3').price, 50, 'een optie wel');
    assert.deepStrictEqual(seen.body.quote.fixed.map((fixed) => [fixed.section, fixed.amount]).sort(), [['arbeid', 60], ['materiaal', 40]]);
    await publicRequest(token, 'GET', null, '?preview=1');
    let mine = (await piet.get(`/api/quotes/${quote.id}`)).body;
    assert.strictEqual(mine.share.viewCount, 1, 'een voorbeeld telt niet als bekeken');
    assert.ok(mine.share.viewedAt);

    // De openbare pagina en wat die nodig heeft zijn zonder inloggen bereikbaar, de rest niet.
    assert.strictEqual((await fetch(`${base}/openbaar/offerte.html`)).status, 200);
    assert.strictEqual((await fetch(`${base}/offertes/quote-view.js`)).status, 200);
    assert.strictEqual((await fetch(`${base}/offertes/offertes.js`)).status, 401);
    assert.strictEqual((await fetch(`${base}/openbaar/%2e%2e/offertes/offertes.js`)).status, 401);
    assert.strictEqual((await fetch(`${base}/openbaar/offerte.html/..%2f..%2fbeheer/`)).status, 401);

    // Versturen: eerst een mailserver nodig.
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/send`, { to: 'jansen@klant.test', url: URL_OK })).status, 409);
    assert.strictEqual((await piet.put('/api/quote-mail', { config: { host: 'smtp.x' } })).status, 403);
    const mail = await baas.put('/api/quote-mail', { config: { host: 'smtp.aquatech.test', port: 465, secure: true, user: 'offerte', from: 'AquaTech <offerte@aquatech.test>\r\nBcc: x@y.z' }, password: 'geheim-wachtwoord' });
    assert.strictEqual(mail.status, 200);
    assert.strictEqual(mail.body.passwordSet, true);
    assert.ok(!JSON.stringify(mail.body).includes('geheim-wachtwoord'), 'wachtwoord nooit terug');
    assert.ok(!mail.body.config.from.includes('\n'), 'geen kopregels in de afzender');
    assert.strictEqual((await piet.get('/api/quote-profile')).body.mail, true);
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/send`, { to: 'geen-adres', url: URL_OK })).status, 400);
    const out = await piet.post(`/api/quotes/${quote.id}/send`, { to: 'jansen@klant.test', subject: 'Uw offerte', message: 'Beste familie,\n\nHierbij.', url: URL_OK });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.share.sentTo, 'jansen@klant.test');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'jansen@klant.test');
    assert.ok(sent[0].html.includes(shared.share.url.replace(/&/g, '&amp;')) && sent[0].text.includes(shared.share.url), 'link in de e-mail');
    assert.strictEqual(sent[0].bcc, undefined, 'zonder voorkeur geen kopie');
    // Mijn profiel: kopie van verstuurde mail naar het eigen adres.
    assert.strictEqual((await piet.put('/api/account/profile', { email: 'piet@aquatech.test', preferences: { mailCopy: true } })).status, 200);
    assert.strictEqual((await piet.post(`/api/quotes/${quote.id}/send`, { to: 'jansen@klant.test', url: URL_OK })).status, 200);
    assert.strictEqual(sent[1].bcc, 'piet@aquatech.test');
    sent.splice(1);

    // Akkoord via de link: naam, handtekening en voorwaarden verplicht.
    assert.strictEqual((await publicRequest(token, 'POST', { answer: 'akkoord', name: 'J. Jansen', terms: true })).status, 400);
    assert.strictEqual((await publicRequest(token, 'POST', { answer: 'akkoord', name: 'J. Jansen', signature: SIGNATURE })).status, 400);
    assert.strictEqual((await publicRequest(token, 'POST', { answer: 'akkoord', name: 'J', terms: true, signature: SIGNATURE })).status, 400);
    assert.strictEqual((await publicRequest(token, 'POST', { answer: 'akkoord', name: 'J. Jansen', terms: true, signature: 'data:image/png;base64,AAAA' })).status, 400);
    const acc = await publicRequest(token, 'POST', { answer: 'akkoord', name: 'J. Jansen', terms: true, signature: SIGNATURE, options: ['r3', 'r1', 'onbekend'] });
    assert.strictEqual(acc.status, 200);
    assert.strictEqual(acc.body.quote.status, 'akkoord');
    assert.strictEqual(acc.body.quote.acceptance.name, 'J. Jansen');
    assert.strictEqual(acc.body.quote.acceptance.totalIncl, 181.5, 'met de gekozen optie: (40 + 60 + 50) x 1,21');
    assert.strictEqual((await publicRequest(token, 'POST', { answer: 'afgewezen' })).status, 409, 'maar één keer');
    mine = (await piet.get(`/api/quotes/${quote.id}`)).body;
    assert.strictEqual(mine.status, 'akkoord');
    assert.strictEqual(mine.totalIncl, 181.5);
    assert.strictEqual(mine.acceptance.via, 'link');
    assert.ok(mine.acceptance.ip, 'IP-adres vastgelegd');
    assert.strictEqual(mine.acceptance.termsAccepted, true);
    assert.deepStrictEqual(mine.acceptance.options, ['r3']);
    assert.match(mine.acceptance.contentHash, /^[0-9a-f]{64}$/);
    assert.strictEqual(mine.data.lines.find((line) => line.id === 'r3').selected, true);
    // Vast: niet meer te wijzigen.
    const locked = await piet.put(`/api/quotes/${quote.id}`, { data: { ...data, title: 'Anders' } });
    assert.strictEqual(locked.status, 409);
    assert.strictEqual((await piet.put(`/api/quotes/${quote.id}`, { status: 'concept' })).status, 409);
    // Bevestiging naar de klant en bericht naar het bedrijf.
    for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(sent.slice(1).map((message) => message.to).sort(), ['info@aquatech.test', 'jansen@klant.test']);
    assert.match(sent.find((message) => message.to === 'jansen@klant.test' && message !== sent[0]).subject, /Bevestiging/);
    const audit = (await baas.get('/api/admin/audit')).body.items.map((entry) => entry.action);
    for (const action of ['offertelink_gemaakt', 'offerte_verstuurd', 'offerte_akkoord']) assert.ok(audit.includes(action), action);
    // Het geaccordeerde document blijft via de link te zien.
    assert.strictEqual((await publicRequest(token)).body.quote.acceptance.answer, 'akkoord');

    // Afwijzen via de link; intrekken maakt de link onbruikbaar.
    const q2 = (await piet.post('/api/quotes', { data })).body;
    const t2 = (await piet.post(`/api/quotes/${q2.id}/share`, { url: URL_OK })).body.share.url.split('#t=')[1];
    const rej = await publicRequest(t2, 'POST', { answer: 'afgewezen', name: 'J. Jansen', reason: 'Te duur' });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual(rej.body.quote.acceptance.reason, 'Te duur');
    const q3 = (await piet.post('/api/quotes', { data })).body;
    const t3 = (await piet.post(`/api/quotes/${q3.id}/share`, { url: URL_OK })).body.share.url.split('#t=')[1];
    assert.strictEqual((await piet.del(`/api/quotes/${q3.id}/share`)).status, 200);
    assert.strictEqual((await publicRequest(t3)).status, 404, 'ingetrokken link werkt niet meer');
    // Verlopen: geen akkoord.
    const q4 = (await piet.post('/api/quotes', { data: { ...data, validUntil: '2020-01-01' } })).body;
    const t4 = (await piet.post(`/api/quotes/${q4.id}/share`, { url: URL_OK })).body.share.url.split('#t=')[1];
    assert.strictEqual((await publicRequest(t4, 'POST', { answer: 'akkoord', name: 'J. Jansen', terms: true, signature: SIGNATURE })).status, 409);
    // Uitgeschakelde organisatie: de link werkt niet.
    db.prepare('UPDATE tenants SET disabled = 1 WHERE id = ?').run(tid);
    assert.strictEqual((await publicRequest(t4)).status, 404);
    assert.strictEqual((await anon.get('/api/quote-mail')).status, 401);
  } finally {
    server.close();
  }
});

test('offerte uit plan: geen materiaalopslag op regels met een webshopprijs', () => {
  const Catalog = lib.Catalog;
  const original = { ...Catalog.articles['PE-25'] };
  Catalog.articles['PE-25'] = { ...original, price: 2, shop: true, sku: 'PE25', url: 'https://shop.test/pe25' };
  try {
    const { lines } = JSON.parse(JSON.stringify(Core.fromPlan(garden(), lib, { markupPct: 10 })));
    const pe = lines.find((line) => line.code === 'PE-25');
    assert.strictEqual(pe.price, 2, 'webshopprijs zonder opslag');
    const other = lines.find((line) => line.section === 'materiaal' && line.code !== 'PE-25');
    assert.strictEqual(other.price, Core.round2(Catalog.articles[other.code].price * 1.1), 'andere regels met opslag');
  } finally {
    Catalog.articles['PE-25'] = original;
  }
});
