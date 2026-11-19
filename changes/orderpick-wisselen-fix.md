---
titel: Orderpick: wisselen tussen Picken en Ontvangen werkt weer
---

## Nieuws
- [orderpick] Van Ontvangen terug naar Picken laat nu alleen het pickscherm zien, in plaats van beide schermen onder elkaar.

## Changelog
Orderpick: `showList` in `orderpick.js` verborg de ontvangstschermen (`#rc-*`) niet, waardoor na Ontvangen → Picken beide lijsten zichtbaar bleven. Nu verbergt het alle andere schermen. Nieuwe test `orderpick-modes.test.js` wisselt meerdere keren heen en weer.
