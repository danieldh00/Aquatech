---
titel: Oude artikelnummers vindbaar in de shop en de AI-koppeling
---

## Nieuws
- [voorraad] Een artikel dat een nieuwe sprekende code kreeg, is in de webshop en via de AI-koppeling ook nog te vinden op zijn oude nummer.

## Changelog
Oude nummers (`item_aliases`) staan in de zoekindex van de webshop (`storefront-data.js` levert `aliases` aan artikel en subartikel, `search.js` neemt ze mee in de zoektekst) en in `searchArticles` van de MCP-server (`zoek_artikelen`). De keuzelijsten en de voorraadlijst deden dat al; `stock.findCode` valt terug op een oud nummer. Eigen Code128 zonder EAN (`Barcode.forItem`) en de volgorde klein naar groot (`ArticleCode.compareCodes`) bestonden al. Geen migratie.
