---
titel: Webshopsynchronisatie standaard één keer per nacht
---

## Nieuws
- [beheer] De volledige vergelijking met de webshop draait nu standaard één keer per nacht in plaats van elke 10 minuten. In Beheer > Webshop kies je ook elk uur of elke 10 minuten.

## Changelog
`shopSource.syncSchedule` (`night` standaard | `hourly` | `tenmin`, geen migratie). `runAll` slaat een omgeving over tot `fullSyncDue` (webshop/shop-sync.js) aan de beurt is: dagwisseling 04:00 Nederlandse tijd (na de back-up), na een mislukte poging hoogstens elk uur opnieuw. Gewijzigde artikelen gaan nog steeds meteen via `schedule()`. Aanleiding: het logboek van 2026-11-19 toonde elke 10 minuten een "trage taak" van ~165 s met ruim 5300 queries en 2 s stilstand van de hoofdthread.
