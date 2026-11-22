---
titel: Facturen: Visma-scherm in een eigen bestand
---

## Nieuws

## Changelog

Opschoning van `frontend/facturen/facturen.js` (1514 regels): het Visma-scherm (verbinden, app-gegevens, bediening, overzicht en logboek, ruim 350 regels) staat nu in `facturen/visma.js` als fabriek `window.Facturen.createVisma(context)`; `facturen.js` geeft de gedeelde hulpfuncties en de stand mee en gebruikt `loadVisma`, `setupVisma` en `vismaReturn`. De pagina laadt `visma.js` vóór `facturen.js`. Geen gedrag veranderd: dezelfde weergave en dezelfde API-aanroepen (handmatig vergeleken met de vorige versie in een echte browser: Visma-tabblad zonder fouten).
