---
titel: Plan uit de AI-koppeling omzetten naar offerte of werkorder
---

## Nieuws
- [plannen, offertes, werkorders] Via Claude of ChatGPT kun je een gemaakt beregeningsplan nu direct omzetten naar een concept-offerte (materiaal, arbeid en voorrijkosten) of een nieuwe werkorder; je controleert alles daarna in AquaTech.

## Changelog
- MCP-tool `plan_omzetten` (scope `plannen.concept`, plus `offertes.concept` of `werkorders.concept`): `quoteLinesFromPlan` in `beregening/plan-builder.js` (werkthread) levert de offerteregels uit `QuoteCore.fromPlan`; de offerte is een concept en hangt alleen aan een goedgekeurd plan, de werkorder krijgt stappen uit de arbeidsregels en materiaal met een bestaande artikelcode. Vraagt terug zonder klant (`ookMetOpenPunten`). Audit `offerte_concept_via_ai`/`werkorder_concept_via_ai`.
- Tests voor `plan_omzetten`, `quoteLinesFromPlan` en de limiet van `plan_details`; DOCS.md noemt nu alle MCP-tools.
