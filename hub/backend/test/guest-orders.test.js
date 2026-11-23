// Tests van bestellen als gast in de eigen webshop: de keuze op de loginmuur, een bestelling zonder account (altijd particulier en online
// betaald), de persoonlijke link en het cookie, toegang en tenant-/klantscheiding, retour als gast, een account maken na de bestelling,
// de limieten en het uitzetten van bestellen als gast.
const test = require('node:test');
const assert = require('node:assert');
const { setup, until, mailsWith, PERSON, PW } = require('./helpers/webshop-world');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');
const { createGuestOrders, readGrants, rememberGrant, hashOf } = require('../src/webshop/guest-orders');

/**
 * Een nieuwe anonieme browser met een gevulde winkelwagen.
 * @param {object} world De testopzet.
 * @param {string} [qty] Aantal sproeiers in de wagen.
 * @returns {Promise<{ client: object }>} De bezoeker.
 */
async function visitor(world, qty = '2') {
  const client = createClient(world.base);
  await postForm(world.base, client, '/winkelwagen/', { action: 'add', code: 'BUS', qty });
  return { client };
}

/**
 * Plaatst een bestelling als gast en geeft het bestel-id, de cookie en het antwoord.
 * @param {object} world De testopzet.
 * @param {object} [fields] Andere afrekengegevens.
 * @param {{ client: object }} [guest] De bezoeker (standaard een nieuwe).
 * @returns {Promise<{ id: string, guest: { client: object }, placed: object }>} Het bestel-id, de bezoeker en het antwoord.
 */
async function placeGuest(world, fields = {}, guest = null) {
  const shopper = guest || await visitor(world);
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, guest: 'ja', paymentMethod: 'online', ...fields });
  assert.strictEqual(placed.status, 303, placed.text);
  const id = /\/bestelling\/([0-9a-f-]{36})\//.exec(placed.location)[1];
  return { id, guest: shopper, placed };
}

/**
 * De bestelling zoals Beheer hem ziet.
 * @param {object} world De testopzet.
 * @param {string} id Het bestel-id.
 * @returns {Promise<object>} De bestelling.
 */
const adminOrder = async (world, id) => (await world.admin.get(`/app/api/admin/web-orders/${id}`)).body.order;

/**
 * Laat de eerste betaling bij Mollie slagen en roept de webhook aan.
 * @param {object} world De testopzet.
 * @param {string} id Het bestel-id.
 * @param {{ client: object }} guest De gast die de betaalpagina opent.
 * @returns {Promise<void>}
 */
async function payAsGuest(world, id, guest) {
  const pay = await createClient(world.base, { jar: guest.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 302);
  const paymentId = (await adminOrder(world, id)).pay.id;
  world.mollie.set(paymentId, 'paid');
  assert.strictEqual((await postForm(world.base, createClient(world.base), `/mollie/webhook/${id}/`, { id: paymentId })).status, 200);
}

/**
 * De persoonlijke link uit de bevestigingsmail.
 * @param {object} world De testopzet.
 * @returns {Promise<string>} Het pad met ?k=.
 */
async function linkInMail(world) {
  const [mail] = await until(() => { const found = mailsWith(world.sent, /Bevestiging van je bestelling/).filter((message) => message.to === PERSON.email); return found.length ? found : null; });
  const match = /https:\/\/winkel\.example(\/bestelling\/[0-9a-f-]{36}\/\?k=[A-Za-z0-9_-]{43})/.exec(mail.text);
  assert.ok(match, `link in de mail: ${mail.text}`);
  return match[1];
}

test('loginmuur: bestellen zonder account kan alleen als online betalen werkt en het niet is uitgezet', async () => {
  const world = await setup({ mollie: true });
  const anonymous = await visitor(world);
  const wall = await anonymous.client.get('/afrekenen/');
  assert.match(wall.text, /Bestellen zonder account/);
  assert.match(wall.text, /href="\.\.\/afrekenen\/\?gast=1"/);
  const form = await anonymous.client.get('/afrekenen/?gast=1');
  assert.strictEqual(form.status, 200);
  assert.match(form.text, /<input type="hidden" name="guest" value="ja">/);
  assert.match(form.text, /<input type="hidden" name="paymentMethod" value="online">/);
  assert.doesNotMatch(form.text, /value="rekening"/, 'een gast betaalt nooit op rekening');
  assert.doesNotMatch(form.text, /data-dropship/, 'geen dropshipping zonder account');
  assert.doesNotMatch(form.text, /name="company"/, 'een gast is een particulier');
  assert.doesNotMatch(form.text, /name="vatNumber"/);
  assert.match(form.text, /name="email" type="email" value=""/, 'het e-mailadres is gewoon in te vullen');
  assert.match(form.text, /Bestellen en betalen/);

  await world.admin.put('/app/api/admin/settings', { shopPayment: { online: true, publicUrl: 'https://winkel.example/', onAccount: 'iedereen', holdHours: 24, guestCheckout: false } });
  const off = await anonymous.client.get('/afrekenen/?gast=1');
  assert.doesNotMatch(off.text, /Bestellen zonder account/);
  assert.doesNotMatch(off.text, /name="guest"/, 'uitgezet: ?gast=1 toont de loginmuur');
  const refused = await postCheckout(world.base, anonymous.client, { ...PERSON, guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(refused.status, 303);
  assert.strictEqual(refused.location, './');
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0, 'geen bestelling als gast terwijl het uit staat');
});

test('zonder online betalen is er geen bestellen als gast (een gast betaalt vooraf)', async () => {
  const world = await setup();
  const anonymous = await visitor(world);
  assert.doesNotMatch((await anonymous.client.get('/afrekenen/')).text, /Bestellen zonder account/);
  const refused = await postCheckout(world.base, anonymous.client, { ...PERSON, guest: 'ja', paymentMethod: 'rekening' });
  assert.strictEqual(refused.status, 303);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0);
});

test('bestellen als gast: particulier, online, token niet in het antwoord, cookie en eigen pagina', async () => {
  const world = await setup({ mollie: true });
  const { id, guest, placed } = await placeGuest(world, { company: 'Bakker BV', vatNumber: 'BE0123456789', dropshipping: 'ja', dropshipProofEmail: 'klant@voorbeeld.nl' });
  assert.strictEqual(placed.location, `../bestelling/${id}/?bedankt=1&betalen=1`);
  const detail = await adminOrder(world, id);
  assert.strictEqual(detail.guest, true);
  assert.strictEqual(detail.userId, null);
  assert.strictEqual(detail.customerGroup, '', 'een gast is altijd een particulier');
  assert.strictEqual(detail.vat, null, 'btw verleggen kan alleen met een zakelijk account');
  assert.strictEqual(detail.dropshipping, null, 'dropshipping vraagt een account');
  assert.strictEqual(detail.payment, 'online');
  assert.strictEqual(detail.email, PERSON.email);
  const cookie = guest.client.jar.get('aquatech_gastbestelling');
  assert.match(cookie, new RegExp(`^${id}\\.[A-Za-z0-9_-]{43}$`));
  const token = cookie.split('.')[1];
  const everything = JSON.stringify((await world.admin.get(`/app/api/admin/web-orders/${id}`)).body) + JSON.stringify((await world.admin.get('/app/api/admin/web-orders')).body);
  assert.ok(!everything.includes(token) && !everything.includes(hashOf(token)), 'het token en de hash komen nooit in een API-antwoord');
  const stored = world.db.prepare('SELECT data FROM web_orders WHERE id = ?').get(id).data;
  assert.ok(!stored.includes(token), 'in de database staat het token alleen versleuteld');
  assert.ok(stored.includes(hashOf(token)));

  const page = await guest.client.get(`/bestelling/${id}/?bedankt=1&betalen=1`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, new RegExp(detail.number));
  assert.match(page.text, /persoonlijke link/);
  assert.doesNotMatch(page.text, /<h2>Account maken\?<\/h2>/, 'het aanbod komt pas na de betaling');
  assert.match(page.text, /<meta http-equiv="refresh" content="0;url=betalen\/">/);
  assert.doesNotMatch(page.text, /Al mijn bestellingen/);
  assert.ok(!page.text.includes(token), 'het token staat niet in de pagina');
});

test('een gast bestelt nooit op rekening, nooit te veel en nooit zonder voorraad', async () => {
  const world = await setup({ mollie: true });
  const onAccount = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, guest: 'ja', paymentMethod: 'rekening' });
  assert.strictEqual(onAccount.status, 400);
  assert.match(onAccount.text, /Kies hoe je wilt betalen|betaal je direct online/);
  const noStock = await visitor(world, '999');
  const refused = await postCheckout(world.base, noStock.client, { ...PERSON, guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(refused.status, 303, 'een te grote bestelling gaat terug naar de winkelwagen');
  assert.match(refused.location, /winkelwagen/);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0);
  const noTerms = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, guest: 'ja', paymentMethod: 'online', terms: '' });
  assert.strictEqual(noTerms.status, 400);
  assert.match(noTerms.text, /algemene voorwaarden/);
  const badEmail = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, guest: 'ja', paymentMethod: 'online', email: 'geen-adres' });
  assert.strictEqual(badEmail.status, 400);
  assert.match(badEmail.text, /geldig e-mailadres/);
});

test('betaling in een andere browser: neutrale pagina zonder gegevens, geen factuur, geen betaalpagina', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  const stranger = createClient(world.base);
  const page = await stranger.get(`/bestelling/${id}/?betaald=1`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Bedankt voor je bestelling/);
  assert.match(page.text, /persoonlijke link uit de bevestigingsmail/);
  assert.ok(!page.text.includes((await adminOrder(world, id)).number), 'geen bestelgegevens zonder toegang');
  assert.doesNotMatch(page.text, /Tuinstraat/);
  assert.strictEqual((await createClient(world.base, { followRedirects: false }).get(`/bestelling/${id}/betalen/`)).status, 200, 'ook de betaalpagina geeft de neutrale pagina');
  assert.strictEqual(world.mollie.calls.filter((call) => call.method === 'POST').length, 0, 'zonder toegang start er geen betaling');
  assert.strictEqual((await stranger.get(`/bestelling/${id}/factuur.pdf`)).status, 404);
  const unknown = await createClient(world.base, { followRedirects: false }).get('/bestelling/00000000-0000-4000-8000-000000000000/');
  assert.strictEqual(unknown.status, 302, 'een onbekende bestelling zonder inlog gaat naar inloggen');
  assert.match(unknown.location, /inloggen/);
  assert.strictEqual((await guest.client.get(`/bestelling/${id}/`)).status, 200, 'de eigen browser heeft wel toegang');
});

test('een ingelogde andere klant en een andere gast zien de gastbestelling niet', async () => {
  const world = await setup({ mollie: true });
  const first = await placeGuest(world);
  const second = await placeGuest(world, { email: 'tweede@voorbeeld.nl' });
  const [account] = world.shoppers;
  const detail = await adminOrder(world, first.id);
  const asAccount = await account.client.get(`/bestelling/${first.id}/`);
  assert.strictEqual(asAccount.status, 200);
  assert.ok(!asAccount.text.includes(detail.number), 'een ander account ziet de bestelling niet');
  assert.doesNotMatch(asAccount.text, /<h2>Account maken\?<\/h2>/);
  assert.strictEqual((await second.guest.client.get(`/bestelling/${first.id}/`)).text.includes(detail.number), false, 'het token van een andere bestelling werkt niet');
  const forged = createClient(world.base);
  forged.jar.set('aquatech_gastbestelling', `${first.id}.${'A'.repeat(43)}`);
  assert.strictEqual((await forged.get(`/bestelling/${first.id}/`)).text.includes(detail.number), false, 'een verzonnen token werkt niet');
  const swapped = createClient(world.base);
  swapped.jar.set('aquatech_gastbestelling', `${first.id}.${second.guest.client.jar.get('aquatech_gastbestelling').split('.')[1]}`);
  assert.strictEqual((await swapped.get(`/bestelling/${first.id}/`)).text.includes(detail.number), false, 'het token van bestelling twee opent bestelling een niet');
  assert.strictEqual((await account.client.get('/bestellingen/')).text.includes(detail.number), false, 'een gastbestelling staat niet in de historie van een account');
});

test('de link in de bevestigingsmail wisselt het token tegen een cookie en verbergt het in de adresbalk', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  assert.strictEqual(mailsWith(world.sent, /Bevestiging van je bestelling/).length, 0, 'voor de betaling nog geen mail');
  await payAsGuest(world, id, guest);
  const link = await linkInMail(world);
  const confirmations = mailsWith(world.sent, /Bevestiging van je bestelling|Nieuwe webshopbestelling/);
  assert.ok(confirmations.every((message) => message.to === PERSON.email || !/\?k=/.test(message.text)), 'de link gaat nooit naar het bedrijf');

  const phone = createClient(world.base, { followRedirects: false });
  const exchange = await phone.get(link);
  assert.strictEqual(exchange.status, 302);
  assert.strictEqual(exchange.location, './', 'door naar het adres zonder token');
  assert.strictEqual(exchange.headers.get('referrer-policy'), 'no-referrer');
  assert.match(exchange.headers.getSetCookie().join(';'), /aquatech_gastbestelling=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  const page = await phone.get(`/bestelling/${id}/`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /online betaald|Je hebt online betaald/);
  assert.ok(!page.text.includes(link.split('?k=')[1]), 'het token staat niet in de pagina');

  const wrong = await createClient(world.base, { followRedirects: false }).get(`/bestelling/${id}/?k=${'B'.repeat(43)}`);
  assert.strictEqual(wrong.status, 404);
  assert.match(wrong.text, /Deze link werkt niet meer/);
  assert.strictEqual(wrong.headers.getSetCookie().length, 0, 'een onjuist token zet geen cookie');
  assert.strictEqual((await createClient(world.base, { followRedirects: false }).get(`/bestelling/${id}/?k=kort`)).status, 404);
  assert.strictEqual((await createClient(world.base, { followRedirects: false }).get(`/bestelling/${id}/?k=`)).status, 404);
  const otherOrder = await placeGuest(world, { email: 'ander@voorbeeld.nl' });
  assert.strictEqual((await createClient(world.base, { followRedirects: false }).get(`/bestelling/${otherOrder.id}/?k=${link.split('?k=')[1]}`)).status, 404, 'een token hoort bij één bestelling');

  const shipped = await world.admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual(shipped.status, 200, JSON.stringify(shipped.body));
  const shipmentMail = (await until(() => mailsWith(world.sent, /is onderweg/)[0])).text;
  assert.ok(shipmentMail.includes(link), 'ook de verzendmail bevat de persoonlijke link');
  const pdf = await phone.get(`/bestelling/${id}/factuur.pdf`);
  assert.strictEqual(pdf.status, 200, 'de factuur is te downloaden met de link');
  assert.strictEqual(pdf.type, 'application/pdf');
});

test('de link verloopt zoals andere klantlinks', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  const token = guest.client.jar.get('aquatech_gastbestelling').split('.')[1];
  const orders = {
    /**
     * De toegangsgegevens van een gastbestelling rechtstreeks uit de database.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} orderId Id van de bestelling.
     * @returns {?{ hash: string, sealed: string, createdAt: string, updatedAt: string }} De gegevens, of null.
     */
    guestAccessOf: (tenantId, orderId) => {
      const row = world.db.prepare('SELECT data, created_at, updated_at FROM web_orders WHERE id = ?').get(orderId);
      const guestData = row ? JSON.parse(row.data).guest : null;
      return guestData ? { hash: guestData.hash, sealed: guestData.sealed, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },
  };
  const access = createGuestOrders({ orders, vault: { seal: (value) => value, open: (value) => value } });
  const tenantId = world.db.prepare('SELECT tenant_id FROM web_orders WHERE id = ?').get(id).tenant_id;
  assert.strictEqual(access.hasAccess(tenantId, id, token), true);
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  world.db.prepare('UPDATE web_orders SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, id);
  assert.strictEqual(access.hasAccess(tenantId, id, token), false, 'na 180 dagen werkt de link niet meer');
  const page = await guest.client.get(`/bestelling/${id}/`);
  assert.match(page.text, /Bedankt voor je bestelling/, 'het cookie van een verlopen bestelling geeft ook geen toegang');
  assert.strictEqual(access.hasAccess(tenantId, 'geen-uuid', token), false);
  assert.strictEqual(access.hasAccess(tenantId, id, 12345), false);
});

test('het cookie onthoudt hoogstens vijf bestellingen en negeert rommel', () => {
  /**
   * Een verzoek met deze cookie.
   * @param {string} cookie De cookiekop.
   * @returns {object} Het verzoek.
   */
  const requestWith = (cookie) => ({ headers: { cookie } });
  /**
   * Een bestellings-id (UUID) met dit cijfer.
   * @param {number} number Het cijfer.
   * @returns {string} Het id.
   */
  const id = (number) => `00000000-0000-4000-8000-00000000000${number}`;
  /**
   * Een token (43 tekens) van deze letter.
   * @param {string} letter De letter.
   * @returns {string} Het token.
   */
  const token = (letter) => letter.repeat(43);
  const response = { headers: {}, getHeader(name) { return this.headers[name]; }, setHeader(name, value) { this.headers[name] = value; } };
  let jar = '';
  for (let number = 1; number <= 7; number += 1) {
    rememberGrant(requestWith(jar), response, id(number), token(String(number)));
    jar = response.headers['Set-Cookie'].at(-1).split(';')[0];
    response.headers['Set-Cookie'] = [];
  }
  const grants = readGrants(requestWith(jar));
  assert.deepStrictEqual([...grants.keys()], [id(7), id(6), id(5), id(4), id(3)], 'de nieuwste vijf, de oudste valt eruit');
  assert.strictEqual(readGrants(requestWith('aquatech_gastbestelling=rommel~~.~x.y.z')).size, 0);
  assert.strictEqual(readGrants(requestWith(`aquatech_gastbestelling=${id(1)}.${token('a')}.extra`)).size, 0, 'een onderdeel met een derde deel telt niet');
  assert.strictEqual(readGrants(requestWith(`aquatech_gastbestelling=${'x'.repeat(2000)}`)).size, 0);
  const secure = { headers: { 'x-forwarded-proto': 'https', cookie: '' } };
  const secureResponse = { headers: {}, getHeader() { return undefined; }, setHeader(name, value) { this.headers[name] = value; } };
  rememberGrant(secure, secureResponse, id(1), token('a'));
  assert.match(secureResponse.headers['Set-Cookie'][0], /^__Host-aquatech_gastbestelling=.*; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/, 'over https met het voorvoegsel __Host-');
});

test('retour als gast: aanvragen en intrekken met de eigen toegang, niet met die van een ander', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  await payAsGuest(world, id, guest);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'verzonden' })).status, 200);
  const page = await guest.client.get(`/bestelling/${id}/`);
  assert.match(page.text, /Retourneren/);
  const stranger = createClient(world.base);
  const refused = await postForm(world.base, stranger, `/bestelling/${id}/retour`, { 'qty:BUS': '1', reason: 'defect' });
  assert.strictEqual(refused.status, 303);
  assert.match(refused.location, /inloggen/, 'zonder toegang geen retour');
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM web_returns').get().n, 0);
  const requested = await postForm(world.base, guest.client, `/bestelling/${id}/retour`, { 'qty:BUS': '1', reason: 'defect', note: 'Kapot' });
  assert.strictEqual(requested.status, 303, requested.text);
  const record = world.db.prepare('SELECT id, user_id, order_id, status FROM web_returns').get();
  assert.strictEqual(record.user_id, null);
  assert.strictEqual(record.order_id, id);
  assert.strictEqual(record.status, 'aangevraagd');
  const excess = await postForm(world.base, guest.client, `/bestelling/${id}/retour`, { 'qty:BUS': '5', reason: 'defect' });
  assert.strictEqual(excess.status, 409);
  const otherGuest = await placeGuest(world, { email: 'derde@voorbeeld.nl' });
  const crossWithdraw = await postForm(world.base, otherGuest.guest.client, `/bestelling/${id}/retour/${record.id}/intrekken`, {});
  assert.match(crossWithdraw.location, /inloggen/, 'een andere gast heeft geen toegang tot deze bestelling');
  const wrongOrder = await postForm(world.base, otherGuest.guest.client, `/bestelling/${otherGuest.id}/retour/${record.id}/intrekken`, {});
  assert.strictEqual(wrongOrder.status, 404, 'een retour van een andere bestelling met eigen toegang kan niet worden ingetrokken');
  assert.strictEqual(world.db.prepare('SELECT status FROM web_returns WHERE id = ?').get(record.id).status, 'aangevraagd');
  const withdrawn = await postForm(world.base, guest.client, `/bestelling/${id}/retour/${record.id}/intrekken`, {});
  assert.strictEqual(withdrawn.status, 303);
  assert.strictEqual(world.db.prepare('SELECT status FROM web_returns WHERE id = ?').get(record.id).status, 'ingetrokken');
});

test('een gast maakt na de bestelling een account: de bestelling komt erin, een tweede keer kan niet', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  const url = `/bestelling/${id}/account/`;
  const unpaid = await guest.client.get(`/bestelling/${id}/`);
  assert.doesNotMatch(unpaid.text, /<h2>Account maken\?<\/h2>/, 'een onbetaalde bestelling biedt geen account aan');
  const early = await postForm(world.base, guest.client, url, { password: PW, password2: PW, website: '' });
  assert.strictEqual(early.status, 303);
  assert.strictEqual(early.location, './', 'zonder betaling geen account');
  assert.strictEqual((await adminOrder(world, id)).userId, null);
  await payAsGuest(world, id, guest);
  const mismatch = await postForm(world.base, guest.client, url, { password: PW, password2: `${PW}x`, website: '' });
  assert.strictEqual(mismatch.status, 400);
  assert.match(mismatch.text, /wachtwoorden zijn niet gelijk/);
  assert.match(mismatch.text, /<h2>Account maken\?<\/h2>/, 'het aanbod blijft staan');
  assert.strictEqual((await adminOrder(world, id)).userId, null);
  const stranger = await postForm(world.base, createClient(world.base), url, { password: PW, password2: PW, website: '' });
  assert.notStrictEqual(stranger.status, 303, 'zonder toegang geen account');
  const bot = await postForm(world.base, guest.client, url, { password: PW, password2: PW, website: 'http://spam' });
  assert.strictEqual(bot.status, 303);
  assert.strictEqual(bot.location, '../../', 'een bot krijgt geen account');
  assert.strictEqual((await adminOrder(world, id)).userId, null);

  const created = await postForm(world.base, guest.client, url, { password: PW, password2: PW, website: '' });
  assert.strictEqual(created.status, 303, created.text);
  assert.strictEqual(created.location, './?account=1');
  const detail = await adminOrder(world, id);
  assert.ok(detail.userId, 'de bestelling hangt nu aan het account');
  const user = world.db.prepare('SELECT email, display_name, customer_group FROM users WHERE id = ?').get(detail.userId);
  assert.strictEqual(user.email, PERSON.email);
  assert.strictEqual(user.display_name, PERSON.name);
  assert.ok(!user.customer_group, 'het account is een particulier');
  const page = await guest.client.get(`/bestelling/${id}/?account=1`);
  assert.match(page.text, /Je account is aangemaakt/);
  assert.doesNotMatch(page.text, /<h2>Account maken\?<\/h2>/);
  assert.match((await guest.client.get('/bestellingen/')).text, new RegExp(detail.number), 'de bestelling staat in de historie');
  const again = await postForm(world.base, guest.client, url, { password: PW, password2: PW, website: '' });
  assert.strictEqual(again.status, 303);
  assert.strictEqual(again.location, './', 'een gekoppelde bestelling biedt geen tweede account aan');
});

test('een gast met het adres van een bestaand account kan dat account niet overnemen', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world, { email: 'k1@voorbeeld.nl' });
  await payAsGuest(world, id, guest);
  const attempt = await postForm(world.base, guest.client, `/bestelling/${id}/account/`, { password: PW, password2: PW, website: '' });
  assert.strictEqual(attempt.status, 400);
  assert.match(attempt.text, /Er is al een account met dit e-mailadres/);
  assert.strictEqual((await adminOrder(world, id)).userId, null, 'de bestelling blijft een gastbestelling');
  const [existing] = world.shoppers;
  assert.strictEqual((await existing.client.get('/bestellingen/')).text.includes((await adminOrder(world, id)).number), false, 'de bestelling komt niet in het bestaande account');
});

test('een ingelogd account kan geen account maken op een gastbestelling', async () => {
  const world = await setup({ mollie: true });
  const { id } = await placeGuest(world);
  const [account] = world.shoppers;
  const response = await postForm(world.base, account.client, `/bestelling/${id}/account/`, { password: PW, password2: PW, website: '' });
  assert.notStrictEqual(response.status, 400);
  assert.strictEqual((await adminOrder(world, id)).userId, null);
});

test('limieten: hoogstens drie gastbestellingen per e-mailadres per uur', async () => {
  const world = await setup({ mollie: true });
  // Elke bestelling wordt betaald: onbetaald mogen er maar twee tegelijk openstaan (zie de test hieronder).
  for (let count = 0; count < 3; count += 1) {
    const placed = await placeGuest(world, { email: 'veel@voorbeeld.nl' });
    await payAsGuest(world, placed.id, placed.guest);
  }
  const fourth = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, email: 'veel@voorbeeld.nl', guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(fourth.status, 429);
  assert.match(fourth.text, /veel bestellingen/);
  const other = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, email: 'ander@voorbeeld.nl', guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(other.status, 303, 'een ander adres is niet geblokkeerd');
  assert.strictEqual(world.db.prepare("SELECT COUNT(*) AS n FROM web_orders WHERE email = 'veel@voorbeeld.nl'").get().n, 3);
});

test('plafond: hoogstens twee onbetaalde gastbestellingen tegelijk per e-mailadres en drie per bezoeker (B-13)', async () => {
  const world = await setup({ mollie: true });
  const first = await placeGuest(world, { email: 'open@voorbeeld.nl' });
  await placeGuest(world, { email: 'open@voorbeeld.nl' });
  const third = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, email: 'open@voorbeeld.nl', guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(third.status, 429);
  assert.match(third.text, /openstaan die niet betaald zijn/);
  // Een ander adres vanaf dezelfde bezoeker mag nog één keer (drie open per bezoeker), daarna niet meer.
  await placeGuest(world, { email: 'tweede@voorbeeld.nl' });
  const fourth = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, email: 'derde@voorbeeld.nl', guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(fourth.status, 429, 'drie onbetaalde bestellingen vanaf dezelfde bezoeker');
  // Na het betalen van één bestelling is er weer ruimte, voor het adres en voor de bezoeker.
  await payAsGuest(world, first.id, first.guest);
  const after = await postCheckout(world.base, (await visitor(world)).client, { ...PERSON, email: 'open@voorbeeld.nl', guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(after.status, 303, after.text);
});

test('een gast die bestaande bestellingen heeft houdt toegang als bestellen als gast wordt uitgezet', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  await world.admin.put('/app/api/admin/settings', { shopPayment: { online: true, publicUrl: 'https://winkel.example/', onAccount: 'iedereen', holdHours: 24, guestCheckout: false } });
  const page = await guest.client.get(`/bestelling/${id}/`);
  assert.match(page.text, new RegExp((await adminOrder(world, id)).number));
});

test('audit: gastbestelling en koppeling aan een account staan in het logboek zonder token', async () => {
  const world = await setup({ mollie: true });
  const { id, guest } = await placeGuest(world);
  await payAsGuest(world, id, guest);
  await postForm(world.base, guest.client, `/bestelling/${id}/account/`, { password: PW, password2: PW, website: '' });
  const rows = world.db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'webshop_%gast%' OR action = 'webshop_bestelling_geplaatst'").all();
  assert.ok(rows.some((row) => row.action === 'webshop_bestelling_geplaatst' && JSON.parse(row.detail).gast === true));
  assert.ok(rows.some((row) => row.action === 'webshop_gastbestelling_gekoppeld'));
  const token = guest.client.jar.get('aquatech_gastbestelling').split('.')[1];
  assert.ok(!JSON.stringify(rows).includes(token));
});
