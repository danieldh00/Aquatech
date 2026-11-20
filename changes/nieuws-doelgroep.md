---
titel: Nieuwspunt over Uitbesteden alleen voor beheerders
---

## Nieuws

## Changelog
Het nieuwspunt over de tabbladbalk van Uitbesteden (1.28.9) kreeg een doelgroep (`beheer`, `uitbesteden`), waardoor een klant het niet meer ziet en `test/news.test.js` weer slaagt. `checkFragments` in `tools/release-notes.js` weigert voortaan een nieuwspunt zonder doelgroep dat over Beheer → …, of Uitbesteden gaat (de planner niet: die is ook voor klanten), zodat dit bij de PR zelf opvalt.

De PR-bewaker (`tools/release-notes.js`, `audienceOnlyChange`) staat nu een wijziging van `frontend/nieuws/releases.js` toe als alleen de doelgroepen (`for: [...]`) van bestaande punten verschillen met de basisbranch; tekst, versies, datums en nieuwe of verwijderde punten blijven geweigerd. Zo kan een vergeten doelgroep via een gewone PR worden hersteld, zonder label.
