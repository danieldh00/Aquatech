---
titel: Achtergrondtaken met AI gaan na een herstart vanzelf verder
---

## Nieuws
- [voorraad] Het schrijven van omschrijvingen in bulk en het opzoeken bij Past bij gaan na een herstart van de server (bijvoorbeeld door een update) vanzelf verder met wat nog aan de beurt is. Je hoeft niets opnieuw te starten.
- [beheer] Bij Beheer > Instellingen > AI staan nu de dagplafonds voor omschrijvingen in bulk en voor Past bij opzoeken.

## Changelog
Een lopende achtergrondtaak staat in de nieuwe interne instelling `backgroundJobs` (geen migratie; `artikelen/background-jobs.js`: `createJobPersistence`, `sanitizeBackgroundJobs`). `startJob` in item-text-bulk.js en related-routes.js bewaart hem bij de start en wist hem als de taak klaar of gestopt is. `app.locals.resumeBackgroundJobs` (server.js) hervat bewaarde taken een halve minuut na het opstarten (tijdens een systeemupdate later opnieuw proberen); een bewaarde taak zonder werk wordt opgeruimd. De velden `descriptionBulkDailyItems` en `relatedAiDailyItems` staan in het AI-formulier van Beheer. Test: `item-text-bulk.test.js`.
