---
titel: Voorraadtelling (jaartelling) voorbereid
---

## Nieuws
- [voorraad] De voorraadtelling voor de boekhouding is voorbereid: een telling bevriest de lijst op een peildatum, tellers tellen blind per locatie en afsluiten boekt de verschillen. De schermen volgen.

## Changelog
- Migratie 87: `stock_counts` (nummer `VT<jaar>-NN`, soort jaar of tussentijds, status tellen, afgesloten of geannuleerd; één lopende telling per organisatie, één afgesloten jaartelling per kalenderjaar), `stock_count_lines` (bevroren tellijst met verwachte aantallen, prijs per eenheid en bron: FIFO-gemiddelde, inkoopprijs of onbekend) en `stock_count_entries` (logboek van elke ingave, idempotent op `client_id`).
- `artikelen/stock-counts.js`: starten, blind tellen, hertellen boven een drempel (bedrag of percentage), afsluiten in één transactie met `stock.book` (soort telling, bron `telling:<nummer>`) en verslag. Het verschil wordt gerekend ten opzichte van de stand op het telmoment, dus een pick of ontvangst tijdens het tellen geeft geen vals verschil. Niet-getelde regels vragen een expliciete keuze (als 0 of ongewijzigd).
- Routes: beheer onder `/api/stock-counts` (recht `voorraad`, afsluiten met wachtwoord en limiet), tellen onder `/api/orderpick/counts` (recht `orderpick`, zonder verwachte aantallen of prijzen). Audit `voorraadtelling_*`. Routes staan in `configuration.routes` van de module voorraad.
- Een artikel met telregels wordt gearchiveerd in plaats van verwijderd; testdata bevat een afgesloten en een lopende telling.
