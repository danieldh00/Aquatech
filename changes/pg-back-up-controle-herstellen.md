---
titel: Dagelijkse database-back-up werkt weer
---

## Nieuws
- [beheer] De dagelijkse back-up van de database wordt niet langer ten onrechte afgekeurd. Een servertaak in Beheer > Systeem > Updates installeert de reparatie en maakt meteen een back-up.

## Changelog
`pg-backup.sh`, `restore-test.sh` en `local-db.sh restore` lazen de inhoudsopgave met `openssl … | pg_restore -l | grep` onder `pipefail`. `pg_restore -l` stopt na de inhoudsopgave, waarna openssl "error writing output file" gaf en de hele controle faalde zodra de dump groter was dan de pijpbuffer: elke back-up werd afgekeurd en niet bewaard. De controle ontsleutelt nu eerst het hele bestand en vangt de uitvoer van `pg_restore -l` daarna in een variabele op. Servertaak `004-pg-back-up-script-herstellen` installeert de scripts op apps01 en maakt een back-up. Regressietest in `restore-test-script.test.js` (grote dump, `pg_restore -l` stopt vroeg).
