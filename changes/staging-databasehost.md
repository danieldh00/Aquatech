---
titel: Staging verbindt met een unieke databasehost
---

## Changelog
- Staging: de app verbindt met `aquatech-staging-postgres` in plaats van `postgres` (die naam heeft in het tunnelnetwerk ook de database van de testomgeving). Na een mislukte build staat ook de bron in `repo/` weer op de draaiende commit.
- `install-staging.sh` en `docs/STAGING.md`: eerst Cloudflare Access instellen en dan pas de hostnaam publiceren; paragraaf "Vertrouwen en grenzen".
