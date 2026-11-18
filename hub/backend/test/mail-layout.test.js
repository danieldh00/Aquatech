// Mail-opmaak (platform/mail-layout.js): opschonen van de instelling, invullen van teksten met invulvelden (ook met kwaadaardige
// invoer), de e-mailveilige HTML, het ingebedde logo in de mailer en de routes in Beheer (rechten, scheiding tussen organisaties,
// voorbeeld, testmail) plus de koppeling met een echte mail (inkooporder).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const zlib = require('zlib');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { inlineImages } = require('../src/platform/mailer');
const {
  DEFAULTS, TYPES, sanitizeMailLayout, layoutProblem, composeMail, renderMail, fillParagraphs, PLAIN_STYLE,
} = require('../src/platform/mail-layout');
const { createPdokFake } = require('./helpers/pdok-fake');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'm'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Een kleine, geldige PNG in één kleur.
 * @returns {Buffer} Het PNG-bestand.
 */
function makePng() {
  /**
   * Eén PNG-blok.
   * @param {string} type De soort.
   * @param {Buffer} data De inhoud.
   * @returns {Buffer} Het blok.
   */
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((8 * 4 + 1) * 4, 0x80);
  for (let row = 0; row < 4; row++) rows[row * 33] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const LOGO = `data:image/png;base64,${makePng().toString('base64')}`;

test('standaard: leeg of onzin wordt de standaardinstelling', () => {
  assert.deepStrictEqual(sanitizeMailLayout(undefined), DEFAULTS);
  assert.deepStrictEqual(sanitizeMailLayout('x'), DEFAULTS);
  assert.deepStrictEqual(sanitizeMailLayout({ logoMode: 'raar', headerStyle: 'x', templates: [] }), DEFAULTS);
});

test('opschonen: kleuren, hoogte, voettekst en eigen logo', () => {
  const clean = sanitizeMailLayout({ headerColor: '#ffff99', buttonColor: '#19924f', accentColor: '#ffff99', logoHeight: 500, footerText: 'a\r\nb\u0000c', logoMode: 'custom', logo: 'geen-png' });
  assert.strictEqual(clean.headerColor, '', 'een te lichte kopkleur valt weg');
  assert.strictEqual(clean.buttonColor, '#19924f');
  assert.strictEqual(clean.accentColor, '#ffff99', 'een accentkleur hoeft geen contrast met wit');
  assert.strictEqual(clean.logoHeight, 80);
  assert.ok(!/[\u0000\r]/.test(clean.footerText));
  assert.strictEqual(clean.logoMode, 'document', 'eigen logo zonder geldig logo valt terug');
  assert.strictEqual(sanitizeMailLayout({ logoMode: 'custom', logo: LOGO }).logoMode, 'custom');
});

test('teksten: alleen afwijkingen blijven, onbekende velden en ontbrekende verplichte velden worden geweigerd', () => {
  const standard = TYPES.find((type) => type.key === 'account_wachtwoord');
  assert.deepStrictEqual(sanitizeMailLayout({ templates: { account_wachtwoord: { subject: standard.subject, body: standard.body } } }).templates, {});
  assert.deepStrictEqual(sanitizeMailLayout({ templates: { account_wachtwoord: { subject: 'Nieuw', body: 'Hallo {klant}\n\n{link}' } } }).templates, { account_wachtwoord: { subject: 'Nieuw', body: 'Hallo {klant}\n\n{link}' } });
  assert.deepStrictEqual(sanitizeMailLayout({ templates: { account_wachtwoord: { body: 'Hallo {klant}' } } }).templates, {}, 'zonder {link} geldt de standaard');
  assert.deepStrictEqual(sanitizeMailLayout({ templates: { account_wachtwoord: { body: '{link} {geheim}' } } }).templates, {});
  assert.deepStrictEqual(sanitizeMailLayout({ templates: { bestaat_niet: { body: 'x' } } }).templates, {});
  assert.match(layoutProblem({ templates: { account_wachtwoord: { body: 'Hallo {klant}' } } }), /\{link\}/);
  assert.match(layoutProblem({ templates: { account_wachtwoord: { body: '{link} {geheim}' } } }), /onbekend invulveld \{geheim\}/);
  assert.match(layoutProblem({ templates: { order_betaald: { subject: 'x'.repeat(201) } } }), /te lang/);
  assert.match(layoutProblem({ headerColor: '#eeeeee' }), /te licht/);
  assert.match(layoutProblem({ headerColor: 'rood' }), /#rrggbb/);
  assert.strictEqual(layoutProblem({}), '');
});

test('invullen: velden, lege alinea vervalt, onderwerp zonder regeleinden en begrensd', () => {
  const mail = composeMail(DEFAULTS, 'klaar_ophalen', { klant: 'Piet', nummer: 'W1', ophaaladres: '', bestelling: 'Bestelling W1', bestellink: '', backorder: '' });
  assert.strictEqual(mail.subject, 'Je bestelling W1 staat klaar');
  assert.ok(!mail.paragraphs.some((paragraph) => paragraph.includes('Ophaaladres')), 'zonder adres geen kop Ophaaladres');
  assert.ok(!mail.paragraphs.some((paragraph) => paragraph.includes('{')), 'geen letterlijke velden');
  const withAddress = composeMail(DEFAULTS, 'klaar_ophalen', { klant: 'Piet', nummer: 'W1', ophaaladres: 'Straat 1' });
  assert.ok(withAddress.paragraphs.includes('Ophaaladres:\nStraat 1'));
  const hostile = composeMail({ templates: { order_rekening: { subject: 'Order {nummer}', body: 'Dag {klant}' } } }, 'order_rekening', { nummer: 'A\r\nBcc: x@y.nl', klant: '<b>x</b>' });
  assert.ok(!/[\r\n]/.test(hostile.subject));
  assert.strictEqual(hostile.paragraphs[0], 'Dag <b>x</b>', 'tekst blijft tekst; escaping gebeurt bij het tekenen');
  assert.throws(() => composeMail(DEFAULTS, 'bestaat_niet'), /Onbekend mailtype/);
  assert.deepStrictEqual(fillParagraphs('Een {a}\n\n{b}', { a: '1', b: '' }), ['Een 1']);
});

test('elke standaardtekst is geldig en vult zich zonder letterlijke velden', () => {
  for (const type of TYPES) {
    assert.strictEqual(layoutProblem({ templates: { [type.key]: { subject: type.subject, body: type.body } } }), '', type.key);
    const values = Object.fromEntries(type.fields.map((name) => [name, `waarde-${name}`]));
    const mail = composeMail(DEFAULTS, type.key, values);
    assert.ok(mail.subject && !mail.subject.includes('{'), type.key);
    assert.ok(mail.paragraphs.length && mail.paragraphs.every((paragraph) => !paragraph.includes('{')), type.key);
  }
});

test('HTML: tabellen en inline styles, escaping, knop, logo en voet', () => {
  const profile = { companyName: 'Tuin <script>', phone: '06', email: 'a@b.nl', website: 'x.nl' };
  const plain = renderMail(profile, ['Hallo <img src=x onerror=1>', 'Regel\ntwee'], { label: 'Klik', href: 'https://x.nl/a?b=1&c="2"' });
  assert.ok(!plain.html.includes('<script>') && !plain.html.includes('<img src=x'), 'invoer is geëscaped');
  assert.ok(plain.html.includes('href="https://x.nl/a?b=1&amp;c=&quot;2&quot;"'));
  assert.ok(plain.html.includes('bgcolor="#19924f"') && plain.html.includes('#172f5e'));
  assert.ok(!plain.html.includes('data:image'), 'zonder opmaak geen logo');
  assert.ok(plain.text.includes('Klik: https://x.nl/a?b=1&c="2"'));
  assert.strictEqual(renderMail(profile, ['x'], { label: 'Gevaar', href: 'javascript:alert(1)' }).html.includes('javascript:'), false);
  const styled = renderMail(profile, ['x'], null, { ...PLAIN_STYLE, headerStyle: 'plain', headerColor: '#112233', accentColor: '#445566', logo: { dataUri: LOGO, width: 80, height: 40 }, logoPosition: 'center', footerText: 'Open ma-vr\nBel ons', showCompanyInFooter: false });
  assert.ok(styled.html.includes(`src="${LOGO}"`) && styled.html.includes('alt="Tuin &lt;script&gt;"') && styled.html.includes('width="80"'));
  assert.ok(styled.html.includes('align="center"') && styled.html.includes('border-bottom:3px solid #445566'));
  assert.ok(styled.html.includes('Open ma-vr<br>Bel ons') && !styled.html.includes('06'), 'zonder bedrijfsgegevens staat alleen de eigen voettekst');
  assert.ok(styled.text.endsWith('Open ma-vr\nBel ons'));
});

test('mailer: het ingebedde logo gaat als cid-bijlage mee (hoogstens twee afbeeldingen)', () => {
  const html = `<img src="${LOGO}"><img src="${LOGO}">`;
  const result = inlineImages(html);
  assert.strictEqual(result.attachments.length, 1, 'hetzelfde logo twee keer = één bijlage');
  assert.ok(result.html.includes('src="cid:afbeelding1@aquatech"') && !result.html.includes('data:image'));
  assert.deepStrictEqual(inlineImages('<p>geen plaatje</p>').attachments, []);
  assert.strictEqual(inlineImages(undefined).html, undefined);
});

/**
 * Hoofdtenant met beheerder (met e-mailadres), installateur en een tweede organisatie, plus een nagebootste mailserver.
 * @returns {Promise<object>} server, as (inloggen), sent en db.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const sent = [];
  const state = { configured: true };
  /**
   * De nagebootste mailserver.
   * @returns {{ configured: Function, send: Function }} De mailserver.
   */
  const mailerFor = () => ({ configured: () => state.configured, send: async (message) => { sent.push(message); } });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, mailerFor }));
  servers.push(server);
  return { db, server, sent, state, as: createLogin(base, { password: PW }) };
}

test('routes: rechten, opslaan, weigeren en voorbeeld', async () => {
  const { as } = await setup();
  const admin = await as('baas');
  const installer = await as('kees');
  const url = '/app/api/admin/mail-layout';
  assert.strictEqual((await installer.get(url)).status, 403);
  assert.strictEqual((await installer.put(url, { layout: {} })).status, 403);
  const first = await admin.get(url);
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.body.layout, DEFAULTS);
  assert.ok(first.body.types.some((type) => type.key === 'order_betaald'));
  assert.ok(first.body.effective.headerColor);
  const bad = await admin.put(url, { layout: { templates: { account_wachtwoord: { body: 'zonder link' } } } });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.message, /\{link\}/);
  assert.strictEqual((await admin.put(url, {})).status, 400);
  const saved = await admin.put(url, { layout: { headerColor: '#112233', footerText: 'Onze voet', logoMode: 'custom', logo: LOGO, templates: { order_rekening: { subject: 'Dank voor {nummer}', body: 'Dag {klant}\n\n{bestelling}' } } } });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.layout.footerText, 'Onze voet');
  assert.strictEqual(saved.body.layout.templates.order_rekening.subject, 'Dank voor {nummer}');
  const preview = await admin.post(`${url}/preview`, { layout: saved.body.layout, type: 'order_rekening' });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.subject, 'Dank voor W2026-0042');
  assert.ok(preview.body.html.includes('#112233') && preview.body.html.includes('Onze voet') && preview.body.html.includes('data:image/png'));
  assert.strictEqual((await admin.post(`${url}/preview`, { layout: {}, type: 'bestaat_niet' })).status, 400);
  assert.strictEqual((await installer.post(`${url}/preview`, { layout: {}, type: 'order_rekening' })).status, 403);
  const settings = await admin.get('/app/api/admin/settings');
  assert.ok(!JSON.stringify(settings.body).includes('mailLayout'), 'niet via het algemene instellingenscherm');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { mailLayout: { footerText: 'omweg' } })).status >= 400, true);
  assert.strictEqual((await admin.get(url)).body.layout.footerText, 'Onze voet');
});

test('testmail: naar het eigen adres, met voorbeeldopmaak; geen mailserver of adres geeft een duidelijke melding', async () => {
  const { as, sent, state } = await setup();
  const admin = await as('baas');
  const url = '/app/api/admin/mail-layout/test';
  const noAddress = await admin.post(url, { layout: {}, type: 'verzonden' });
  assert.strictEqual(noAddress.status, 409);
  assert.strictEqual(noAddress.body.error, 'no_email');
  assert.strictEqual((await admin.put('/app/api/account/profile', { email: 'baas@voorbeeld.nl' })).status, 200);
  const ok = await admin.post(url, { layout: { footerText: 'Testvoet' }, type: 'verzonden' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.to, 'baas@voorbeeld.nl');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual([sent[0].to, sent[0].subject], ['baas@voorbeeld.nl', 'Test: Je bestelling W2026-0042 is onderweg']);
  assert.ok(sent[0].html.includes('Testvoet') && sent[0].text.includes('Testvoet'));
  assert.strictEqual((await admin.post(url, { layout: { templates: { account_wachtwoord: { body: 'x' } } }, type: 'verzonden' })).status, 400);
  state.configured = false;
  const none = await admin.post(url, { layout: {}, type: 'verzonden' });
  assert.strictEqual(none.status, 409);
  assert.strictEqual(sent.length, 1);
  const installer = await as('kees');
  assert.strictEqual((await installer.post(url, { layout: {}, type: 'verzonden' })).status, 403);
});

test('inkooporder: eigen tekst en opmaak komen in het concept en in de verstuurde mail', async () => {
  const { as, sent } = await setup();
  const admin = await as('baas');
  await admin.put('/app/api/admin/mail-layout', { layout: { headerColor: '#223344', footerText: 'Groeten uit Nunspeet', templates: { inkooporder: { subject: 'Order {nummer} – {bedrijf}', body: 'Dag {contact},\n\nOrder {nummer}{referentie} staat klaar.' } } } });
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Tuintechniek', email: 'orders@tuintechniek.nl', contactName: 'Jan' })).body;
  const item = (await admin.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp', costPrice: 2 })).body;
  const order = (await admin.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: item.id, qty: 5, unitCost: 2 }] })).body;
  await admin.post(`/app/api/purchase-orders/${order.id}/place`);
  const draft = (await admin.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).body;
  assert.match(draft.subject, /^Order IO\d{4}-\d+ – /);
  assert.ok(draft.message.startsWith('Dag Jan,'));
  const result = await admin.post(`/app/api/purchase-orders/${order.id}/send`, {});
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].html.includes('#223344') && sent[0].html.includes('Groeten uit Nunspeet'));
  assert.ok(sent[0].text.includes('Groeten uit Nunspeet'));
});
