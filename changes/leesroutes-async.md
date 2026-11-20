---
titel: Offerte-, factuur- en debiteurenlijsten laden sneller bij drukte
---

## Changelog
- Lijstroutes `GET /api/quotes`, `/api/invoices` en `/api/debtors` lezen via `db.async` (pool) met `listAsync`; de query-opbouw is gedeeld met de synchrone `list`, uitkomst ongewijzigd.
