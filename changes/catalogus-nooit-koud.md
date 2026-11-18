---
titel: Webshop opent ook na een rustig moment snel
---

## Nieuws
- De webshop opent nu ook voor de eerste bezoeker na een rustig moment snel: pagina's wachten niet meer op het opnieuw opbouwen van het assortiment.

## Changelog
- Catalogus (`storefront-data.js`): stale-while-revalidate. Een verlopen catalogus (tot 2 minuten oud) wordt voor pagina's van het assortiment (alleen GET/HEAD, niet winkelwagen, afrekenen, bestellingen, account, groothandel) meteen getoond terwijl `warm` hem op de achtergrond ververst. Alle andere aanroepen van `catalogOf` en elke POST rekenen met een verse catalogus (prijzen, voorraad, klantprijzen); de cache blijft per omgeving en bevat niets klantspecifieks. Zonder `db.async` (SQLite) verandert er niets.
- Databasepool: verbindingen blijven 5 minuten open (`IDLE_MS`, was 10 s), zodat de eerste aanvraag na rust geen nieuwe verbinding hoeft op te bouwen.
