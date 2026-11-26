// Plannerpromotie in de webshop: een blok op de startpagina en in beregeningscategorieën, alleen als de planner aan staat.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/webshop-world');
const { createClient } = require('./helpers/http-client');

const PROMO = /class="planner-promo"/;

/**
 * Zet het testartikel in een beregeningscategorie en in een andere hoofdcategorie, zodat beide groepen bestaan.
 * @param {object} world De testopzet.
 * @returns {void}
 */
function placeProducts(world) {
  const tenantId = world.db.prepare("SELECT tenant_id FROM stock_items WHERE code = 'BUS'").get().tenant_id;
  world.db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, '501', 'x', 'https://shop.test/a.jpg', '["Sproeiers"]');
  world.db.prepare("UPDATE stock_items SET shop_product_id = '501' WHERE tenant_id = ? AND code = 'BUS'").run(tenantId);
}

test('plannerpromotie: startpagina en beregeningsgroep en -categorie tonen het blok, uitgezet verdwijnt het', async () => {
  const world = await setup();
  placeProducts(world);
  // De catalogus wordt even onthouden: een wijziging van de kortingen maakt hem vers.
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregening_nieuw', discountPct: 5 }] })).status, 200);
  const visitor = createClient(world.base);
  const home = await visitor.get('/');
  assert.match(home.text, PROMO);
  assert.match(home.text, /Ontwerp je beregening gratis/);
  assert.match(home.text, /href="planner\/">Naar de planner /);
  assert.ok(!/<!--planner-promo/.test(home.text), 'geen merkteken in de pagina');
  const groupSlug = /groep\/([^/"]*beregening[^/"]*)\//.exec(home.text)[1];
  const group = await visitor.get(`/groep/${groupSlug}/`);
  assert.strictEqual(group.status, 200);
  assert.match(group.text, PROMO);
  assert.match(group.text, /href="\.\.\/\.\.\/planner\/">Naar de planner /);
  const categorySlug = /categorie\/([^/"]+)\//.exec(group.text)[1];
  const category = await visitor.get(`/categorie/${categorySlug}/`);
  assert.strictEqual(category.status, 200);
  assert.match(category.text, PROMO, 'ook in een beregeningscategorie');
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { shopPlanner: false })).status, 200);
  for (const path of ['/', `/groep/${groupSlug}/`]) {
    const page = await createClient(world.base).get(path);
    assert.ok(!PROMO.test(page.text) && !/<!--planner-promo/.test(page.text), `planner uit: geen blok op ${path}`);
  }
});
