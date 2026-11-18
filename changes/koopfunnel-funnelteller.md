---
titel: Eigen koopfunnelteller in de webshop
---

## Nieuws
- [beheer] Webshopbestellingen heeft een tabblad Funnel: hoe vaak bezoekers een productpagina bekeken, iets in de winkelwagen legden, afrekenen openden, bestelden en online betaalden, met het aandeel ten opzichte van de vorige stap, per periode (7, 30, 90 dagen of 12 maanden) en met Excel-export. Het zijn aantallen, geen unieke bezoekers, en er wordt nooit bewaard wie het was.

## Changelog
- Migratie 78 `shop_funnel_days` (omgeving, dag, stap, teller; geen persoonsgegevens; na 400 dagen gewist via het uurlijkse onderhoud). `webshop/funnel.js` (`createFunnel`: `count`, `flush`, `report`, `purgeOld`): tellers in het geheugen, elke minuut en bij elk overzicht in één transactie naar de database, dus een warme shoppagina kost nog steeds 0 queries. Stappen `product`, `cart_add`, `cart`, `checkout`, `order`, `paid` en daarnaast `checkout_login` en `signup`; medewerkers, voorbeelden (`?voorbeeld=1`) en robots (`looksLikeBot`) tellen niet mee. Dag in Nederlandse tijd.
- `GET /api/admin/shop-funnel?days=` (Beheer). Tabblad Funnel in `frontend/webshop-bestellingen/funnel.js`. `shop_funnel_days` staat met reden in `NO_TESTDATA` (alleen echte bezoekers).
