---
titel: Noodherstel uit de Google Drive-back-up
---

## Nieuws
- [beheer] Gaat de server verloren, dan is de hele database terug te zetten uit de back-up op Google Drive. Het draaiboek staat in de serverdocumentatie en het terugzetten wordt elke week al getest.

## Changelog
Auditpunt T-01 (1.33.0): ondersteund, getest volledig herstel vanaf de Drive-kopie.
- `node src/backup.js noodherstel <back-up.db.enc>` (`restoreAll({ emergency: true })`, schakelaar `AQUATECH_EMERGENCY_RESTORE=1`): zet de hele app-back-up terug in een lege database, alles of niets; weigert zodra `users`, `quotes`, `work_orders`, `invoices`, `web_orders` of `plans` al rijen hebben.
- `pve/db-local.sh restore-app <bestand>` / `localdb/local-db.sh restore-app`: richt de eigen PostgreSQL in op een nieuwe server (`provision_local_db`, nu gedeeld met `migrate`), zet het terugzetten in een eenmalige app-container en start de app pas na een geslaagd herstel.
- Draaiboek in `deploy/apps01/README.md` (hoofdsleutel uit de wachtwoordkluis, back-up met de hand uit Drive). Tests in `backup-restore-all.test.js` en `deploy-localdb.test.js`; het terugzetten deelt `restoreAll` met de wekelijkse Drive-hersteltest.
