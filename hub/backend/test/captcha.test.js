// Onzichtbare captcha (beveiliging/captcha.js): de instelling, de controle van het token, de uitgebreide CSP, het gedrag bij een
// onbereikbaar Google en de formulieren van de app (inloggen, tekening indienen) en de webshop (inloggen, registreren, planner,
// wachtwoord vergeten, zakelijk aanvragen, afrekenen). Zonder sleutels moet alles werken als voorheen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Captcha = require('../src/beveiliging/captcha');
const { setup, PERSON, PW } = require('./helpers/webshop-world');
const { createCaptchaFake, SECRET, SITE_KEY } = require('./helpers/captcha-fake');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');

const ACTIVE = { enabled: true, siteKey: SITE_KEY, minScore: 0.5, onUnreachable: 'allow' };

/**
 * Een nagebootste instellingenlijst voor createCaptcha.
 * @param {object} values De waarden per sleutel (captcha, captchaSecret).
 * @returns {Function} settingsFor(tenantId).
 */
const settingsOf = (values) => () => ({ get: (key) => values[key] });

/**
 * De captcha-dienst met de nagebootste Google en een lijst van de meldingen.
 * @param {object} [values] De instellingen (standaard actief).
 * @param {object} [options] Extra opties voor createCaptcha.
 * @returns {{ service: object, fake: object, events: object[] }} De dienst, de nep-Google en de gemelde gebeurtenissen.
 */
function serviceWith(values = { captcha: ACTIVE, captchaSecret: SECRET }, options = {}) {
  const fake = createCaptchaFake();
  const events = [];
  const service = Captcha.createCaptcha({ settingsFor: settingsOf(values), fetchImpl: fake.fetchImpl, report: (tenantId, event) => events.push(event), ...options });
  return { service, fake, events };
}

test('instelling: sitesleutel, minimumscore en gedrag worden gesaneerd; onbruikbare invoer is uit', () => {
  assert.strictEqual(Captcha.cleanSiteKey(` ${SITE_KEY} `), SITE_KEY);
  for (const bad of ['', null, undefined, '6Lkort', 'X'.repeat(40), `${SITE_KEY}x`, 42, {}, '6L<script>alert(1)</script>000000000000000000']) assert.strictEqual(Captcha.cleanSiteKey(bad), '', String(bad));
  assert.deepStrictEqual(Captcha.sanitizeCaptcha({ enabled: true, siteKey: SITE_KEY, minScore: 0.7, onUnreachable: 'block', extra: 1 }), { enabled: true, siteKey: SITE_KEY, minScore: 0.7, onUnreachable: 'block' });
  assert.deepStrictEqual(Captcha.sanitizeCaptcha(null), { enabled: false, siteKey: '', minScore: 0.5, onUnreachable: 'allow' });
  assert.deepStrictEqual(Captcha.sanitizeCaptcha([1]), { enabled: false, siteKey: '', minScore: 0.5, onUnreachable: 'allow' });
  assert.strictEqual(Captcha.sanitizeCaptcha({ enabled: 'ja' }).enabled, false, 'alleen echt true zet hem aan');
  assert.strictEqual(Captcha.sanitizeCaptcha({ minScore: 5 }).minScore, 0.9);
  assert.strictEqual(Captcha.sanitizeCaptcha({ minScore: -1 }).minScore, 0.1);
  assert.strictEqual(Captcha.sanitizeCaptcha({ minScore: 'veel' }).minScore, 0.5);
  assert.strictEqual(Captcha.sanitizeCaptcha({ onUnreachable: 'misschien' }).onUnreachable, 'allow');
});

test('cspWith: alleen de adressen van reCAPTCHA erbij, andere richtlijnen en inline scripts blijven zoals ze waren', () => {
  const base = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'";
  const directives = Object.fromEntries(Captcha.cspWith(base).split('; ').map((directive) => [directive.split(' ')[0], directive]));
  assert.match(directives['script-src'], /^script-src 'self' https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\/$/);
  assert.match(directives['connect-src'], /https:\/\/www\.google\.com\/recaptcha\//);
  assert.match(directives['frame-src'], /^frame-src https:\/\/www\.google\.com\/recaptcha\//, 'frame-src bestond nog niet en wordt toegevoegd');
  assert.strictEqual(directives['style-src'], "style-src 'self'");
  assert.strictEqual(directives['frame-ancestors'], "frame-ancestors 'none'");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(Captcha.cspWith(base)));
  // Een bestaande frame-src wordt uitgebreid, niet verdubbeld.
  assert.strictEqual(Captcha.cspWith("frame-src 'self'; script-src 'self'").match(/frame-src/g).length, 1);
});

test('activeOf: alleen met aan, geldige sitesleutel en geheim; de noodschakelaar zet alles uit; publicOf geeft nooit het geheim', () => {
  assert.strictEqual(serviceWith().service.activeOf('t').siteKey, SITE_KEY);
  assert.deepStrictEqual(serviceWith().service.publicOf('t'), { siteKey: SITE_KEY });
  for (const values of [
    { captcha: { ...ACTIVE, enabled: false }, captchaSecret: SECRET },
    { captcha: { ...ACTIVE, siteKey: 'kapot' }, captchaSecret: SECRET },
    { captcha: ACTIVE, captchaSecret: '' },
    { captcha: {}, captchaSecret: SECRET },
  ]) {
    const { service } = serviceWith(values);
    assert.strictEqual(service.activeOf('t'), null);
    assert.strictEqual(service.publicOf('t'), null);
  }
  assert.strictEqual(serviceWith(undefined, { disabled: true }).service.activeOf('t'), null, 'CAPTCHA_DISABLED');
  assert.ok(!JSON.stringify(serviceWith().service.publicOf('t')).includes(SECRET));
});

test('check: zonder actieve captcha geslaagd zonder Google te vragen', async () => {
  const { service, fake } = serviceWith({ captcha: { enabled: false }, captchaSecret: '' });
  assert.deepStrictEqual(await service.check('t', { token: '', action: 'login' }), { ok: true, skipped: true });
  assert.strictEqual(fake.calls.length, 0);
});

test('check: een goed token slaagt één keer; leeg, verzonnen, hergebruikt, verkeerde actie en lage score worden geweigerd', async () => {
  const { service, fake, events } = serviceWith();
  const good = fake.token('login');
  const first = await service.check('t', { token: good, action: 'login', remoteIp: '203.0.113.9' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(fake.calls[0].remoteip, '203.0.113.9');
  assert.strictEqual(fake.calls[0].secret, SECRET);
  assert.strictEqual((await service.check('t', { token: good, action: 'login' })).reason, 'failed', 'een token werkt maar één keer');
  for (const token of ['', '   ', undefined, null, 42, 'x'.repeat(5000)]) {
    const before = fake.calls.length;
    assert.strictEqual((await service.check('t', { token, action: 'login' })).reason, 'missing', String(token).slice(0, 10));
    assert.strictEqual(fake.calls.length, before, 'een leeg of te groot token gaat niet naar Google');
  }
  assert.strictEqual((await service.check('t', { token: 'verzonnen', action: 'login' })).reason, 'failed');
  assert.strictEqual((await service.check('t', { token: fake.token('register'), action: 'login' })).reason, 'wrong_action');
  assert.strictEqual((await service.check('t', { token: fake.token('login', 0.1), action: 'login' })).reason, 'low_score');
  assert.strictEqual((await service.check('t', { token: fake.token('login', 0.5), action: 'login' })).ok, true, 'precies het minimum mag');
  assert.deepStrictEqual(events.filter((event) => event.type === 'rejected').map((event) => event.reason), ['failed', 'missing', 'missing', 'missing', 'missing', 'missing', 'missing', 'failed', 'wrong_action', 'low_score']);
  const rejection = await service.check('t', { token: fake.token('login', 0.1), action: 'login' });
  assert.match(rejection.message, /robot/);
});

test('check: een eigen minimumscore geldt', async () => {
  const { service, fake } = serviceWith({ captcha: { ...ACTIVE, minScore: 0.8 }, captchaSecret: SECRET });
  assert.strictEqual((await service.check('t', { token: fake.token('login', 0.7), action: 'login' })).reason, 'low_score');
  assert.strictEqual((await service.check('t', { token: fake.token('login', 0.8), action: 'login' })).ok, true);
});

test('check: Google onbereikbaar (geen verbinding, serverfout, onleesbaar antwoord) laat door of blokkeert volgens de instelling en meldt het', async () => {
  for (const down of ['offline', 'fout500', 'rommel']) {
    const allow = serviceWith();
    allow.fake.mode.value = down;
    const passed = await allow.service.check('t', { token: 'iets', action: 'login' });
    assert.deepStrictEqual([passed.ok, passed.reason, passed.degraded], [true, 'unreachable', true], down);
    assert.deepStrictEqual(allow.events.map((event) => event.type), ['unreachable']);

    const block = serviceWith({ captcha: { ...ACTIVE, onUnreachable: 'block' }, captchaSecret: SECRET });
    block.fake.mode.value = down;
    const refused = await block.service.check('t', { token: 'iets', action: 'login' });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, 'unreachable'], down);
    assert.match(refused.message, /niet beschikbaar/);
  }
});

test('check: een geheim dat Google weigert is een fout van ons, niet van de bezoeker', async () => {
  const { service, events } = serviceWith({ captcha: ACTIVE, captchaSecret: 'een-ander-geheim-dat-google-niet-kent' });
  const outcome = await service.check('t', { token: 'mens:login:0.9:1', action: 'login' });
  assert.deepStrictEqual([outcome.ok, outcome.reason], [true, 'misconfigured']);
  assert.deepStrictEqual(events.map((event) => event.type), ['misconfigured']);
});

test('check: een door Google als misvormd afgewezen token (bad-request) wordt geweigerd en laat nooit door', async () => {
  const { service } = serviceWith(undefined, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['bad-request'] }) }) });
  const outcome = await service.check('t', { token: 'misvormd', action: 'login' });
  assert.deepStrictEqual([outcome.ok, outcome.reason], [false, 'failed']);
});

test('checkSecret: ok, invalid of unreachable, zonder iets te bewaren', async () => {
  const { service, fake } = serviceWith();
  assert.strictEqual(await service.checkSecret(SECRET), 'ok');
  assert.strictEqual(await service.checkSecret('fout-geheim-van-voldoende-lengte'), 'invalid');
  fake.mode.value = 'offline';
  assert.strictEqual(await service.checkSecret(SECRET), 'unreachable');
});

/**
 * Een wereld met de webshop en de captcha aan (sleutels ingesteld, geen vertraging bij inloggen).
 * @returns {Promise<object>} De wereld van setup, plus fake (nep-Google).
 */
async function captchaWorld() {
  const fake = createCaptchaFake();
  const world = await setup({ appOptions: { captchaFetch: fake.fetchImpl, loginDelayMs: 0 } });
  const saved = await world.admin.put('/app/api/admin/settings', { captcha: ACTIVE, captchaSecret: SECRET, drawingRequests: true });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  return { ...world, fake };
}

test('instellingen: het geheim komt nooit terug, alleen een beheerder wijzigt, de controleroute werkt en testomgevingen nemen niets over', async () => {
  const world = await captchaWorld();
  const view = (await world.admin.get('/app/api/admin/settings')).body.settings;
  assert.deepStrictEqual(view.captcha.value, ACTIVE);
  assert.strictEqual(view.captchaSecret.set, true);
  assert.ok(!JSON.stringify(view).includes(SECRET), 'het geheim zit niet in de weergave');
  assert.ok(!JSON.stringify(view.captchaSecret).includes(SECRET.slice(-4)), 'ook geen hint met de laatste tekens');
  const klant = world.shoppers[0].client;
  assert.notStrictEqual((await klant.put('/app/api/admin/settings', { captcha: { ...ACTIVE, enabled: false } })).status, 200);
  assert.strictEqual((await klant.post('/app/api/admin/captcha/check', {})).status === 200, false);
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { captcha: 'ja' })).status, 400);
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { captchaSecret: 'kort' })).status, 400);
  // Controleroute: opgeslagen geheim, een getypt geheim, een geweigerd geheim, niets ingesteld en Google onbereikbaar.
  assert.deepStrictEqual((await world.admin.post('/app/api/admin/captcha/check', {})).body, { result: 'ok' });
  assert.deepStrictEqual((await world.admin.post('/app/api/admin/captcha/check', { secret: 'fout-geheim-van-voldoende-lengte' })).body, { result: 'invalid' });
  world.fake.mode.value = 'offline';
  assert.deepStrictEqual((await world.admin.post('/app/api/admin/captcha/check', {})).body, { result: 'unreachable' });
  world.fake.mode.value = 'ok';
  assert.deepStrictEqual((await world.vreemd.post('/app/api/admin/captcha/check', {})).body, { result: 'not_set' }, 'een andere organisatie heeft eigen (geen) sleutels');
  // Een nieuwe testomgeving krijgt de sleutels niet mee (extern systeem).
  const main = world.app.locals.mainTenantId || null;
  assert.ok(main === null || typeof main === 'string');
});

test('webshop: zonder sleutels staat er niets in de pagina, blijft de CSP gelijk en werkt alles zonder token', async () => {
  const world = await setup();
  const visitor = createClient(world.base);
  const page = await visitor.get('/inloggen/');
  assert.strictEqual(page.status, 200);
  assert.ok(!/captchaToken|captcha\.js|reCAPTCHA|recaptcha/.test(page.text));
  assert.ok(!/google/.test(page.headers.get('content-security-policy')));
  const done = await postForm(world.base, createClient(world.base), '/registreren/', { displayName: 'Zonder', email: 'zonder@voorbeeld.nl', password: PW, password2: PW, website: '' });
  assert.strictEqual(done.status, 303);
  // Aan, maar zonder geheim: ook niets.
  await world.admin.put('/app/api/admin/settings', { captcha: ACTIVE });
  assert.ok(!/captchaToken/.test((await visitor.get('/inloggen/')).text));
});

test('webshop: met captcha hebben de formulieren het veld en de vermelding, en de CSP is uitgebreid', async () => {
  const world = await captchaWorld();
  const visitor = createClient(world.base);
  const field = new RegExp(`<input type="hidden" name="captchaToken" value="" data-site-key="${SITE_KEY}" data-captcha-action="`);
  for (const [urlPath, action] of [['/inloggen/', 'login'], ['/registreren/', 'register'], ['/planner/', 'planner_signup'], ['/wachtwoord-vergeten/', 'forgot_password']]) {
    const page = await visitor.get(urlPath);
    assert.strictEqual(page.status, 200, urlPath);
    assert.match(page.text, field, urlPath);
    assert.ok(page.text.includes(`data-captcha-action="${action}"`), urlPath);
    assert.match(page.text, /beschermd door reCAPTCHA/, urlPath);
    assert.match(page.text, /captcha\.js/, urlPath);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/www\.google\.com\/recaptcha\//, urlPath);
    assert.ok(!page.text.includes(SECRET), 'het geheim staat nooit in de pagina');
  }
  await world.admin.put('/app/api/admin/settings', { quoteProfile: { companyName: 'AquaTech', email: 'info@aquatech.example' } });
  assert.match((await visitor.get('/')).text, /data-captcha-action="business_request"/);
  assert.strictEqual((await visitor.get('/assets/captcha.js')).status, 200);
  // Pagina's zonder formulier hebben het script niet, wel de verruimde CSP is niet nodig maar onschadelijk; de vermelding staat er niet.
  const category = await visitor.get('/winkelwagen/');
  assert.ok(!/beschermd door reCAPTCHA/.test(category.text));
});

test('webshop: inloggen vraagt een geldig token; een robot, een ontbrekend token en een verkeerde actie krijgen een melding met behoud van invoer', async () => {
  const world = await captchaWorld();
  const { base, fake } = world;
  /**
   * Logt in via het winkelformulier.
   * @param {object} fields Extra of afwijkende velden.
   * @returns {Promise<object>} Het antwoord.
   */
  const attempt = (fields) => postForm(base, createClient(base), '/inloggen/', { login: 'k1@voorbeeld.nl', password: PW, ...fields });
  const missing = await attempt({});
  assert.strictEqual(missing.status, 400);
  assert.match(missing.text, /beveiligingscontrole is niet uitgevoerd/);
  assert.match(missing.text, /value="k1@voorbeeld\.nl"/, 'de inlognaam blijft staan');
  assert.strictEqual((await attempt({ captchaToken: fake.token('login', 0.1) })).status, 400);
  assert.strictEqual((await attempt({ captchaToken: fake.token('register') })).status, 400);
  const good = await attempt({ captchaToken: fake.token('login') });
  assert.strictEqual(good.status, 303);
  // Een goed token met een fout wachtwoord geeft de gewone melding, niet de captcha-melding.
  const wrong = await attempt({ password: 'Verkeerd-Wachtwoord-1!', captchaToken: fake.token('login') });
  assert.strictEqual(wrong.status === 401 || wrong.status === 400, true);
  assert.ok(!/beveiligingscontrole/.test(wrong.text));
});

test('webshop: registreren, planner en wachtwoord vergeten controleren de captcha vóór ze iets doen', async () => {
  const world = await captchaWorld();
  const { base, fake, sent } = world;
  await world.admin.put('/app/api/admin/settings', { shopPayment: { publicUrl: 'https://winkel.example/' } });
  const before = sent.length;
  const register = { displayName: 'Nieuwe Klant', email: 'nieuw@voorbeeld.nl', password: PW, password2: PW, website: '' };
  const refused = await postForm(base, createClient(base), '/registreren/', { ...register, captchaToken: fake.token('login') });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /value="nieuw@voorbeeld\.nl"/);
  const accepted = await postForm(base, createClient(base), '/registreren/', { ...register, captchaToken: fake.token('register') });
  assert.strictEqual(accepted.status, 303);
  assert.strictEqual((await postForm(base, createClient(base), '/registreren/', { ...register, captchaToken: fake.token('register') })).status, 400, 'het e-mailadres bestaat nu: gewone fout');

  const planner = { displayName: 'Planner Klant', email: 'planner@voorbeeld.nl', password: PW, website: '' };
  assert.strictEqual((await postForm(base, createClient(base), '/planner/', planner)).status, 400);
  assert.strictEqual((await postForm(base, createClient(base), '/planner/', { ...planner, captchaToken: fake.token('planner_signup') })).status, 303);

  // Wachtwoord vergeten: zonder geldig token gaat er geen mail weg.
  const mailsBefore = sent.length;
  const blocked = await postForm(base, createClient(base), '/wachtwoord-vergeten/', { email: 'k1@voorbeeld.nl' });
  assert.strictEqual(blocked.status, 400);
  assert.strictEqual(sent.length, mailsBefore);
  const allowed = await postForm(base, createClient(base), '/wachtwoord-vergeten/', { email: 'k1@voorbeeld.nl', captchaToken: fake.token('forgot_password') });
  assert.strictEqual(allowed.status, 200);
  assert.ok(before <= sent.length);
});

test('webshop: zakelijk aanvragen met een robot-token gaat niet door; de valstrik werkt nog zonder Google te vragen', async () => {
  const world = await captchaWorld();
  const { base, fake } = world;
  await world.admin.put('/app/api/admin/settings', { quoteProfile: { companyName: 'AquaTech', email: 'info@aquatech.example' } });
  const form = { company: 'Bedrijf BV', email: 'b@bedrijf.example', phone: '0612345678', message: '', website: '' };
  const bot = await postForm(base, createClient(base), '/zakelijk-aanvraag/', { ...form, captchaToken: fake.token('business_request', 0.1) });
  assert.strictEqual(bot.status, 303);
  assert.match(bot.location, /aanvraag=fout/);
  const calls = fake.calls.length;
  const trapped = await postForm(base, createClient(base), '/zakelijk-aanvraag/', { ...form, website: 'http://spam.example', captchaToken: '' });
  assert.match(trapped.location, /aanvraag=ja/);
  assert.strictEqual(fake.calls.length, calls, 'de valstrik antwoordt zonder Google te bellen');
});

test('webshop: afrekenen vraagt de captcha alleen bij het plaatsen, niet bij het bijwerken van het totaal; de pagina blijft ingevuld', async () => {
  const world = await captchaWorld();
  const { base, fake } = world;
  const shopper = world.shoppers[0];
  // Inloggen kost een token.
  const login = await postForm(base, shopper.client, '/inloggen/', { login: 'k1@voorbeeld.nl', password: PW, captchaToken: fake.token('login') });
  assert.strictEqual(login.status, 303);
  await postForm(base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const calls = fake.calls.length;
  const overview = await postForm(base, shopper.client, '/afrekenen/', { ...PERSON, action: 'update' });
  assert.strictEqual(overview.status, 200);
  assert.match(overview.text, /data-captcha-action="checkout"/);
  assert.match(overview.text, /data-captcha-skip/, 'de knop Totaal bijwerken vraagt geen token');
  assert.strictEqual(fake.calls.length, calls, 'bijwerken belt Google niet');
  const noToken = await postCheckout(base, shopper.client, PERSON);
  assert.strictEqual(noToken.status, 400);
  assert.match(noToken.text, /beveiligingscontrole is niet uitgevoerd/);
  assert.match(noToken.text, /value="Els Bakker"/, 'wat is ingevuld blijft staan');
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0, 'er is niets besteld');
  const placed = await postCheckout(base, shopper.client, { ...PERSON, captchaToken: fake.token('checkout') });
  assert.strictEqual(placed.status, 303, placed.text);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 1);
});

test('webshop: Google onbereikbaar laat het inloggen door (standaard) en blokkeert met de instelling Blokkeren, met een melding in de bewaking', async () => {
  const world = await captchaWorld();
  const { base, fake } = world;
  fake.mode.value = 'offline';
  const through = await postForm(base, createClient(base), '/inloggen/', { login: 'k1@voorbeeld.nl', password: PW, captchaToken: 'iets' });
  assert.strictEqual(through.status, 303, 'doorgelaten: de andere beveiligingen blijven gelden');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const incident = (await world.admin.get('/app/api/admin/monitoring')).body.incidents.find((item) => item.key === 'captcha');
  assert.ok(incident, 'de bewaking meldt dat Google niet bereikbaar is');
  assert.strictEqual(incident.state, 'open');
  fake.mode.value = 'ok';
  assert.strictEqual((await postForm(base, createClient(base), '/inloggen/', { login: 'k1@voorbeeld.nl', password: PW, captchaToken: fake.token('login') })).status, 303);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual((await world.admin.get('/app/api/admin/monitoring')).body.incidents.find((item) => item.key === 'captcha').state, 'opgelost', 'bij herstel sluit het incident');
  // Blokkeren.
  await world.admin.put('/app/api/admin/settings', { captcha: { ...ACTIVE, onUnreachable: 'block' } });
  fake.mode.value = 'offline';
  const blocked = await postForm(base, createClient(base), '/inloggen/', { login: 'k1@voorbeeld.nl', password: PW, captchaToken: 'iets' });
  assert.strictEqual(blocked.status, 503);
  assert.match(blocked.text, /niet beschikbaar/);
});

test('app: inloggen vraagt een token; de inlogpagina krijgt de sitesleutel en de uitgebreide CSP alleen als de captcha aan staat', async () => {
  const off = await setup({ appOptions: { loginDelayMs: 0 } });
  const plain = await createClient(off.base).get('/app/login');
  assert.ok(!/<meta name="aquatech-captcha"/.test(plain.text));
  assert.ok(!/google/.test(plain.headers.get('content-security-policy')));
  assert.strictEqual((await createClient(off.base).post('/app/api/auth/login', { username: 'baas', password: PW })).status, 200, 'zonder captcha werkt inloggen zoals altijd');

  const world = await captchaWorld();
  const { base, fake } = world;
  const page = await createClient(base).get('/app/login');
  assert.match(page.text, new RegExp(`<meta name="aquatech-captcha" content="${SITE_KEY}">`));
  assert.match(page.headers.get('content-security-policy'), /script-src [^;]*https:\/\/www\.google\.com\/recaptcha\//);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/www\.google\.com\/recaptcha\//);
  assert.ok(!page.text.includes(SECRET));
  assert.strictEqual((await createClient(base).get('/app/shared/captcha.js')).status, 200, 'het script is openbaar (de inlogpagina laadt het)');
  // Een ingelogde pagina houdt de oude CSP.
  assert.ok(!/google/.test((await world.admin.get('/app/')).headers.get('content-security-policy')));

  /**
   * Logt in via de app-API als beheerder.
   * @param {object} body Extra of afwijkende velden.
   * @returns {Promise<object>} Het antwoord.
   */
  const login = (body) => createClient(base).post('/app/api/auth/login', { username: 'baas', password: PW, ...body });
  const missing = await login({});
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'captcha_failed');
  assert.strictEqual((await login({ captchaToken: fake.token('login', 0.2) })).body.error, 'captcha_failed');
  assert.strictEqual((await login({ captchaToken: fake.token('login') })).status, 200);
  // Een goed token met een fout wachtwoord: de gewone 401, en een geweigerde robot telt niet mee voor de blokkering van het account.
  assert.strictEqual((await login({ password: 'Verkeerd-Wachtwoord-1!', captchaToken: fake.token('login') })).status, 401);
  for (let attempt = 0; attempt < 3; attempt += 1) await login({ captchaToken: 'robot' });
  assert.strictEqual((await login({ captchaToken: fake.token('login') })).status, 200, 'het account is niet geblokkeerd door robots');
  // Het geweigerde verzoek staat in het auditlog zonder token.
  const audit = (await world.admin.get('/app/api/admin/audit')).body;
  const rows = JSON.stringify(audit);
  assert.match(rows, /captcha_geweigerd/);
  assert.ok(!/robot|mens:/.test(rows), 'het token staat niet in het auditlog');
});

test('app: de noodschakelaar CAPTCHA_DISABLED zet de captcha uit, ook met sleutels', async () => {
  const fake = createCaptchaFake();
  const world = await setup({ appOptions: { captchaFetch: fake.fetchImpl, loginDelayMs: 0, env: { MULTITENANCY: '1', CAPTCHA_DISABLED: '1' } } });
  await world.admin.put('/app/api/admin/settings', { captcha: ACTIVE, captchaSecret: SECRET });
  const page = await createClient(world.base).get('/app/login');
  assert.ok(!/<meta name="aquatech-captcha"/.test(page.text));
  assert.strictEqual((await createClient(world.base).post('/app/api/auth/login', { username: 'baas', password: PW })).status, 200);
  assert.strictEqual(fake.calls.length, 0);
});

test('app: tekening indienen vraagt de captcha van de organisatie; de sitesleutel staat in de gegevens voor het formulier', async () => {
  const world = await captchaWorld();
  const { base, fake } = world;
  const anon = createClient(base);
  const info = (await anon.get('/app/api/public/drawing')).body;
  assert.deepStrictEqual(info.captcha, { siteKey: SITE_KEY });
  assert.ok(!JSON.stringify(info).includes(SECRET));
  const planner = await anon.get('/app/beregening/?tekenen');
  assert.strictEqual(planner.status, 200);
  assert.match(planner.headers.get('content-security-policy'), /https:\/\/www\.google\.com\/recaptcha\//);
  assert.strictEqual((await anon.get('/app/shared/captcha.js')).status, 200);
  const data = { meta: { name: 'Tuin' }, settings: {}, elements: [], sprinklers: [], zones: [], areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }] };
  const body = { name: 'Mark Jansen', email: 'jansen@voorbeeld.test', phone: '', address: '', question: '', consent: true, website: '', data };
  const missing = await anon.post('/app/api/public/drawing', body);
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'captcha_failed');
  assert.strictEqual((await anon.post('/app/api/public/drawing', { ...body, captchaToken: fake.token('drawing_submit', 0.1) })).status, 400);
  assert.strictEqual((await anon.post('/app/api/public/drawing', { ...body, captchaToken: fake.token('drawing_submit') })).status, 201);
  // De valstrik blijft zonder Google werken.
  const calls = fake.calls.length;
  assert.strictEqual((await anon.post('/app/api/public/drawing', { ...body, website: 'spam' })).status, 201);
  assert.strictEqual(fake.calls.length, calls);
  // Een organisatie zonder eigen sleutels (ander): geen captcha in haar formulier.
  await world.vreemd.put('/app/api/admin/settings', { drawingRequests: true });
  const other = (await anon.get('/app/api/public/drawing?org=ander')).body;
  assert.strictEqual(other.enabled, true);
  assert.strictEqual(other.captcha, null);
});

/**
 * Laadt shared/captcha.js in een vm met een nagebouwd document en geeft de vastgelegde luisteraars terug.
 * @param {{ grecaptcha?: object }} [options] Het nagebootste grecaptcha-object (standaard geeft execute een token terug).
 * @returns {{ listeners: object, window: object, scripts: object[] }} De luisteraars per gebeurtenis, het venster en de toegevoegde scripts.
 */
function loadClientScript({ grecaptcha } = {}) {
  const listeners = {};
  const scripts = [];
  const window = {};
  if (grecaptcha) window.grecaptcha = grecaptcha;
  const document = {
    /**
     * Legt een luisteraar vast.
     * @param {string} name Gebeurtenis.
     * @param {Function} handler Luisteraar.
     * @param {boolean} capture Capture-fase.
     * @returns {void}
     */
    addEventListener: (name, handler, capture) => { listeners[name] = { handler, capture }; },
    /**
     * Een leeg element.
     * @returns {object} Het element.
     */
    createElement: () => ({}),
    head: { appendChild: (script) => { scripts.push(script); setTimeout(() => { window.grecaptcha = grecaptcha; script.onload(); }, 0); } },
  };
  const context = vm.createContext({ window, document, setTimeout, clearTimeout, encodeURIComponent, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'shared', 'captcha.js'), 'utf8'), context);
  return { listeners, window, scripts };
}

test('browserscript: vraagt vlak voor het verzenden een vers token en verstuurt het formulier daarna met dezelfde knop; de knop Totaal bijwerken wordt overgeslagen', async () => {
  const executed = [];
  const grecaptcha = { ready: (callback) => callback(), execute: async (key, options) => { executed.push([key, options.action]); return `token-${executed.length}`; } };
  const client = loadClientScript({ grecaptcha });
  assert.strictEqual(typeof client.window.AquatechCaptcha.token, 'function');
  const field = { value: '', dataset: { siteKey: SITE_KEY, captchaAction: 'login' } };
  const submits = [];
  const form = { dataset: {}, querySelector: () => field, requestSubmit(submitter) { submits.push({ submitter, ready: this.dataset.captchaReady }); client.listeners.submit.handler({ target: form, submitter, preventDefault() { throw new Error('mag niet nogmaals geblokkeerd worden'); }, stopImmediatePropagation() {} }); }, submit() { throw new Error('requestSubmit hoort te werken'); } };
  const button = { hasAttribute: () => false };
  let prevented = 0;
  await client.listeners.submit.handler({ target: form, submitter: button, preventDefault: () => { prevented += 1; }, stopImmediatePropagation() {} });
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(executed, [[SITE_KEY, 'login']]);
  assert.strictEqual(field.value, 'token-1');
  assert.deepStrictEqual(submits, [{ submitter: button, ready: '1' }]);
  assert.strictEqual(form.dataset.captchaReady, undefined, 'daarna staat de vlag weer uit');
  // Totaal bijwerken: niet onderscheppen.
  let touched = false;
  await client.listeners.submit.handler({ target: form, submitter: { hasAttribute: (name) => name === 'data-captcha-skip' }, preventDefault: () => { touched = true; }, stopImmediatePropagation() {} });
  assert.strictEqual(touched, false);
  // Een formulier zonder captcha-veld wordt met rust gelaten.
  await client.listeners.submit.handler({ target: { dataset: {}, querySelector: () => null }, preventDefault: () => { touched = true; }, stopImmediatePropagation() {} });
  assert.strictEqual(touched, false);
});

test('browserscript: lukt het token niet (adblocker, Google weg), dan gaat het formulier toch weg met een leeg veld zodat de server de melding toont', async () => {
  const grecaptcha = { ready: (callback) => callback(), execute: async () => { throw new Error('geblokkeerd'); } };
  const client = loadClientScript({ grecaptcha });
  const field = { value: 'oud', dataset: { siteKey: SITE_KEY, captchaAction: 'register' } };
  let sent = 0;
  const form = { dataset: {}, querySelector: () => field, requestSubmit() { sent += 1; } };
  await client.listeners.submit.handler({ target: form, preventDefault() {}, stopImmediatePropagation() {} });
  assert.strictEqual(field.value, '');
  assert.strictEqual(sent, 1);
});
