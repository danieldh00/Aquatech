---
titel: Reden per overgeslagen webshopartikel
---

## Nieuws
- [voorraad] *Ontbrekende uit webshop toevoegen* toont nu per overgeslagen artikel waarom het niet is toegevoegd (code bestaat al, ongeldige of te lange code, hoofdproduct ontbreekt). Het venster telt de redenen en de Excel heeft een tabblad *Overgeslagen* met sku, voorgestelde code, omschrijving, reden en webshopadres.

## Changelog
- `stock.addMissingShop` geeft naast `skippedProducts` de lijst `skippedList` ({ productId, sku, code, name, reason, url }) terug en meldt hem als voortgangsstap `overgeslagen`; de taak bewaart hem als `skippedItems` (max. 3000). Reden bij een bestaande code noemt het artikel dat de code al heeft. Geen wijziging in welke producten worden toegevoegd.
- Frontend: samenvatting per reden in het venster en tabblad *Overgeslagen* in de Excel (`artikelen/shop-missing.js`).
