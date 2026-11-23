---
titel: Veiliger terugvallen na een mislukte update
---

## Nieuws
- [beheer] Mislukt een update en moet de vorige versie terug, dan start die niet meer stilletjes op een nieuwere database. Je krijgt de melding dat een back-up hersteld moet worden.

## Changelog
Audit T-07, geen migratie:
- `migratePg` weigert een schemaversie die hoger is dan de code kent (`database nieuwer dan de code`); `AQUATECH_ALLOW_NEWER_SCHEMA=1` slaat dat bewust over.
- `update.sh` herkent die melding na een mislukte terugval en meldt "Database nieuwer dan versie X: herstel uit back-up nodig" in plaats van een algemene fout. Geldt vanaf de eerste versie die deze controle bevat (een oudere vorige versie kent hem nog niet).
