---
titel: Eén zoekveld voor alles
---

## Nieuws
- [offertes, werkorders, facturen, voorraad, klanten] Bovenaan de zijbalk staat nu een zoekveld (sneltoets Ctrl+K of /) dat in één keer klanten, offertes, werkorders, facturen en artikelen doorzoekt, op naam, nummer, adres of artikelcode. Je ziet alleen de soorten waar je het recht voor hebt; een klik opent het item direct.

## Changelog
Globaal zoeken (`platform/global-search.js`, geen migratie): `GET /api/search?q=` (ingelogd, limiet 120 per minuut per gebruiker, `no-store`) zoekt per soort met hetzelfde recht als de module (`klanten`, `offertes` (eigen, of alle met `offertes.alle`), `werkorders`, `facturen`, `voorraad`), filtert altijd op de omgeving van de gebruiker, begrenst elke groep op 5 en geeft alleen titel, omschrijving en een `?id=`-link. Woorden (max. 5) zoeken zonder hoofdletters, `%`/`_` uit de invoer zijn onschadelijk, een exact gelijk nummer staat bovenaan. Frontend: zoekveld met resultatenpaneel in `shared/sidebar.js|.css` (pijltjestoetsen, Enter, Escape, Ctrl+K). Test: `test/global-search.test.js`.
