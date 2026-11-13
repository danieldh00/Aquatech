---
titel: Terugzetten uit een back-up (deels of per record)
---

## Nieuws
- [beheer] Beheer > Terugzetten uit back-up: open een back-up (alleen lezen), zoek een offerte, werkorder, factuur, bestelling, inkooporder, artikel, leverancier, klant of tuinplan en zet hem terug, helemaal of alleen de velden die je kiest. Je ziet eerst precies wat er verandert, en vóór het terugzetten wordt automatisch een nieuwe back-up gemaakt. Je bevestigt met je wachtwoord.

## Changelog
- Nieuw `platform/backup-restore.js`: back-up ontsleuteld alleen-lezen openen (tijdelijk bestand, daarna gewist), records zoeken met status ontbreekt/gewijzigd/gelijk, voorbeeld met verschillen per veld (ook per JSON-sleutel, bijv. `data.lines`), terugzetten in één transactie; ontbrekende records komen terug met hun onderliggende regels (uren, materiaal, foto's, orderpakbonnen, inkoopregels, verpakkingen, leveranciers).
- Veiligheid: alleen binnen de eigen organisatie, nooit `tenant_id`, wachtwoordhashes, 2FA, deellinks, voorraadstand of webshopsynchronisatie; definitieve facturen, bestellingen, inkooporders en geaccepteerde offertes worden niet overschreven; ontbrekende ouder of dubbel nummer = geblokkeerd.
- Routes `/api/admin/backups/restore/{kinds,records,preview,apply}` (hoofdbeheerders, limieten, wachtwoord, veiligheidsback-up, audit `backup_teruggezet`).
- Beheer: sectie *Terugzetten uit back-up*. Tests op SQLite en PostgreSQL (`test/backup-restore.test.js`).
