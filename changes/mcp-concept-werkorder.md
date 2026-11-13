---
titel: Concept-werkorder via de AI-koppeling
---

## Nieuws
- [werkorders] Via Claude of ChatGPT kun je nu een werkorder laten klaarzetten, bijvoorbeeld voor onderhoud of een reparatie. Hij staat als Nieuw klaar, zonder planning en zonder uitvoerder; jij plant hem zelf in. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.

## Changelog
- MCP-tool `maak_concept_werkorder` met nieuwe scope `werkorders.concept` (recht `werkorders`): werkorder zonder offerte via `workorders.createReceived`, status `open`, klant en adres uit de klantkaart, stappen met uren en materiaal (reserveert voorraad via `onWorkOrderChange`). Onbekend artikel, variant of ontbrekende klant geeft status `terugvragen` zonder iets aan te maken (`ookMetOpenPunten` gaat bewust door; de open punten komen in de interne notitie). Limieten 20 per uur en 100 per dag per gebruiker, audit `werkorder_concept_via_ai`.
- Bestaande koppelingen moeten opnieuw worden gekoppeld om de nieuwe scope te krijgen.
