---
titel: Nieuwspunt over Uitbesteden alleen voor beheerders
---

## Nieuws

## Changelog
Het nieuwspunt over de tabbladbalk van Uitbesteden (1.28.9) kreeg een doelgroep (`beheer`, `uitbesteden`), waardoor een klant het niet meer ziet en `test/news.test.js` weer slaagt. `checkFragments` in `tools/release-notes.js` weigert voortaan een nieuwspunt zonder doelgroep dat over Beheer → Rollen, Uitbesteden of Planner gaat, zodat dit bij de PR zelf opvalt.
