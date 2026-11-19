// Opnieuw bestellen vanuit een eerdere bestelling: de regels komen bij de winkelwagen, wat niet meer te koop is wordt gemeld,
// en alleen de eigenaar (of een gast met zijn persoonlijke toegang) kan het doen.
const test = require('node:test');
const assert = require('node:assert');
const { setup, order } = require('./helpers/webshop-world');
const { postForm, createClient } = require('./helpers/http-client');

test('opnieuw bestellen: de regels komen bij de wagen (opgeteld), een artikel dat niet meer te koop is wordt gemeld', async () => {
  const world = await setup();
  const [shopper, other] = world.shoppers;
  const id = await order(world, shopper);
  const page = await shopper.client.get(`/bestelling/${id}/`);
  assert.match(page.text, /Opnieuw bestellen/);
  assert.match(page.text, /action="opnieuw\/"/);
  assert.strictEqual((await shopper.client.get('/winkelwagen/')).text.includes('Sproeier'), false, 'wagen is na het bestellen leeg');
  const again = await postForm(world.base, shopper.client, `/bestelling/${id}/opnieuw/`, {});
  assert.strictEqual(again.status, 303);
  assert.match(again.location, /\/winkelwagen\/\?opnieuw=1$/);
  const cart = await shopper.client.get('/winkelwagen/?opnieuw=1');
  assert.match(cart.text, /staan in je winkelwagen \(1\)/);
  assert.match(cart.text, /name="qty" value="2"/, 'het eerdere aantal');
  await postForm(world.base, shopper.client, `/bestelling/${id}/opnieuw/`, {});
  assert.match((await shopper.client.get('/winkelwagen/')).text, /name="qty" value="4"/, 'telt op bij wat er al in de wagen zit');
  // Een andere klant kan de bestelling niet opnieuw bestellen.
  const denied = await postForm(world.base, other.client, `/bestelling/${id}/opnieuw/`, {});
  assert.strictEqual(denied.status, 404);
  assert.doesNotMatch((await other.client.get('/winkelwagen/')).text, /Sproeier/);
  // Het artikel gaat uit de verkoop: melding in plaats van een lege wagen met fout.
  world.db.prepare("UPDATE stock_items SET shop_sync = 0 WHERE code = 'BUS'").run();
  const missing = await postForm(world.base, shopper.client, `/bestelling/${id}/opnieuw/`, {});
  assert.match(missing.location, /opnieuw=0&niet=BUS/);
});

test('opnieuw bestellen: niet ingelogd gaat naar inloggen', async () => {
  const world = await setup();
  const [shopper] = world.shoppers;
  const id = await order(world, shopper);
  const visitor = createClient(world.base);
  const out = await postForm(world.base, visitor, `/bestelling/${id}/opnieuw/`, {});
  assert.match(out.location, /inloggen/);
});
