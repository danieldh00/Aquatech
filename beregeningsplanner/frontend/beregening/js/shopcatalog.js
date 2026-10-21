/*
 * Webshopkoppeling: haalt de artikelen met prijzen uit de webshop van de
 * eigen organisatie op (api/catalog) en legt ze over de standaardcatalogus
 * (Catalog.articles). De interne artikelcode blijft leidend voor de
 * berekening; naam, prijs, sku en link komen uit de webshop. Gebruikt door
 * de planner en de offertes. Heeft de organisatie een eigen assortiment
 * (voorraadartikelen of gekoppelde producten), dan gebruikt de planner alleen
 * die artikelen (Catalog.setAssortment). Zonder server (file://) of zonder
 * koppeling en artikelen blijft de standaardcatalogus staan.
 */
(function () {
  'use strict';

  const C = window.Catalog;
  const base = {};
  for (const [code, a] of Object.entries(C.articles)) base[code] = { ...a };

  const Shop = {
    info: null,

    /** Zet webshopgegevens over de standaardartikelen (of herstelt ze). */
    apply(info) {
      this.info = info && info.syncedAt ? info : null;
      // Eigen assortiment (voorraadartikelen en gekoppelde webshopproducten):
      // de planner gebruikt dan alleen die artikelen.
      this.assortment = info && Array.isArray(info.assortment) && info.assortment.length ? info.assortment : null;
      this.unknownCodes = (info && info.unknownCodes) || 0;
      if (C.setAssortment) C.setAssortment(this.assortment);
      for (const [code, a] of Object.entries(base)) C.articles[code] = { ...a };
      // Ook zonder webshop: verkoopprijzen uit voorraadbeheer.
      for (const [code, p] of Object.entries((info && info.articles) || {})) {
        if (!C.articles[code]) continue;
        C.articles[code] = { ...C.articles[code], name: p.name || C.articles[code].name, price: p.price, sku: p.sku, url: p.url, inStock: p.inStock, shop: true };
      }
    },

    /** Geeft de gegevens als er webshopprijzen of een eigen assortiment zijn, anders null. */
    load() {
      if (!this.loading) {
        this.loading = fetch('api/catalog', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((info) => { this.apply(info); return this.info || (this.assortment || (info && Object.keys(info.articles || {}).length) ? info : null); })
          .catch(() => null);
      }
      return this.loading;
    },
  };

  window.ShopCatalog = Shop;
})();
