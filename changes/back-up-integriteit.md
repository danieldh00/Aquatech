---
titel: Back-ups met integriteitscontrole
---

## Nieuws
- [beheer] De dagelijkse database-back-up krijgt een controlebestand (HMAC) ernaast. Terugzetten en de hersteltest weigeren een back-up die gewijzigd of beschadigd is.

## Changelog
Audit B-33 (deel 1), geen migratie, servertaak `010-back-up-integriteitscontrole`:
- `pg-backup.sh` schrijft naast elke `aquatech-*.dump.enc` een `.hmac` (HMAC-SHA256, sleutel afgeleid uit de hoofdsleutel); opruimen verwijdert hem mee.
- `restore-test.sh` en `db-local.sh restore` controleren hem vóór het ontsleutelen: een afwijking is `mislukt`/stopt het terugzetten; een oude dump zonder `.hmac` geeft een opmerking.
- Nog open uit B-33: een vingerafdruk van de hoofdsleutel in Beheer (raakt vault/server.js; apart).
