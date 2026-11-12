---
titel: Pakbonnen en de lijst Te picken
---

## Nieuws
- [beheer] Nieuw tabblad *Te picken* bij Webshopbestellingen: alle nieuwe bestellingen die klaarstaan, met één knop om alle pakbonnen in één PDF af te drukken.
- [beheer] Elke webshopbestelling heeft een pakbon (PDF, zonder prijzen, met het afleveradres en de artikelen op volgorde van magazijnlocatie). Knop *Pakbon* in het detail van de bestelling.

## Changelog
Nieuw `webshop/packing-slips.js`: `packingSlipsPdf` (eigen PDF-schrijver, één pakbon per bestelling, regels gesorteerd op `stock_items.location`, verpakkingsregels met omrekening naar basiseenheden, opmerking van de klant, Nederlands of Engels volgens `data.language` via `DocText` `packing.*`), `createPackingSlips` (`toPick`, `pdfFor`) en `registerPackingSlipRoutes`: `GET /api/admin/web-orders/to-pick`, `POST /api/admin/web-orders/:id/packing-slip`, `POST /api/admin/web-orders/packing-slips { ids }` (hoogstens 50, geannuleerde bestellingen overgeslagen). Het afdrukken wordt in één transactie vastgelegd (`markPackingSlipsPrinted`) en staat in `data.packingSlip` {printedAt, printedBy, count}. `web-orders.js`: `listToPick` (status nieuw, online alleen betaald), `getMany` (één query) en `pickable`. Het afleveradres is `data.address` (nooit het factuuradres). Frontend: tabblad *Te picken* (`te-picken.js`) en knop *Pakbon* in `bestellingen.js`. Geen migratie.
