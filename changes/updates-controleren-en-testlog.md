---
titel: Handmatig controleren op updates
---

## Nieuws
- [beheer] In Beheer > Systeem > Updates kun je nu met één klik controleren of er een nieuwe versie klaarstaat.

## Changelog
- Knop *Nu controleren op updates* (`POST /api/admin/system-update/check`, 6 per 10 minuten, audit `update_controle`): de app zet `request.json` met `{"check":true}` klaar; `deploy/apps01/update.sh` haalt dan alleen `:latest` op en werkt `status.json`/`releases.json` bij, zonder te installeren. Het scherm toont `checking` tot de host een nieuwe `checkedAt` heeft. Het hostscript moet hiervoor opnieuw worden ingericht (`setup-app-update.sh`); met het oude script wordt de aanvraag wel gecontroleerd maar als onleesbaar gemeld.
- Testlog: een mislukte of afgeremde login (POST `/api/auth/login`, 400/401/403/429) telt niet meer als `[traag]`; onder `node --test` (of `SLOW_LOG_QUIET=1`) schrijft het trage-verzoekenlog niets naar de console, het logboek in het geheugen blijft.
