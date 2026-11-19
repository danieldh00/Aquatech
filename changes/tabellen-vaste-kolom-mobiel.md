---
titel: Tabellen op mobiel houden de artikelkolom in beeld
---

## Nieuws
- Op een telefoon blijft in alle tabellen de eerste kolom (artikel, nummer of naam) links staan als je de rest opzij schuift, zodat je altijd ziet om welk item het gaat.

## Changelog
Gedeelde oplossing in `shared/brand.css` (onder 700 px): in elke `.tablewrap`-tabel is de identificerende kolom sticky (de eerste, of de tweede als de eerste een selectievakje heeft), compact (max. 46vw/190 px, omschrijvingen wrappen) en met opake achtergrond en schaduw. `AquatechCommon.wrapWideTables` (`shared/common.js`) zet tabellen die buiten een `.tablewrap` te breed worden (planner, klantdossier, back-up terugzetten, enz.) in een scrollbare wikkel. Desktop ongewijzigd; geen migratie.
