---
titel: Server en toegangscode aangescherpt
---

## Nieuws
- Met de toegangscode kun je weer inloggen als iemand anders eerder de gezamenlijke pogingengrens vol deed.

## Changelog
Audit 1.33.0, thema Accounts en toegang, deel 3.
- **B-26**: de ruime JSON-limieten (>= 512 kB) staan achter `gatedJson`: wie geen sessie heeft (en als gasten uit staan) krijgt de standaardlimiet van 16 kB, zodat een anonieme bezoeker de server niet herhaald megabytes laat inlezen. Openbare routes (`/api/public/*`) houden hun eigen limiet.
- **B-21**: inloggen met de toegangscode telt mislukte pogingen per bezoeker (10) naast de gezamenlijke grens (30); is alleen de gezamenlijke grens bereikt, dan mag een bezoeker zonder eigen mislukte poging nog proberen.
- **T-14**: `platform/process-guard.js`: `unhandledRejection` wordt gelogd (console + applicatielogboek, bron `proces`) en geteld voor Bewaking; `uncaughtException` doet hetzelfde en stopt het proces gecontroleerd (logboek wegschrijven, server sluiten, exit 1).
- **B-18**: `POST /api/plan/learn` met een `recognitionId` telt alleen mee voor de gebruiker die de herkenning liet doen, en de som van alle tellingen is begrensd op 1.000.000 (het aantal pixels van de werkresolutie).
- Tests: `process-guard.test.js`, `hardening.test.js`, `plan.test.js`.
