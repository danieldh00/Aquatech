---
titel: Hostscripts draaien op een zichtbare, vaste commit
---

## Changelog
Audit B-11 (scripts), geen migratie, geen servertaak nodig (het vaste commando haalt servertaken.sh altijd vers op):
- `servertaken.sh openstaand` toont vóór de bevestiging wie de commit maakte, wanneer, de titel en of GitHub de handtekening verifieert.
- `db-local.sh` en `setup-app-update.sh` zetten een branchnaam (standaard `master`) eenmalig om naar een commit en tonen die; alle bestanden van de run komen van die ene commit.
- Het releasetoken zit niet meer in de git-config (workflowwijziging, aparte PR).
