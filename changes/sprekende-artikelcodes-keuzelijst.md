---
titel: Subartikelen van klein naar groot en oude nummers in de keuzelijst
---

## Nieuws
- [voorraad] In de artikellijst en de keuzelijst (offerte, werkorder) zoek je ook op oude nummers, en subartikelen staan van klein naar groot.
- [voorraad] Het formulier Nieuw voorraadartikel sluit nu bij het wisselen van pagina en blijft niet meer staan.

## Changelog
- `GET /api/stock/articles` geeft `aliases` mee en sorteert subartikelen met `ArticleCode.compareCodes`; de lijst in Artikelen sorteert subartikelen ook zo.
- Artikelen: `showTab` sluit alle formulieren in `#v-forms` bij het wisselen van tabblad.
