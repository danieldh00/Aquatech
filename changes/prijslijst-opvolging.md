---
titel: Prijslijst inlezen: gearchiveerde leverancier en atomair verwerken
bump: patch
---

## Nieuws

## Changelog
- Een prijslijst inlezen voor een gearchiveerde leverancier wordt geweigerd (409 `supplier_archived`).
- Per regel worden koppeling en inkoopprijs samen of niet verwerkt (één transactie, `nested`-opties op `setForItem` en `addCostPrice`); de bestaande koppelingen komen uit één query in `priceListContext`.
