---
titel: Meerdere leveranciers per artikel met backup
---

## Nieuws
- [voorraad] Een artikel kan meerdere leveranciers hebben met een eigen artikelnummer en inkoopprijs, in volgorde van prioriteit: voorkeur, backup 1, backup 2.
- [voorraad] Per leverancier kun je zetten of het artikel leverbaar is. Is de voorkeursleverancier niet leverbaar, dan bestelt het bestelvoorstel automatisch bij de eerste backup, met het prijsverschil erbij.

## Changelog
- Migratie 88: `item_suppliers.rank` (prioriteit) en `stock_status` (`''` onbekend, `in_stock`, `out`); bestaande koppelingen behouden hun volgorde (voorkeur eerst).
- `suppliers.preferredByItem` kiest de voorkeur of de eerste leverbare backup; `reorderProposal` geeft `backup` {preferredSupplierName, extraPerUnit, extraAmount} en `allSuppliersUnavailable`.
- Inkooporderregels van een backupleverancier tonen `backup` (meerprijs); een ontvangst bij een backup wijzigt de inkoop- en verkoopprijs van het artikel niet (de FIFO-laag houdt de echte prijs).
