---
titel: Hersteltest Google Drive controleert nu ook de app zelf
---

## Nieuws
- [beheer] De hersteltest van de back-up op Google Drive zet de back-up nu ook terug in een tijdelijke database en start daarop een tijdelijke kopie van de app, die inlogt en gegevens ophaalt. Zo is ook de Drive-kopie bewezen bruikbaar. Na het uitrollen: servertaak 007 uitvoeren in Beheer > Systeem > Updates.

## Changelog
De Drive-test haalt de back-up op en vergelijkt hem zoals voorheen; daarna zet `platform/drive-restore-app-check.js` het bestand klaar in `update/request/drive-restore/` voor het hostscript `restore-test-drive.sh` (path-unit `aquatech-restore-test-drive.path`). Dat script start een wegwerpdatabase op een intern netwerk zonder uitgang, zet de hele back-up terug met een eenmalige container van het app-image (`node src/backup.js restore-into`, alleen met `AQUATECH_RESTORE_TEST=1`; `platform/backup-restore-all.js`, `importLines` kreeg de optie `deferForeignKeys`) en draait daarna dezelfde app-controle als de lokale hersteltest. Die controle is verplaatst naar `restore-app-check.sh`, dat beide scripts laden. De uitslag (`update/status/drive-restore-app.json`) komt als extra regels in de lijst van de Drive-test; een mislukte app maakt de run `mislukt`, een stil hostscript een waarschuwing. Servertaak `007-hersteltest-drive-app-controle` installeert alles. Tests: `restore-test-drive-script.test.js`, `drive-restore-app-check.test.js`, `backup-restore-all.test.js`, bijgewerkte `host-tasks.test.js`.
