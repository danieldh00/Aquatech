---
titel: Openbare planner: eigen rekenrij voor tekeningen van bezoekers
---

## Nieuws
- Tekeningen van bezoekers zonder account kunnen de berekening van AI-plannen niet meer ophouden: ze hebben een eigen, kleine rekenrij en worden vooraf op grootte gecontroleerd.

## Changelog
V-04 beschikbaarheid: `plan-runner.js` kent twee rijen (`main`: 2 tegelijk, 20 wachtend voor de AI-koppeling; `lead`: 1 tegelijk, 5 wachtend voor openbare tekeningen), `runPlanTask(methode, args, rij)`. `planWithinLimits` (plan-builder.js) weigert vóór het rekenen een plan met te veel vlakken, hoekpunten, elementen of vreemde coördinaten (de tekening komt wel binnen, zonder concept-offerte). Tests: `plan-builder.test.js`.
