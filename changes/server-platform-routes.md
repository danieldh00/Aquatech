---
titel: Hoofdbeheer-routes in eigen bestand
---

## Changelog
`server.js` opgesplitst (doorlichtingspunt 12, eerste stap): alle routes onder `/api/platform` (tenants, testomgevingen, multitenancy, testdata, gebruikers per organisatie) staan nu in `platform/platform-routes.js` (`registerPlatformRoutes`). Geen wijziging in gedrag; `server.js` is ruim 220 regels korter.
