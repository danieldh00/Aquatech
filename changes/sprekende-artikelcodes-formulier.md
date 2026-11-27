---
titel: Artikelen: code laten voorstellen en oude nummers zoeken
---

## Nieuws
- [voorraad] Bij een nieuw artikel kies je een soort, diameter en draadmaat en het formulier stelt de code voor (bijvoorbeeld UD.KBI.20.34). Een uitgegeven code verandert niet meer.
- [voorraad] In de artikellijst en de keuzelijst (offerte, werkorder) zoek je ook op oude nummers, en subartikelen staan van klein naar groot.

## Changelog
- Artikel aanmaken en wijzigen: `subGroupId` zet merk en soort; een artikel met een soort houdt zijn code (409 bij wijzigen) en de soort wisselt niet meer.
- Een nieuwe of gewijzigde artikelcode die al een oud nummer van een ander artikel is, wordt geweigerd (409).
- `GET /api/stock` geeft per artikel de oude nummers (`aliases`) mee; de lijst zoekt erop.
- `GET /api/stock/articles` geeft `aliases` mee en sorteert subartikelen met `ArticleCode.compareCodes`; de lijst in Artikelen sorteert subartikelen ook zo.
