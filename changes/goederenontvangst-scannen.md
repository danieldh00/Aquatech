---
titel: Goederen ontvangen met de scanner in de orderpick-app
---

## Nieuws
- [orderpick] In de orderpick-app staat nu naast Picken het tabblad Ontvangen: kies een bestelde inkooporder of scan het ordernummer, de leveranciersreferentie of een artikel, scan de artikelen, bevestig de aantallen en boek de ontvangst. Een deel ontvangen kan ook; de rest blijft open staan.
- [orderpick] Na het ontvangen worden wachtende backorders van webshopbestellingen die nu kunnen worden verzonden meteen weer klaargezet onder Picken.

## Changelog
- Nieuw `artikelen/goods-receipt.js`: `GET /api/orderpick/receipts`, `/receipts/lookup?code=`, `/receipts/:id` en `POST /receipts/:id/receive` (recht `orderpick`, geen prijzen). Boeken via `purchaseOrders.receive` (voorraad + FIFO-laag), daarna backorders vrijgeven via `markBackorderReady`. Per regel `seen` tegen dubbel boeken (409 `changed`), meer dan besteld alleen met `allowOver` (409 `over_received`).
- Frontend: tabblad Ontvangen op `orderpick/` (`receiving-core.js`, `receiving.js`), module `ontvangst` in het moduleregister, route in `configuration.routes` van de module voorraad.
- Tests: `goods-receipt.test.js`, `receiving-core.test.js`.
