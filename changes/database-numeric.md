---
titel: Database: geldbedragen en hoeveelheden exact opgeslagen
---

## Nieuws

## Changelog
Migratie 91 (database-doorlichting 2026-11-20): 46 kolommen van `DOUBLE PRECISION` naar `NUMERIC`: bedragen en betalingen `NUMERIC(14,2)` (facturen, offertes, bestellingen, betalingen, omzetregels, uitbestedingsvergoeding), prijzen en kostprijzen `NUMERIC(14,4)`, hoeveelheden en standen `NUMERIC(14,4)`, prijsfactor, groothandelskorting en inhoud per eenheid `NUMERIC(10,4)`. Bestaande waarden worden bij de omzetting afgerond op het aantal decimalen. De databaselaag las NUMERIC al als getal (`pgdb-worker.js`, `pg-pool.js`), dus de code is ongewijzigd; de volledige testsuite is groen.
