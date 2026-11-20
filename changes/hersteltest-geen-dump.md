---
titel: Hersteltest maakt zelf een back-up als er geen is
---

## Nieuws
- [beheer] De hersteltest van de back-up meldt nu duidelijk wat er mis is als er geen back-up op de server staat, en laat er eerst zelf één maken.

## Changelog
`restore-test.sh`: ontbreekt `backups/postgres/aquatech-*.dump.enc`, dan draait `pg-backup.sh` eerst (dezelfde dagelijkse back-up) en wordt opnieuw gezocht. Lukt dat niet, dan noemt de melding de oorzaak (map ontbreekt, geen `pg-backup.sh`, of de laatste regels van de mislukte back-up). Test uitgebreid.
