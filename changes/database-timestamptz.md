---
titel: Database: tijdstippen zijn echte tijdstippen
---

## Changelog
Migratie 94 (database-doorlichting 2026-11-20, stap 3 van de opzet): alle 142 kolommen `*_at` (aangemaakt, bijgewerkt, verlopen, enz.) zijn van `TEXT` naar `TIMESTAMPTZ` omgezet. Productiecijfers uit servertaak 006: de grootste tabel is 36 MB (`item_images`), de rest onder 4 MB, dus de omzetting duurt milliseconden. De pg-driver geeft ze terug als dezelfde ISO-tekst (`database/pg-types.js`), de verbinding staat op UTC (`SET TIME ZONE 'UTC'` in werkthread en pool), dus de rest van de code blijft gelijk. Een waarde die geen ISO-tijdstip is wordt NULL (bij NOT NULL: 1970-01-01). `monitor_incidents`: de meldmomenten gebruikten lege tekst voor 'nog niet'; nu NULL (code in `monitoring.js` en testdata aangepast, de cursor `before` wordt eerst gecontroleerd). `ai-usage.js` groepeert per periode met `to_char(... AT TIME ZONE 'UTC')` in plaats van `substr`. Datum- en tijdkolommen zonder `_at` (bijvoorbeeld `invoice_date`, `planned_date`, `start_time`) blijven tekst.
