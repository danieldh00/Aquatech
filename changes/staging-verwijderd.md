---
titel: Stagingomgeving verwijderd
---

## Changelog
De stagingomgeving op apps01 is niet meer nodig en wordt verwijderd. Nieuw: servertaak `016-staging-verwijderen` (`deploy/apps01/remove-staging.sh`) ruimt de timer, units, de twee stagingcontainers, hun netwerk, de lokaal gebouwde images en `/opt/apps/aquatech-staging` op, zonder de testomgeving of de tunnel aan te raken. Weg uit de repo: `deploy/staging/`, `docs/STAGING.md` en hun test; de servertaken 012, 014 en 015 doen niets meer (de id's blijven). De stagingbalk/noindex-code en het Dockerfile-argument `VUE_MODULES` blijven bestaan.
