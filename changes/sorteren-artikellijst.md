---
titel: Sorteren in de artikellijst
---

## Nieuws
- [voorraad] In de artikellijst kun je nu op elke kolom sorteren door op de kop te klikken: oplopend, aflopend of weer zoals het was. Een artikelgroep blijft bij zijn subartikelen en je keuze wordt onthouden.

## Changelog
De artikellijst (`data-no-pager`, eigen paginering) sorteert in `artikelen.js` (`STOCK_COLUMNS`, `sortItems`) vóór het pagineren, met `AquatechPager.sortOrder` (getallen op waarde, tekst in Nederlandse volgorde, leeg laatst) en de bewaarde keuze via `storedSort`/`storeSort` uit `shared/pager.js`. Artikelgroepen worden onderling gesorteerd en houden hun subartikelen eronder (ook onderling op dezelfde kolom); de standaardvolgorde blijft de bestaande. `storedSort` en `storeSort` zijn nieuw geëxporteerd.
