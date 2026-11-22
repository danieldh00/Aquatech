---
titel: Beheer: herinneringen en etiketten in eigen bestanden
---

## Nieuws

## Changelog

Opschoning van `frontend/beheer/beheer.js`: de schermen Seizoensherinneringen, Betalingsherinneringen (`beheer/herinneringen.js`) en Etiketsjablonen (`beheer/etiketten.js`) staan nu in eigen bestanden (ruim 160 regels uit beheer.js). `index.html` laadt ze vóór `beheer.js`. Geen gedrag veranderd: in een echte browser vergeleken met de vorige versie (zelfde weergave, toevoegen van een etiketsjabloon werkt, geen consolefouten).
