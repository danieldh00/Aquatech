---
titel: Automatische controle op uitlijning van alle schermen
---

## Changelog
Nieuwe Playwright-layoutcheck in `tests/layout/` (workflow `layout.yml`, draait alleen bij wijzigingen in frontend of webshop-CSS): doorloopt alle app- en shoppagina's voor beheerder, installateur, planner, picker, klant en de shop (bezoeker, klant, medewerker) op 1440 en 375 px op testdata en meldt horizontale overflow, elementen buiten hun container, overlap, tabelcellen die uit hun rij vallen of scheef staan, afgekapte tekst en kaarten van ongelijke hoogte. Lokaal: `TEST_DATABASE_URL=… node tests/layout/layout-check.js`.
