---
titel: Servertaken als afvinklijst
---

## Nieuws
- [beheer] Commando's die op de server uitgevoerd moeten worden staan nu in Beheer > Systeem > Updates als afvinklijst, met één vast commando en een kopieerknop. Het dashboard toont wat nog openstaat.

## Changelog
Servertaken (`platform/host-tasks.js`, `host-tasks-routes.js`, `GET|PUT /api/admin/host-tasks`, alleen `canUpdate`): lijst `HOST_TASKS`, afvinken door de server via `update/status/host-tasks.json` of met de hand (instelling `hostTasks`). `servertaken.sh openstaand` voert open taken uit op een vaste commit (`TASKS_REF`) en legt ze vast; `setup-app-update.sh` accepteert `SETUP_REF`. Eerste taak: updaten vanuit de app opnieuw inrichten. Geen migratie.
