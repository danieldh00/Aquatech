---
titel: Logboek in Beheer
---

## Nieuws
- [beheer] Nieuw: Beheer > Systeem > Logboek. Zoek op foutcode of verzoek-id en filter op niveau, bron en periode; exporteren naar Excel kan ook. De bewaartermijn van het logboek stel je in bij Sessies en bewaartermijnen.

## Changelog
Centraal applicatielogboek, deel 2: `GET /api/admin/logs` (`platform/app-log-routes.js`: filters niveau/bron/periode, zoeken op tekst, request-id of foutcode, cursor-paginering; platformregels en een andere omgeving alleen met canPlatform), `appLog.list/sources`, Beheer-sectie Logboek (`beheer/logboek.js`, Excel-export tot 5000 regels) en de instellingen `logRetentionDays`/`logErrorRetentionDays` in het formulier Sessies en bewaartermijnen.
