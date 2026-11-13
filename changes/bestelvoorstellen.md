---
titel: Automatische bestelvoorstellen
---

## Nieuws
- Zakt een artikel onder de minimumvoorraad, dan zet AquaTech elk uur per voorkeursleverancier een concept-inkooporder klaar. Je ziet ze onder Inkoop > Bestelvoorstel, met een label Voorstel bij de Inkooporders. Er wordt nooit iets besteld zonder jouw goedkeuring: goedkeuren, aanpassen of per artikel op "Niet bestellen" zetten.
- Wat al onderweg is en wat op backorder staat telt mee, zodat niets dubbel wordt besteld. Uitzetten kan in Beheer > Modules > Artikelen: bestelvoorstellen.

## Changelog
`purchase_orders.origin` (`handmatig`|`voorstel`) en tabel `purchase_proposal_dismissals` (migratie in `MIGRATIONS` en `PG_MIGRATIONS`). `purchaseOrders.autoPropose` houdt per voorkeursleverancier één concept met origin `voorstel` bij (één transactie, idempotent, geen nummerverspilling); een aangepast voorstel wordt `handmatig` en telt als onderweg (`incomingByItem` met `excludeProposals`). Routes `/api/purchase-orders/proposals[/refresh|approve|dismiss|restore]`. Instelling `purchaseProposals` {enabled} (standaard aan, per omgeving, geen liveOnly), uurlijkse taak `app.locals.purchaseProposalsAll` in `runMaintenance` en kort na het opstarten; de voorstel-routes horen bij `configuration` van de module Artikelen. Tests: `purchase-proposals*.test.js`, `proposals-core.test.js`, `module-settings.test.js`.
