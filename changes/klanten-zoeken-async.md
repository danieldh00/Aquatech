---
titel: Klanten zoeken houdt de server niet meer op
---

## Changelog
Doorlichtingspunt 13 (synchrone databasebrug afbouwen), eerste stap: `store.listCustomerPageAsync` voert de totaal- en paginaquery van het klantenoverzicht tegelijk uit via `db.async` (pool bij PostgreSQL). `GET /api/customers`, `GET /api/quote-customers` en `GET /api/workorder-customers` gebruiken die; de hoofdthread staat tijdens de zoekopdracht (LIKE over zes kolommen) niet meer stil. De synchrone `listCustomerPage` blijft voor de AI-koppeling (MCP). Beide delen één querybouwer (`customerPageQueries`).
