---
titel: Wekelijkse hersteltest van de back-up
---

## Nieuws
- [beheer] De server test elke week of de nieuwste back-up echt terug te zetten is, in een aparte wegwerpcontainer. De uitslag staat in Beheer > Systeem > Hersteltest, met de dag en tijd in te stellen en een knop *Nu testen*.
- [beheer] Mislukt de hersteltest, of is hij al meer dan 9 dagen niet gedraaid, dan meldt de bewaking dat.

## Changelog
- `deploy/apps01/restore-test.sh` (+ systemd `aquatech-restore-test.{service,timer,path}`): ontsleutelt de nieuwste `pg_dump` als stroom, zet hem terug in een wegwerp-postgres (zelfde image, `--memory 768m`, `--network none`, geen vaste opslag, altijd opgeruimd) en controleert tabellen, schemaversie, rijtellingen (marge) en sanity-queries; schrijft `update/status/restore-test.json`.
- Servertaak `002-hersteltest-back-up-inrichten` installeert script en units (`SYSTEMD_DIR` overschrijfbaar voor tests).
- `platform/restore-test.js` + `restore-test-routes.js` (`/api/admin/restore-test`, `canUpdate`, audit `hersteltest_ingesteld|aangevraagd`), instelling en *Nu testen* via `update/request/`; bewakingscontrole `hersteltest` in `monitoring-checks.js`.
- Beheer > Systeem > Hersteltest (`beheer/hersteltest.js`): laatste uitslag, planning, historie en Excel-export. `system-update.js` exporteert zijn bestandshulpjes.
- Tests: `restore-test-script.test.js` (nep-docker), `restore-test-routes.test.js`, `host-tasks.test.js` aangepast voor meerdere taken.
