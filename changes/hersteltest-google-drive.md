---
titel: Hersteltest voor de back-up op Google Drive
---

## Nieuws
- [beheer] Nieuw in Beheer > Systeem: *Hersteltest Google Drive*. Elke week haalt de app de nieuwste back-up van Google Drive op, zet hem tijdelijk terug naast de database en vergelijkt hem met de echte gegevens. Zo weet je zeker dat de kopie op Drive ook echt bruikbaar is. Dit staat los van de hersteltest van de lokale back-up.
- [beheer] De lokale hersteltest maakt zelf een back-up als er nog geen is, en geeft duidelijker aan wat er mis is.

## Changelog
- `platform/drive-restore-test.js` (+ routes `/api/admin/restore-test-drive`, instelling `driveRestoreTest`, bewakingscontrole `hersteltest-drive`): Drive-back-up ophalen als stroom (`driveBackup.download`), `openBackup` in een tijdelijk schema, vergelijken met de actieve database, altijd opruimen; planning via de uurlijkse onderhoudsronde.
- Beheer: `hersteltest.js` is nu een fabriek voor beide schermen.
- `restore-test.sh`: minimaal 1 s wachttijd bij het wachten op een lopende back-up, duidelijker melding bij een afgebroken `pg-backup.sh`.
