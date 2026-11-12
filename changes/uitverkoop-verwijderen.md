---
titel: Uitverkoop-sectie uit de webshop
---

## Nieuws
- De uitverkoop-sectie op de webshop is verwijderd. De startpagina toont alleen nog de kolommen Beregening en Speciale producten.

## Changelog
- `webshop/shop-content.js`: de standaardkolom *Uitverkoop* is verwijderd uit `DEFAULT_SITE`; een opgeslagen kolom met die kop wordt bij het saneren overgeslagen (`RETIRED_COLUMN_TITLE`), zodat ook bestaande live inhoud geen uitverkoop-sectie meer toont. Geen migratie nodig.
- `frontend/beheer/webshop-inhoud.js`: de legenda van het kolommenblok noemt geen uitverkoop meer.
- Tests (`shop-home.test.js`): sanering van een opgeslagen uitverkoop-kolom en controle dat de startpagina er geen toont.
