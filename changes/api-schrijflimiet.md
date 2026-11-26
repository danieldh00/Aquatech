---
titel: Bovengrens op schrijfacties
---

## Changelog
Algemene limiet op schrijfacties via `/api` (1200 per 15 minuten per ingelogde gebruiker, anders per bezoeker; `/api/public` en lezen blijven buiten de telling; startwaarde overschrijfbaar met `API_WRITE_LIMIT`, voor tests). Routes met een eigen limiet houden die. Dekt de CodeQL-meldingen "missing rate limiting" op ingelogde routes. Test: `api-write-limit.test.js`.
