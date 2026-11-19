---
titel: Verkoopprijs volgt de factor automatisch
---

## Nieuws
- [voorraad] De verkoopprijs van artikelen met prijs volgens factor wordt automatisch bijgewerkt bij een nieuwe inkoopprijs of een andere factor. Prijsvoorstellen en goedkeuren zijn vervallen.

## Changelog
- Prijsvoorstellen en de goedkeuringsstap (routes `apply`, `reject`, `reopen`, `price-proposals`, melding in het artikelscherm, taak op het dashboard) zijn verwijderd.
- `stock.repriceItem`/`applyAutoPrices`/`receiptCost`: een nieuwe inkoopprijs (formulier, inkoopprijs toevoegen, ontvangst, inkooporder) of factorwijziging zet de verkoopprijs direct goed; opslaan van de instelling en het uurlijkse onderhoud (`pricesRefreshAll`) rekenen alle artikelen opnieuw (ook oude open voorstellen).
- Auditlog `verkoopprijs_automatisch` met artikel, oud, nieuw en bron. Geen migratie; de tabel `price_proposal_rejections` blijft ongebruikt.
- Bulkwijziging: één UPDATE en één auditschrijfactie per blok van 200 (`store.auditMany`). Een handmatig gewijzigde verkoopprijs bij modus factor (met inkoopprijs) wordt genegeerd en het veld is dan alleen-lezen; het onderhoud slaat de onderhoudsmodus over.
- Webshopsync neemt de prijs van een artikel in de modus factor niet meer over; de audit logt alleen artikelen die de UPDATE echt raakte (RETURNING); een fout in de prijshistorie bij een ontvangst komt in het log.
