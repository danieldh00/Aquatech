---
titel: Nieuwe rol Picker voor het magazijn
---

## Nieuws
- [beheer] Nieuwe rol *Picker* voor medewerkers in het magazijn: die mogen alleen bestellingen picken (de orderpick-app volgt) en zien geen prijzen, adressen of instellingen.
- [beheer] Een bestelling die in het magazijn wordt gepickt gaat met de echt gepickte aantallen weg; wat er niet is blijft op backorder staan. De pakbon van die zending toont wat er nu meegaat en wat nog volgt.

## Changelog
Orderpick deel 1: rol en API (geen migratie).

- Recht `orderpick` en standaardrol `picker` (`frontend/shared/roles.js`); de beheerder heeft het recht ook. Testdata krijgt een pickeraccount.
- `webshop/orderpick.js`: `GET /api/orderpick/orders` en `/orders/:id` (regels op magazijnlocatie met `scanCodes` van artikel of verpakking), `POST …/pick` (via `webOrders.ship`, nieuw `expectedShipments` tegen dubbel afmelden), `POST …/shipments/:id/packing-slip` en `…/label`.
- Pakbon per zending: `packingSlips.pdfFor(…, { shipmentId })` met `orderForShipment` (besteld, eerder, nu en backorder van die zending).
- `webshop/shipping-labels.js`: haak voor het DPD-label (`createApp({ shippingLabelProviders })`); zonder koppeling een nette melding.
- Tests: `test/orderpick.test.js`.
