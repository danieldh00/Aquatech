/*
 * Webshopkoppeling: haalt de artikelen met prijzen uit de webshop van de
 * eigen organisatie op (api/catalog) en legt ze over de standaardcatalogus
 * (Catalog.articles). De interne artikelcode blijft leidend voor de
 * berekening; naam, prijs, sku en link komen uit de webshop. Gebruikt door
 * de planner en de offertes. Heeft de organisatie een eigen assortiment
 * (voorraadartikelen of gekoppelde producten), dan gebruikt de planner alleen
 * die artikelen (Catalog.setAssortment). Zonder server (file://) of zonder
 * koppeling en artikelen blijft de standaardcatalogus staan.
 *
 * Tegelijk komt de sproeierbibliotheek van de organisatie binnen
 * (api/sprinkler-library, Beheer > Sproeiers): eigen behuizingen en nozzles
 * gaan vóór de webshopprijzen in de catalogus, zodat ook hun prijs uit de
 * webshop kan komen.
 */
(function () {
  'use strict';

  const Catalog = window.Catalog;
  const base = {};
  for (const [code, article] of Object.entries(Catalog.articles)) base[code] = { ...article };

  const Shop = {
    info: null,

    /**
     * Zet webshopgegevens over de standaardartikelen (of herstelt ze).
     * @param {object|null} info Antwoord van api/catalog (articles, assortment, syncedAt, ...).
     */
    apply(info) {
      this.info = info && info.syncedAt ? info : null;
      // Eigen assortiment (voorraadartikelen en gekoppelde webshopproducten):
      // de planner gebruikt dan alleen die artikelen.
      this.assortment = info && Array.isArray(info.assortment) && info.assortment.length ? info.assortment : null;
      this.unknownCodes = (info && info.unknownCodes) || 0;
      if (Catalog.setAssortment) Catalog.setAssortment(this.assortment);
      for (const [code, article] of Object.entries(base)) Catalog.articles[code] = { ...article };
      if (Catalog.libraryArticles) Catalog.libraryArticles();
      // Ook zonder webshop: verkoopprijzen uit voorraadbeheer.
      for (const [code, product] of Object.entries((info && info.articles) || {})) {
        if (!Catalog.articles[code]) continue;
        Catalog.articles[code] = { ...Catalog.articles[code], name: product.name || Catalog.articles[code].name, price: product.price, sku: product.sku, url: product.url, inStock: product.inStock, shop: true };
      }
    },

    /**
     * Haalt de webshopgegevens en de sproeierbibliotheek één keer op en past ze toe.
     * @returns {Promise<object|null>} De gegevens als er webshopprijzen of een eigen assortiment zijn, anders null.
     */
    load() {
      if (!this.loading) {
        /**
         * Haalt JSON op; een fout of geen server geeft null.
         * @param {string} url Relatief adres.
         * @returns {Promise<object|null>} De JSON, of null.
         */
        const json = (url) => fetch(url, { cache: 'no-store' }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
        this.loading = Promise.all([json('api/catalog'), json('api/sprinkler-library')])
          .then(([info, lib]) => {
            this.library = lib;
            if (lib && lib.own && Catalog.setLibrary) Catalog.setLibrary(lib.own);
            this.apply(info);
            return this.info || (this.assortment || (info && Object.keys(info.articles || {}).length) ? info : null);
          });
      }
      return this.loading;
    },
  };

  window.ShopCatalog = Shop;
})();
