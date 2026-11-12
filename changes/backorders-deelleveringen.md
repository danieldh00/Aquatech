---
titel: Backorders en deelleveringen
bump: minor
---

## Nieuws
- [beheer] Webshopbestellingen kunnen nu in delen worden geleverd: per regel zie je besteld, geleverd en backorder, en je verzendt alleen wat er is. Met *Deellevering toestaan* bepaal je per bestelling of een deel alvast mee mag.
- [beheer] Nieuw tabblad Backorders bij Webshopbestellingen met de verwachte leverdatum uit je inkooporders en een Excel-export.
- [beheer] Komt er voorraad binnen voor een backorder, dan staat de bestelling weer in Te picken met een nieuwe pakbon. De pakbon laat zien wat nu wordt geleverd en wat nog volgt.
- De klant krijgt bij een deellevering een mail met wat onderweg is en wat nog op backorder staat, met de verwachte datum.

## Changelog
Backorders en deelleveringen voor webshopbestellingen (geen migratie, alles in `web_orders.data`).

- `webshop/fulfilment.js`: berekende leverstatus per regel (besteld, geleverd, leverbaar, backorder, verwachte datum uit inkoop); de voorraad gaat eerst-besteld-eerst-geleverd over open bestellingen.
- `webOrders.ship` en `POST /api/admin/web-orders/:id/ship`: (deels) verzenden met aantallen per regel (ook bedoeld voor de orderpick-app), `POST .../allow-partial`, `GET .../backorders`.
- `stock.issueOrderPart`: afboeken van een deel en de reservering laten krimpen. Factuur en verzendmail volgen bij de laatste zending; annuleren kan niet meer na een deellevering.
- Te picken toont alleen wat nu kan (`waitingForStock` voor de rest); de pakbon heeft kolommen besteld, eerder geleverd, nu en backorder.
- Na een ontvangst op een inkooporder markeert `markBackorderReady` bestellingen die weer kunnen (`backorderReadyAt`).
- Tests: `test/backorders.test.js`.
