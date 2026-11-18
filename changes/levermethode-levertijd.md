---
titel: Levermethode en levertijd per artikel
bump: minor
---

## Nieuws
- [beheer, voorraad] Per artikel of productcategorie bepaal je welke bezorgmethodes mogen, met een aantalgrens (bijvoorbeeld vanaf 100 stuks alleen pallet). Een bestelling met artikelen die verschillende methodes vragen gaat met de zwaarste methode (pallet) mee.
- [beheer] Pallet en eigen transport kunnen een aantalstaffel krijgen naast de weegklassen. Per methode stel je de levertijd in, in kalender- of werkdagen.
- De webshop toont een indicatieve levertijd bij het product en bij het afrekenen; is die niet bekend, dan staat er "Levertijd op aanvraag". Een artikel kan een eigen levertijd hebben, en als het niet op voorraad is volgt de levertijd uit de inkooporder of de levertijd van de leverancier.

## Changelog
- Migratie 74: `stock_items.delivery_rules` (JSON), `lead_days_min`/`lead_days_max` en `item_suppliers.lead_days`.
- `webshop/delivery-rules.js`: regels `{ method, minQty, maxQty }` per artikel (variant erft van het hoofdartikel) en per categorie (instelling `deliveryRules`, Beheer > Webshop > Levermethodes, `/api/admin/delivery-rules`); rangorde artikel > hoofdartikel > diepste categorie. `blockedMethods` laat de zwaarste methode een gemengde wagen meenemen; ophalen valt buiten de regels.
- `webshop/delivery-times.js`: levertijd per methode (`leadDays` + `dayType` in `shopShipping`, standaard DPD 1-2 kalenderdagen, pallet 3-5 werkdagen, eigen transport 5-10 werkdagen, ophalen direct), eigen levertijd per artikel, afleiding uit de verwachte datum van een inkooporder of de leverancierstijd; onbekend = "Levertijd op aanvraag". Indicatief; `data.shipping.eta` is een momentopname op de bestelling.
- `shipping.js`: `qtyTiers` per land bij pallet en eigen transport (gaat voor de weegklassen), `quantityOf`, geblokkeerde methodes met reden in `optionsFor`.
- `priceCart` geeft `delivery` (geblokkeerde methodes, levertijd per regel); `shippingQuote` voegt per optie `lead`/`leadText` toe. Productpagina toont de levertijd (`leadInfoOf` in storefront-data.js).
- Tests: `test/delivery.test.js`.
