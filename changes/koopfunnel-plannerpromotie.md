---
titel: Planner promoten in de webshop
---

## Nieuws
- [beheer] De webshop prijst de gratis planner aan: een blok "Ontwerp je beregening gratis, bestel de complete lijst" op de startpagina en in de beregeningscategorieën. Het blok verdwijnt als je de planner uitzet in de instellingen.

## Changelog
- `plannerPromoMark`/`isIrrigationGroup` in storefront-pages.js (merkteken `<!--planner-promo:…-->` op de startpagina en boven de producten van een hoofdcategorie met "beregening" in naam of adres); `storefront.js` vervangt het door het blok als `shopPlanner` aan staat (zoals het kopje Planner) en haalt het anders weg. De knop leidt naar `planner/` (ingelogd direct door naar de planner). Stijl `.planner-promo` in storefront.css via de `--at-shop-*`-variabelen. Geen migratie; de meting `planner_to_cart` bestond al.
