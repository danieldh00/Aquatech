# Artikelen, voorraad en inkoop (backend/src/artikelen)

Alleen de regels voor deze map; het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term).

- Voorraad wijzigen alleen via `stock.book` (FIFO-lagen), nooit `on_hand` rechtstreeks. Inkoopontvangst boeken via `purchaseOrders.receive`, nooit `stock.book` zelf.
- Een opslagfunctie die een fout teruggeeft in plaats van gooit, mag binnen `transaction` niets half geschreven hebben: valideer eerst. `transaction` nest niet.
- Verkoopprijs uit inkoopprijs via `PriceFactor.priceFrom`/`roundPrice`; meerdere nieuwe verkoopprijzen via `stock.setSalePrices`. Rangorde: prijsfactor artikel > voorkeursleverancier > diepste categorie > standaard, daarna afronding.
- Nieuwe code die een artikel verwijdert of hoofdartikel maakt wist ook `item_packagings`, leveranciersverwijzingen en `purchase_proposal_dismissals`.
- Etiketten via `ItemLabels.print`, streepjescodes via `Barcode`. EAN is uniek over artikelen én verpakkingen (`eanTaken`).
- Bestelvoorstellen worden nooit automatisch besteld (alleen concepten); goedkeuring = `place`.
- Een nieuwe migratie komt in `MIGRATIONS` (db.js) én `PG_MIGRATIONS` (pgschema.js); controleer het laatste vrije nummer (90+ is gereserveerd).
