---
titel: Beregeningsplan maken via de AI-koppeling
---

## Nieuws
- [plannen] Geef Claude of ChatGPT een tekening of foto van de tuin: de AI leest de vlakken af en AquaTech maakt er een beregeningsplan van met sproeiers, zones en een stuklijst met jouw prijzen. Je krijgt een verslag met aandachtspunten om in de chat na te kijken en bij te sturen; het plan staat als concept in de Beregeningsplanner. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.

## Changelog
- MCP-tools `plan_maken` en `plan_details` met nieuwe scope `plannen.concept` (recht `plannen`). Nieuwe `beregening/plan-builder.js` laat de plannerkern in een sandbox draaien met assortiment, prijzen en eigen sproeiers van de omgeving; vlakken in meters in, plan als concept uit. Terugvragen bij ontbrekende druk en debiet, bijsturen via `planId`, alleen eigen plannen. Limiet 10 plannen per uur, audit `plan_via_ai`. `registerShopRoutes` geeft `catalogOf` terug.
