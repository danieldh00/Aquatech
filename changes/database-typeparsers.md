---
titel: Database: typeparsers voor de volgende kolomtypen
---

## Changelog
Stap 1 van `opzet-timestamptz-uuid.md` (database-doorlichting 2026-11-20), geen migratie en geen gedragsverandering: `database/pg-types.js` registreert in de werkthread en de pool dezelfde parsers (BIGINT en NUMERIC als getal, `timestamptz`/`timestamp` als ISO-tekst met milliseconden en Z, `jsonb` als JSON-tekst, `boolean` als 1 of 0). Zo blijft de code gelijk als kolommen in de volgende stappen van type veranderen. Test: `test/pg-types.test.js`.
