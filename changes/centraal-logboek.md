---
titel: Centraal logboek voor fouten en traagheid
---

## Nieuws
- [beheer] Fouten, trage verzoeken en storingen worden nu bewaard in een centraal logboek (zoeken en bekijken in Beheer volgt). Elke foutmelding noemt ook een verzoek-id, zodat de beheerder precies kan terugvinden wat er gebeurde.

## Changelog
Centraal applicatielogboek, deel 1 (`platform/app-log.js`, migratie 82 `app_logs`): gebufferd schrijven (2 s of 50 regels), herhalingen samengevoegd, max. 600 regels per bron per minuut, harde grens van 100.000 regels per omgeving, redactie van geheimen, e-mailadressen en IBAN. Request-id per verzoek (kop `X-Request-Id`, ook in de 500-melding). Bronnen: 500-fouten (met foutcode), trage verzoeken, stilstand, trage en mislukte taken, bewakingsincidenten. Bewaartermijn via instellingen `logRetentionDays` (14) en `logErrorRetentionDays` (30), uurlijks opgeruimd in het onderhoud.
