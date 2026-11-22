---
titel: Beregeningsplanner: controle en indienen in een eigen bestand
---

## Nieuws

## Changelog

Opschoning van `frontend/beregening/js/app.js` (2582 regels): het blok Controle en indienen (controlebalk, tekening indienen, goedkeuren en het leren van een herkenning, ruim 280 regels) staat nu in `beregening/js/app-controle.js`, dat de methoden op `App` zet (`Object.assign`). `app.js` geeft de gedeelde hulpmiddelen mee via `App.helpers`; `index.html` laadt `app-controle.js` na `app.js`. Geen gedrag veranderd: in een echte browser vergeleken met de vorige versie (zelfde methoden aanwezig, planner en tekenen-zonder-account laden zonder consolefouten).
