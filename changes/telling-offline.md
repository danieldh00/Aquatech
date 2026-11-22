---
titel: Voorraad tellen werkt ook zonder verbinding
---

## Nieuws

- [orderpick] Tellers kunnen in de orderpick-app ook tellen waar geen bereik is: de ingaven wachten op het toestel en worden verstuurd zodra er weer verbinding is.

## Changelog

Offline tellen voor de voorraadtelling: `shared/offline-core.js` cachet `api/orderpick/counts/open` en de blinde regels per locatie (`CACHEABLE`) en zet de ingave `POST api/orderpick/counts/:id/lines/:lineId/count` in de offline wachtrij (`QUEUEABLE`; de ingave heeft een eigen `clientId`). `orderpick/counting.js` haalt alle locaties van de lopende telling alvast op, toont een ingave zonder verbinding als geteld met de aantekening "wacht op verbinding" (bewaard op het toestel, per gebruiker en omgeving) en zet bij het versturen of weggooien de echte stand terug. Afsluiten, hertellen en beheer blijven online. Tests: `offline.test.js` uitgebreid; in een echte browser met de service worker (offline tellen, daarna online: server heeft de ingave, geen consolefouten).
