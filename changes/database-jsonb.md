---
titel: Database: gegevensveld van bestellingen, werkorders, facturen en offertes is JSONB
---

## Nieuws

## Changelog

- Migratie 95: de kolom `data` van `web_orders`, `work_orders`, `invoices` en `quotes` is nu JSONB (gecontroleerde JSON, kleiner in de back-up). De pg-driver geeft de waarde als dezelfde JSON-tekst terug, dus de code verandert niet.
- NUL-tekens in invoer (ook de JSON-schrijfwijze `\u0000`) worden vóór het opslaan weggehaald, omdat JSONB die weigert; een bestelling met zo'n teken in de naam geeft dus geen databasefout meer.
- De controle dat `data` een object is, geldt in migratie 95 ook voor bestaande rijen (niet meer `NOT VALID`).
- De `contentHash` van een nieuw akkoordbewijs van een offerte wordt berekend over JSON met alfabetisch gesorteerde sleutels (`platform/stable-json.js`), omdat JSONB de sleutelvolgorde niet bewaart. Het bewijs is een referentie en wordt nergens opnieuw berekend; herberekenen kan alleen met dezelfde stabiele volgorde.
