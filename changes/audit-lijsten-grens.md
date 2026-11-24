---
titel: Lange lijsten blijven snel
---

## Nieuws
- [offertes, werkorders, facturen] Bij heel veel gegevens toont een lijst de nieuwste en meldt dat er meer zijn, zodat de pagina snel blijft.

## Changelog
Auditthema 4 (1.33.0), T-05:
- Nieuw `platform/list-paging.js`: harde bovengrens (`LIST_LIMIT` 2000), `?limit` en `?offset`, antwoord met `total` en `truncated`.
- `GET /api/quotes` en `GET /api/workorders` lezen een pagina (`listPage`, telquery alleen als de pagina vol is of niet vooraan begint); de klantlijsten in het portaal hebben dezelfde bovengrens.
- `GET /api/invoices` meldt `total` en `truncated` bij de bestaande grens van 1000 (voorheen stil afgekapt).
- `AquatechCommon.truncationNotice` toont kort een melding in de lijsten van offertes, werkorders en facturen als de lijst is ingekort.
- Bewust niet gedaan: `location_key` en `name_key` als kolom met index voor de dossiers; de sleutel is een hash van een in JavaScript genormaliseerd adres of naam, wat een migratie (alleen SQL) niet kan vullen zonder het gedrag te veranderen. De dossierquery's lezen alleen id en adres/naam (geen data), dus de kosten blijven klein.
- Test: `test/list-paging.test.js`.
