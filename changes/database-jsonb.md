---
titel: Database: gegevensveld van bestellingen, werkorders, facturen en offertes is JSONB
---

## Nieuws

## Changelog

- Migratie 95: de kolom `data` van `web_orders`, `work_orders`, `invoices` en `quotes` is nu JSONB (gecontroleerde JSON, kleiner in de back-up). De pg-driver geeft de waarde als dezelfde JSON-tekst terug, dus de code verandert niet.
