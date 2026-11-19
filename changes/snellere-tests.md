---
titel: Snellere en stabielere testsuite
---

## Changelog
- `tableColumns` gebruikt op PostgreSQL `pg_catalog` i.p.v. `information_schema` (±150 ms → ±1 ms per tabel); tenant verwijderen, leegmaken en terugzetten uit back-up wordt daardoor niet trager bij meer tabellen.
- Testrun gebruikt goedkope scrypt-kosten (`AQUATECH_TEST_SCRYPT_N`, via `node --import test/helpers/fast-scrypt.js`); `scryptParams` negeert die variabele in productie en bij niet-machten van twee onder 1024. Productie blijft 2^17.
- Test goods-receipt controleert veldnamen i.p.v. losse tekst ("1.5" kwam toevallig in een tijdstempel voor en maakte de test af en toe rood).
