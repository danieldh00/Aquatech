---
titel: SQLite is uit het systeem gehaald
---

## Nieuws
- [beheer] De app draait alleen nog op PostgreSQL. Back-ups hebben een nieuw formaat; oude back-ups (SQLite) kunnen niet meer in de app worden teruggezet.

## Changelog
SQLite is volledig verwijderd; PostgreSQL is de enige database.

- `database/db.js`: geen `node:sqlite`, geen SQLite-migraties (`MIGRATIONS`), geen `openSqlite`/`isPg`-takken. Zonder `DATABASE_URL`/`DATABASE_URL_FILE` start de app niet en meldt dat duidelijk. Nieuwe migraties alleen nog in `PG_MIGRATIONS`.
- Back-ups (`backup.js`, formaatversie 2): alle rijen als gzip-regels JSON uit één leestransactie, versleuteld zoals voorheen (zelfde bestandsnaam en bewaring). Een back-up in het oude SQLite-formaat (versie 1) wordt met een duidelijke melding geweigerd. Terugzetten uit back-up leest het bestand in een tijdelijk schema naast de database (`openScratch`/`dropScratch`) en ruimt dat altijd op. `db-copy.js` is `table-rows.js` geworden; `migrate-to-postgres.js` en `switch-to-supabase.sh` zijn verwijderd.
- De werkthread van pgdb vergeet na een ROLLBACK ook het onthouden schema (search_path wordt door de rollback teruggedraaid).
- `update.sh`: geen SQLite-databasekopie meer; altijd eerst een app-back-up.
- Docker/CI: `docker-compose.yml` heeft een PostgreSQL-container, de smoketests in `ci.yml` en `release.yml` starten er een; de job `test` in CI doet alleen `npm audit` (de tests draaien in `test-postgres`). Tests vereisen `TEST_DATABASE_URL`.
- De ruis `role "root" does not exist` in de PostgreSQL-log van CI kwam van de healthcheck `pg_isready` zonder gebruiker; die gebruikt nu `-U postgres`.
- Docs (README, DOCS, CLAUDE, AGENTS, deploy-README) bijgewerkt.
