---
titel: PDF-knop in Mijn portaal netjes op de rij
---

## Nieuws
- [portaal] In Mijn portaal staat de PDF-knop van een factuur weer op één lijn met de rest van de rij.

## Changelog
`td.actions` in de factuurtabel van het portaal erfde `display: flex` van `.card .actions` en viel daardoor uit de tabellay-out; nu `display: table-cell` met verticale uitlijning in het midden.
