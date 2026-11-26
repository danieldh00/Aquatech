---
titel: Orderhistorie uit WordPress voor Vaak samen besteld
---

## Nieuws
- [voorraad] Vaak samen besteld is meteen gevuld: onder Artikelen > Past bij haal je de orders van de oude WordPress-webshop op. Ze worden aan je artikelen gekoppeld, ook aan varianten van samengevoegde producten, en daarna werkt AquaTech Hub ze elk uur zelf bij. Er gaat niets terug naar WordPress en het zijn geen echte bestellingen (geen voorraad, factuur of mail, niet in omzet of marge).

## Changelog
- Migratie 100: `wp_order_lines` (orderhistorie, uniek per WP-bestelling en regel) en `wp_order_import` (stand per omgeving).
- `webshop/wp-order-history.js`: serverjob die via `fetchOrders` (alleen GET, alle statussen, filter op afgerond en in behandeling) de regels wegschrijft en koppelt: variatie-id, product-id, oud product-id uit `stock_merges`, SKU, `shop_products`, unieke naam. Idempotent; handmatige koppelingen blijven staan.
- Routes `/api/stock/related/wp-orders` (stand, start, stop, link), recht `voorraad`; paneel in Artikelen > Past bij met lijst van producten zonder artikel.
- `refreshTogether` neemt de gekoppelde WP-regels mee (bestelnummers met voorvoegsel `wp:`); het uurlijkse onderhoud haalt eerst de WP-orders op en berekent daarna Vaak samen besteld.
