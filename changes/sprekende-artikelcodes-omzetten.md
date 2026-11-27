---
titel: Bestaande artikelen omzetten naar sprekende codes
---

## Nieuws
- [voorraad] Onder Artikelen > Beheer staat Bestaande omzetten: elk bestaand artikel krijgt een voorstel voor soort, diameter, draadmaat en nieuwe code. Je past aan wat niet klopt, vinkt aan en zet om. De oude code blijft als zoeknaam bestaan, en de lijst is als Excel te bewaren.

## Changelog
- `artikelen/code-conversion.js`: `GET /api/stock/code-conversion` (voorstel per artikel zonder soort: soort uit woorden in de naam, diameter en draadmaat uit naam en subartikelwaarden, controle op bezette en dubbele codes) en `POST /api/stock/code-conversion/apply` (hoogstens 1000 regels; wat klopt gaat in één transactie, de rest komt terug met de reden; de oude code wordt een oud nummer). Recht `voorraad`, audit `artikelcodes_omgezet`.
- `stock.findCode` valt terug op een oud nummer (soort `oud`), zodat verwijzingen naar een oude code het omgezette artikel blijven vinden.
- Frontend: tabblad `convert` in Artikelen met zijbalkregel `artikelen-omzetten`.
