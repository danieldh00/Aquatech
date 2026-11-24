---
titel: Planner zonder account: prijs, bestellen en offerte-lead
---

## Nieuws
- [offertes] Een tekening die iemand zonder account indient, levert nu meteen een concept-offerte op met materiaal en arbeid uit het plan. Je vindt hem in Offertes en verstuurt hem zelf.
- Bezoekers van de planner zonder account zien nu een prijsindicatie van hun materiaal en kunnen het in één keer laten bezorgen via de webshop, of een offerte voor de aanleg aanvragen.

## Changelog
Openbare planner als verkoopkanaal (V-04), deel 2: server.js sluit `plannerCatalogOf` aan bij `registerDrawingRoutes` (`ordering` alleen voor de hoofdtenant met `storefront` en `shopOrdering` aan) en `createLeadQuote`: bij `POST /api/public/drawing` maakt de server met `quoteLinesFromPlan` (zelfde werkthread als de AI-koppeling) een conceptofferte, eigenaar is het gastaccount van de indiener (`submitDrawing` geeft nu `ownerId` terug), zonder klantrecord, met de contactgegevens in `customer` en een interne notitie. Alleen met de module Offertes aan; een fout of een plan zonder regels laat het indienen zelf slagen. Auditregel `tekening_ingediend` bevat `quoteId`, de melding aan het bedrijf noemt het offertenummer. Tests: `public-planner-lead.test.js`.
