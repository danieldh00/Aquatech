# Platform, beveiliging en database (backend/src/platform, beveiliging, database)

Alleen de regels voor deze mappen; bij tegenspraak geldt de root-`CLAUDE.md`. het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term).

- Elke query op een tabel met `tenant_id` filtert daarop (`tenant_id = req.tenantId`); id's uit de URL altijd samen met de tenant opzoeken. `test/tenant-filter.test.js` bewaakt dat. Code die bewust over organisaties heen werkt gebruikt `asSystem`/`pinSystem`.
- SQL werkt in SQLite én PostgreSQL (`lower()`, geen `COLLATE NOCASE`, `?`-parameters, helpers in db.js). Geen `SELECT *`/`t.*`, geen N+1. `db.async` alleen voor losse queries, nooit een transactie.
- Nieuwe migratie: `MIGRATIONS` (db.js) én `PG_MIGRATIONS` (pgschema.js); een nieuwe `WHERE`/`ORDER BY` op een groeiende tabel krijgt een index met `tenant_id` vooraan.
- Geheimen als `type: 'secret'` in settings.js (versleuteld met `vault`), nooit in logs, `audit`-detail of frontend. Een instelling voor een extern systeem krijgt `liveOnly: true`.
- Een fout met oorzaak: `withCause(res, error)`; nooit `error.message` van een interne fout in `message`. Mailfouten via `mailFailure(error)`.
- Een nieuwe module met eigen instellingen of instellings-API vult `configuration` in `modules.js` in. Nieuwe koppelingen krijgen een controle in `createMonitoringChecks`.
- Uitgaande verbindingen naar door een tenant ingevulde hosts via `netguard.publicAddress`. Elk openbaar of duur endpoint krijgt een limiet.
- Een nieuwe feature krijgt testdata in `test-data.js` (`buildTestData`/`seedFeatures`).
