---
titel: Staging botst niet meer met de testomgeving
---

## Changelog
De stagingservice heette `aquatech`; Docker zet de servicenaam ook als netwerkalias in het gedeelde tunnelnetwerk, waardoor verkeer naar `http://aquatech:3300` (testomgeving) deels bij de stagingcontainer uitkwam. De services heten nu `aquatech-staging-app` en `aquatech-staging-db`; `install-staging.sh` ruimt containers onder de oude servicenaam op (`retire_old_service`) en een test bewaakt dat elke servicenaam met `aquatech-staging-` begint. Nieuwe servertaak 014 past dit op apps01 toe.
