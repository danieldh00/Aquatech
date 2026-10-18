/*
 * Webshopkoppeling: haalt de artikelen met prijzen uit de webshop van de
 * eigen organisatie op (api/catalog) en legt ze over de standaardcatalogus
 * (Catalog.articles). De interne artikelcode blijft leidend voor de
 * berekening; naam, prijs, sku en link komen uit de webshop. Gebruikt door
 * de planner en de offertes. Zonder server (file://) of zonder koppeling
 * blijft de standaardcatalogus staan.
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
      for (const [code, a] of Object.entries(base)) C.articles[code] = { ...a };
      for (const [code, p] of Object.entries((this.info && this.info.articles) || {})) {
        if (!C.articles[code]) continue;
        C.articles[code] = { ...C.articles[code], name: p.name || C.articles[code].name, price: p.price, sku: p.sku, url: p.url, inStock: p.inStock, shop: true };
      }
    },

    load() {
      if (!this.loading) {
        this.loading = fetch('api/catalog', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((info) => { this.apply(info); return this.info; })
          .catch(() => null);
      }
      return this.loading;
    },
  };

  window.ShopCatalog = Shop;
})();
