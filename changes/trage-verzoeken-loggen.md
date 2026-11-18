---
titel: Pagina's openen niet meer vast tijdens de back-up
---

## Nieuws
- [beheer] De dagelijkse back-up draait voortaan los van de app, zodat pagina's niet meer tientallen seconden kunnen blijven hangen terwijl de database wordt gekopieerd.

## Changelog
- Nieuw `platform/slow-log.js` + `database/query-stats.js`: elk verzoek of elke achtergrondtaak vanaf `SLOW_REQUEST_MS` (standaard 1000) komt als `[traag]` in het log en in een geheugenlogboek (laatste 500 regels, `app.locals.slowLog`). Per regel: duur, methode, genormaliseerd pad (id's, tokens, e-mailadressen en querystring weg), status, omgeving, aantal databasequeries en -tijd (synchrone brug en `db.async`-pool, ook wachten op een pool-verbinding) en externe aanroepen (`fetch`). Geen koppen, lichamen of gebruikersgegevens.
- Stilstandsbewaking van de hoofdthread (`SLOW_STALL_MS`, standaard 1000): een regel `[stilstand]` met de verzoeken en taken die toen liepen.
- Achtergrondtaken (onderhoud, back-up, Drive, bewaking, webshopsynchronisatie, Visma, bestelvoorstellen, herinneringen) worden gemeten.
- Back-up in een eigen proces (`backup.js` `createBackupInChild`, lagere prioriteit): bij PostgreSQL kopieerde `copyDatabase` alle tabellen synchroon in de hoofdthread, waardoor alle verzoeken tot een halve minuut wachtten. Zelfde bestandsformaat en sleutel; tests en `createApp` zonder `backupInChild` blijven in-process.
