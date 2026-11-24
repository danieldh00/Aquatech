---
titel: Prijsindicatie en bestellen in de planner zonder account
---

## Nieuws
- [beheer] In de planner zonder account ziet een bezoeker straks een prijsindicatie van het materiaal en kan hij het in één keer in de winkelwagen zetten om te laten bezorgen, of een offerte voor de aanleg aanvragen.

## Changelog
Openbare planner als verkoopkanaal (V-04), deel 1. Nieuwe route `GET /api/public/planner-catalog` (drawings.js; zelfde organisatie, instelling en limiet als tekening indienen) met assortiment en consumentenprijzen uit `registerShopRoutes().publicCatalogOf` (alleen naam, prijs excl. btw, btw-tarief en voorraad). De planner (`shopcatalog.js` `loadPublic`, `app.js` `_publicPriceCard`) toont in stap 6 het totaal incl. btw, de knop *Materiaal bestellen* (bestaand `/winkelwagen/planner`, alleen als bestellen bij de hoofdtenant aan staat) en *Offerte voor aanleg aanvragen* (indienformulier). Tot de route in server.js is aangesloten (`plannerCatalogOf` bij `registerDrawingRoutes`) geeft hij `enabled: false` en blijft de planner zoals hij was. De concept-offerte bij een ingediende tekening volgt apart.
