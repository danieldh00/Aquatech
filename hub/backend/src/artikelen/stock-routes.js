// API-routes van de voorraad (artikelen, eenheden, mutaties, subartikelen, samenvoegen, import en
// werkorderverbruik). Letterlijk uit stock.js verplaatst; de opslag komt binnen via ctx.stock.
const { respondShopError } = require('../webshop/woocommerce');
const { registerItemImportRoutes } = require('./item-import');
const { registerPriceListRoutes } = require('./supplier-price-list');
const { createShopMissingJob } = require('./shop-missing-job');
const { KINDS, GROUPS, EXPORT_LIMIT, shopCodeOf, isDate } = require('./stock-helpers');

/**
 * API-routes voor de voorraad. Het beheer valt onder het recht 'voorraad';
 * de voorraad van een werkorder bekijken en afboeken onder 'werkorders'.
 * Gegevens per omgeving via req.tenantId.
 * @param {object} app De Express-app.
 * @param {object} ctx { stock, requireRight, requireAnyRight?, requireJson, audit, shopProductsOf?, shopMatchOf?, shopMirrorOn?, shopCanPublish?, shopExclusive?, publishMergedLocked?, syncShop?, publishToShop? }.
 * @returns {void}
 */
function registerStockRoutes(app, ctx) {
  const { stock, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  const requireWorkOrders = requireRight('werkorders');
  // De artikellijst om uit te kiezen hebben werkorders, offertes en de voorraad nodig.
  const requirePicker = ctx.requireAnyRight ? ctx.requireAnyRight(['werkorders', 'offertes', 'voorraad']) : requireStock;
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 terug.
   * @param {object} res Het antwoord.
   * @param {string} [what] Wat niet gevonden is.
   * @returns {void}
   */
  const notFound = (res, what = 'Artikel') => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  /**
   * Stuurt een fout uit de opslag terug (404, 409 of 400 met het veld).
   * @param {object} res Het antwoord.
   * @param {{ error: string, status?: number, field?: string }} out De fout.
   * @returns {void}
   */
  const fail = (res, out) => (out.error === 'not_found' ? notFound(res)
    : res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field }));
  /**
   * Zet het antwoord op niet cachen.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  app.get('/api/stock', requireStock, (req, res) => {
    noStore(res);
    const items = stock.list(tenantOf(req), { archived: req.query.archived === '1' });
    // Oude nummers (zoeknamen) per artikel, zodat de lijst er ook op kan zoeken.
    const aliases = ctx.codeGroups ? ctx.codeGroups.aliasesByItem(tenantOf(req)) : new Map();
    res.json({ items: items.map((item) => (aliases.has(item.id) ? { ...item, aliases: aliases.get(item.id) } : item)), kinds: KINDS, groups: GROUPS });
  });

  // Eenheden (st, m, rol, ...) waaruit een artikel er een kiest.
  app.get('/api/stock/units', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.units(tenantOf(req)) });
  });

  app.post('/api/stock/units', requireJson, requireStock, (req, res) => {
    const out = stock.addUnit(tenantOf(req), req.body?.name);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_eenheid_aangemaakt', { name: out.unit.name });
    res.status(201).json(out.unit);
  });

  app.delete('/api/stock/units/:id', requireStock, (req, res) => {
    const out = stock.removeUnit(tenantOf(req), req.params.id);
    if (out.error) return out.status === 404 ? notFound(res, 'Eenheid') : fail(res, out);
    audit(req, 'voorraad_eenheid_verwijderd', { name: out.name });
    res.json({ deleted: true });
  });

  // Artikelen om uit te kiezen (eerst het artikel, dan de maat): zonder inkoopprijs.
  app.get('/api/stock/articles', requirePicker, (req, res) => {
    noStore(res);
    res.json({ items: stock.articleChoices(tenantOf(req)) });
  });

  app.get('/api/stock/reservations', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.reservations(tenantOf(req)) });
  });

  // Bestelvoorstel: wat onder het minimum zit en hoeveel er bij moet (de Excel maakt de browser).
  app.get('/api/stock/reorder', requireStock, (req, res) => {
    noStore(res);
    res.json(stock.reorderProposal(tenantOf(req), { preferred: ctx.suppliers ? ctx.suppliers.preferredByItem(tenantOf(req)) : new Map(), incoming: ctx.purchaseOrders ? ctx.purchaseOrders.incomingByItem(tenantOf(req)) : new Map() }));
  });

  app.get('/api/stock/movements', requireStock, (req, res) => {
    noStore(res);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    res.json({ items: stock.movements(tenantOf(req), { from, to, limit: req.query.limit }), limit: EXPORT_LIMIT });
  });

  app.get('/api/stock/items/:id', requireStock, (req, res) => {
    noStore(res);
    const item = stock.get(tenantOf(req), req.params.id);
    if (!item) return notFound(res);
    res.json(item);
  });

  app.post('/api/stock/items', requireJson, requireStock, (req, res) => {
    const out = stock.create(tenantOf(req), req.user, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_artikel_aangemaakt', { itemId: out.item.id, code: out.item.code });
    res.status(201).json(out.item);
  });

  // Artikelen importeren uit Excel (V-05).
  registerItemImportRoutes(app, ctx);
  // Prijslijst van een leverancier inlezen (V-30).
  if (ctx.suppliers) registerPriceListRoutes(app, ctx);

  app.post('/api/stock/import', requireJson, requireStock, (req, res) => {
    const out = stock.importCatalog(tenantOf(req), req.user, req.body?.codes);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_catalogus_overgenomen', { created: out.created });
    res.json(out);
  });

  // Webshopproducten die nog geen voorraadartikel zijn (om over te nemen).
  app.get('/api/stock/shop-products', requireStock, (req, res) => {
    noStore(res);
    const products = ctx.shopProductsOf ? ctx.shopProductsOf(tenantOf(req)) : [];
    const have = new Set(stock.list(tenantOf(req), { archived: true }).flatMap((item) => [item.code, item.shop.productId ? `#${item.shop.productId}` : '']));
    const variationCount = new Map();
    for (const product of products) if (product.parentId) variationCount.set(String(product.parentId), (variationCount.get(String(product.parentId)) || 0) + 1);
    res.json({
      items: products.filter((product) => !product.parentId && !have.has(`#${product.id}`) && !have.has(shopCodeOf(product)))
        .map((product) => ({ id: product.id, sku: product.sku, code: shopCodeOf(product), name: product.name, price: product.price, inStock: product.inStock, variations: variationCount.get(String(product.id)) || 0 })),
    });
  });

  // Zonder ids: alles uit de webshop overnemen (volle synchronisatie, zie shop-sync.js).
  app.post('/api/stock/import-shop', requireJson, requireStock, ctx.importLimiter || ((req, res, next) => next()), async (req, res, next) => {
    if (!Array.isArray(req.body?.ids) && ctx.syncShop) {
      try {
        const out = await ctx.syncShop(tenantOf(req), req.user);
        if (out.skipped) return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Integraties → Webshop).' });
        if (out.mirror === false) return res.status(409).json({ error: 'mirror_off', message: 'De instelling "Webshop bepaalt de artikellijst" staat uit (Beheer → Integraties → Webshop); er is niets overgenomen.' });
        audit(req, 'voorraad_webshop_overgenomen', { created: out.created, archived: out.archived });
        return res.json(out);
      } catch (error) {
        return respondShopError(res, error, next);
      }
    }
    next();
  }, (req, res) => {
    const out = stock.importShop(tenantOf(req), ctx.shopProductsOf ? ctx.shopProductsOf(tenantOf(req)) : [], req.body?.ids);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_webshop_overgenomen', { created: out.created });
    res.json(out);
  });

  // TIJDELIJK (tot WooCommerce uit staat): alleen de producten toevoegen die nog geen artikel hebben; archiveert en wijzigt niets.
  // Draait als achtergrondtaak (de volledige webshop ophalen duurt langer dan een verzoek mag): POST start, GET geeft de voortgang.
  const missingJob = ctx.syncShop ? createShopMissingJob({ syncShop: ctx.syncShop }) : null;
  app.post('/api/stock/import-shop-missing', requireJson, requireStock, ctx.importLimiter || ((req, res, next) => next()), (req, res) => {
    if (!missingJob) return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Integraties → Webshop).' });
    const tenantId = tenantOf(req);
    const started = missingJob.start(tenantId, req.user, {
      onDone: (state) => audit(req, 'voorraad_webshop_ontbrekende_toegevoegd', { created: state.created, skipped: state.skipped, failed: Boolean(state.error) }),
    });
    res.status(202).json({ started, ...missingJob.get(tenantId) });
  });
  app.get('/api/stock/import-shop-missing', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(missingJob ? missingJob.get(tenantOf(req)) : { running: false, phase: 'idle', added: [] });
  });

  app.put('/api/stock/items/:id', requireJson, requireStock, (req, res) => {
    const out = stock.update(tenantOf(req), req.params.id, req.body, req.user);
    if (out.error) return fail(res, out);
    res.json(out.item);
  });

  // Inkoopprijs: een nieuwe prijs met datum (de oude blijft in de historie).
  app.post('/api/stock/items/:id/cost-prices', requireJson, requireStock, (req, res) => {
    const out = stock.addCostPrice(tenantOf(req), req.user, req.params.id, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_inkoopprijs', { itemId: out.item.id, code: out.item.code, price: out.item.costPrice });
    res.status(201).json(out.item);
  });

  // Voorraadlaag met een onbekende inkoopprijs (of de beginstand): prijs invullen.
  app.put('/api/stock/items/:id/layers/:layerId', requireJson, requireStock, (req, res) => {
    const out = stock.setLayerCost(tenantOf(req), req.params.id, req.params.layerId, req.body?.unitCost);
    if (out.error === 'not_found') return notFound(res, 'Voorraadlaag');
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_laag_inkoopprijs', { itemId: out.item.id, code: out.item.code, layerId: String(req.params.layerId).slice(0, 80) });
    res.json(out.item);
  });

  // Voorstellen: losse artikelen die samen één variabel artikel kunnen worden, plus wat er met de webshop gebeurt.
  app.get('/api/stock/merge-suggestions', requireStock, (req, res) => {
    noStore(res);
    const tenantId = tenantOf(req);
    const mirror = Boolean(ctx.shopMirrorOn && ctx.shopMirrorOn(tenantId));
    const publishes = Boolean(ctx.shopCanPublish && ctx.shopCanPublish(tenantId));
    // publishes: Aquatech zet de artikelgroep zelf in de webshop; blocked: de webshop bepaalt de lijst maar Aquatech mag niet schrijven.
    res.json({ groups: stock.mergeSuggestions(tenantId), shop: { publishes, blocked: mirror && !publishes } });
  });

  // Losse artikelen samenvoegen tot de subartikelen van een nieuw artikelgroep; gekoppelde webshopproducten worden vervangen door één variabel product.
  app.post('/api/stock/merge', requireJson, requireStock, async (req, res) => {
    const tenantId = tenantOf(req);
    const publishes = Boolean(ctx.shopCanPublish && ctx.shopCanPublish(tenantId) && ctx.shopExclusive && ctx.publishMergedLocked);
    const mirror = Boolean(ctx.shopMirrorOn && ctx.shopMirrorOn(tenantId));
    /**
     * Voegt samen en zet het resultaat zo nodig in de webshop. Met een schrijvende webshopkoppeling loopt dit in de
     * wachtrij van de omgeving, zodat geen synchronisatie tussen de samenvoeging en de webshop in komt.
     * @returns {Promise<object>} { status, body } van het antwoord.
     */
    const run = async () => {
      const out = stock.mergeIntoGroup(tenantId, req.body, { refuseLinked: mirror && !publishes, shopMatchOf: ctx.shopMatchOf ? ctx.shopMatchOf(tenantId) : null, user: req.user });
      if (out.error) return { out };
      let shop = null;
      if (publishes && out.unlinked + out.shopProductIds.length > 0) {
        let published;
        try {
          published = await ctx.publishMergedLocked(tenantId, out.groupId, out.shopProductIds);
        } catch (error) {
          console.error('Samengevoegd artikelgroep in de webshop zetten mislukt:', error.message);
          published = { error: 'De webshop gaf een onverwachte fout (zie het log).', revert: true, status: 502 };
        }
        if (published.revert) {
          // Niets half laten staan: de samenvoeging terugdraaien, de artikelen zijn dan weer los en gekoppeld.
          const undone = stock.unmergeSubItems(tenantId, out.groupId);
          return { out, reverted: { message: published.error, status: published.status === 409 ? 409 : 502, undoError: undone.error || null } };
        }
        shop = { productId: published.productId, variations: published.variations, hidden: published.hidden, warning: published.warning };
      }
      return { out, shop };
    };
    const done = publishes ? await ctx.shopExclusive(tenantId, run) : await run();
    if (done.out.error) return fail(res, done.out);
    if (done.reverted) {
      if (ctx.pruneImages) { try { ctx.pruneImages(tenantId); } catch (error) { console.error('Afbeeldingen opruimen mislukt:', error.message); } }
      const note = done.reverted.undoError ? ` Het terugdraaien lukte niet (${done.reverted.undoError}); draai de samenvoeging met de hand terug.` : '';
      return res.status(done.reverted.status).json({ error: 'shop_failed', message: `Niet samengevoegd: de webshop kon niet worden bijgewerkt. ${done.reverted.message}${note}` });
    }
    const { out, shop } = done;
    const item = stock.get(tenantId, out.groupId);
    // De samenvoeging staat al in de database: een fout in het auditlogboek mag die niet als mislukt melden.
    try { audit(req, 'voorraad_samengevoegd', { itemId: out.groupId, code: item.code, merged: out.merged, unlinked: out.unlinked, ...(shop ? { shopHidden: shop.hidden } : {}) }); } catch (error) { console.error('Audit voorraad_samengevoegd mislukt:', error.message); }
    res.status(201).json({ item, merged: out.merged, unlinked: out.unlinked, shop });
  });

  // Wat terugdraaien van een samenvoeging doet (voor de bevestiging).
  app.get('/api/stock/items/:id/unmerge', requireStock, (req, res) => {
    noStore(res);
    const out = stock.unmergePreview(tenantOf(req), req.params.id);
    if (out.error) return fail(res, out);
    res.json(out);
  });

  // Een samenvoeging terugdraaien: de subartikelen worden weer losse artikelen, de artikelgroep verdwijnt.
  app.post('/api/stock/items/:id/unmerge', requireJson, requireStock, (req, res) => {
    const out = stock.unmergeSubItems(tenantOf(req), req.params.id);
    if (out.error) return fail(res, out);
    // Het terugdraaien staat al in de database: opruimen en auditlogboek zijn bijzaak en mogen het niet als mislukt melden.
    try { if (ctx.pruneImages) ctx.pruneImages(tenantOf(req)); } catch (error) { console.error('Afbeeldingen opruimen na terugdraaien mislukt:', error.message); }
    try { audit(req, 'voorraad_samenvoeging_teruggedraaid', { itemId: req.params.id, code: out.code, restored: out.restored, removed: out.removed, reconstructed: out.reconstructed }); } catch (error) { console.error('Audit voorraad_samenvoeging_teruggedraaid mislukt:', error.message); }
    res.json(out);
  });

  // Kenmerken van een artikelgroep; ontbrekende subartikelen worden aangemaakt.
  app.put('/api/stock/items/:id/sub-items', requireJson, requireStock, (req, res) => {
    const out = stock.setSubItems(tenantOf(req), req.params.id, req.body?.attributes);
    if (out.error) return fail(res, out);
    if (out.removed > 0 && ctx.pruneImages) ctx.pruneImages(tenantOf(req));
    audit(req, 'voorraad_subartikelen', { itemId: out.item.id, code: out.item.code, created: out.created, restored: out.restored });
    res.json({ ...out.item, created: out.created, restored: out.restored });
  });

  // Artikel (met subartikelen) als nieuw product in de webshop zetten; Aquatech is de bron.
  app.post('/api/stock/items/:id/publish', requireJson, requireStock, ctx.importLimiter || ((req, res, next) => next()), async (req, res, next) => {
    // Eerst het artikel in deze omgeving: een id van een andere organisatie is 404, ook zonder webshop.
    if (!stock.get(tenantOf(req), req.params.id)) return notFound(res);
    if (!ctx.publishToShop) return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Integraties → Webshop).' });
    try {
      const out = await ctx.publishToShop(tenantOf(req), req.params.id, req.user);
      if (out.error === 'not_found') return notFound(res);
      if (out.error) return res.status(out.status || 409).json({ error: out.code || 'conflict', message: out.error });
      audit(req, 'voorraad_naar_webshop', { itemId: req.params.id, productId: out.productId, variations: out.variations });
      res.json({ ...stock.get(tenantOf(req), req.params.id), published: out });
    } catch (error) {
      respondShopError(res, error, next);
    }
  });

  app.delete('/api/stock/items/:id', requireStock, (req, res) => {
    const out = stock.remove(tenantOf(req), req.params.id);
    if (!out) return notFound(res);
    if (out.error) return res.status(out.status).json({ error: 'reserved_by_order', message: out.error, orders: out.orders });
    // Ook bij archiveren: een artikelgroep kan subartikelen (met eigen afbeelding) echt verwijderd hebben.
    if (ctx.pruneImages) ctx.pruneImages(tenantOf(req));
    audit(req, out.deleted ? 'voorraad_artikel_verwijderd' : 'voorraad_artikel_gearchiveerd', { itemId: req.params.id, code: out.code });
    res.json(out);
  });

  app.post('/api/stock/items/:id/movements', requireJson, requireStock, (req, res) => {
    const out = stock.move(tenantOf(req), req.user, req.params.id, req.body);
    if (out.error) return fail(res, out);
    if (req.body.kind !== 'ontvangst') audit(req, `voorraad_${req.body.kind}`, { itemId: out.item.id, code: out.item.code, delta: out.delta });
    res.status(201).json(out.item);
  });

  app.post('/api/stock/resync', requireJson, requireStock, (req, res) => {
    res.json({ workOrders: stock.resyncOpen(tenantOf(req)) });
  });

  // ---------- Vanuit de werkorder ----------
  app.get('/api/stock/workorders/:id', requireWorkOrders, (req, res) => {
    noStore(res);
    const out = stock.forWorkOrder(tenantOf(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    res.json(out);
  });

  app.post('/api/stock/workorders/:id/reserve', requireJson, requireWorkOrders, (req, res) => {
    const out = stock.forWorkOrder(tenantOf(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    stock.syncWorkOrder(tenantOf(req), req.params.id);
    res.json(stock.forWorkOrder(tenantOf(req), req.params.id));
  });

  app.post('/api/stock/workorders/:id/issue', requireJson, requireWorkOrders, (req, res) => {
    const out = stock.issue(tenantOf(req), req.user, req.params.id, req.body?.lines, req.body?.note);
    if (out.error === 'not_found') return notFound(res, 'Werkorder');
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_afgeboekt', { workOrderId: req.params.id, lines: out.booked });
    res.json(out.stock);
  });
}


module.exports = { registerStockRoutes };
