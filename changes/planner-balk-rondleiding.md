---
titel: Planner zonder account: nettere balk en rondleiding
---

## Nieuws
- De balk Tekenen zonder account in de planner is opgeruimd: één groene knop Tekening indienen en daaronder gelijke knoppen Bewaren en Inloggen.
- Nieuwe bezoekers krijgen de eerste keer een korte rondleiding van zes kaarten. Via Hoe werkt het? in de balk open je hem opnieuw.

## Changelog
Balk van de planner zonder account (`app-controle.js`, `app.css`): hoofdknop volle breedte, Bewaren en Inloggen als gelijke omlijnde knoppen met icoon, minimale knophoogte 40 px. Rondleiding in `js/walkthrough.js` (`PlannerTour`): zes kaarten in de bestaande `.help`-overlay, opent vanzelf bij het eerste bezoek (localStorage `aquatech_planner_rondleiding_gezien`), te heropenen via Hoe werkt het?. Geen servercode.
