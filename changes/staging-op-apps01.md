---
titel: Stagingomgeving op apps01
---

## Changelog
- De stagingomgeving is een tweede opstelling op apps01 naast de testomgeving (`deploy/staging/`): eigen compose-project, image (op de server gebouwd), database, geheimen en mappen; alleen de server en de bestaande tunnel zijn gedeeld. `install-staging.sh` richt in én werkt bij (volgt `develop`, terugval bij een mislukte commit, verzonnen testdata, timer elke 15 minuten); servertaak `012-staging-op-apps01-inrichten` (vervangt de eerdere stg01-taak) draait het op een vaste commit.
- Vervallen: de VM stg01, de Cloudflare-API-stappen, Mailpit, de systemd-units `aquatech-stg-update.*` en de workflow `staging.yml` (er gaat geen staging-image meer naar GHCR).
