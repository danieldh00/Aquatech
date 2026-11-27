---
titel: Alle lange tabellen met paginering
---

## Nieuws
- Alle lange lijsten tonen nu 25, 50, 100 of 300 regels per pagina met Vorige en Volgende, of alles tegelijk. Je keuze geldt voor alle lijsten en wordt onthouden.

## Changelog
Gedeelde paginering in `shared/pager.js` + `shared/pager.css`. Elke `table.grid` krijgt vanzelf een balk boven en onder (alleen bij meer dan 25 rijen); rijen buiten de pagina krijgen de klasse `pager-off`. Een rij met klasse `sub-item` of `data-pager-join` blijft op de pagina van de rij erboven; `data-no-pager` zet het uit voor een tabel. Een lijst die zelf in porties tekent gebruikt `AquatechPager.attach` (artikellijst en Past bij, die hun eigen kopie hebben vervangen). De keuze staat onder de bestaande sleutel `aquatech_artikelen_paginagrootte`. Verandert het aantal rijen (ander filter of zoekwoord) dan gaat een tabel terug naar pagina 1, anders blijft de pagina staan; bij afdrukken staan alle rijen. `pager.js` en `pager.css` staan op alle pagina's met lijsten; test: `test/pager.test.js`.
