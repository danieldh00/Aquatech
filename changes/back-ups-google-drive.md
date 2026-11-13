---
titel: Back-ups automatisch naar Google Drive
---

## Nieuws
- [beheer] Beheer > Back-ups naar Google Drive: elke nieuwe back-up wordt automatisch (versleuteld) naar je eigen Google Drive gekopieerd. Je verbindt eenmalig met Google, kiest de mapnaam en hoeveel back-ups er blijven staan, en ziet daar ook de bestanden op Drive en een logboek. Gaat er iets mis, dan zie je een waarschuwing.

## Changelog
- Nieuw `platform/drive-backup.js`: OAuth2 met Google (scope `drive.file`, offline), hervatbare upload als stroom, opruimen boven het bewaaraantal (op bestandsnaam), logboek en stand in de instelling `backupDriveState`; geheimen versleuteld (`backupDriveClientSecret`, `backupDriveRefreshToken`).
- Routes `GET|PUT /api/admin/backups/drive`, `POST .../connect|disconnect|sync|test`, `GET .../callback` (hoofdbeheerders, audit); `runBackup` en het uurlijkse onderhoud starten de kopie op de achtergrond, na een fout pas na 15 minuten opnieuw.
- Beheer: sectie *Back-ups naar Google Drive* met handleiding, de lijst lokale back-ups toont *op Drive*.
- Tests met een nagebootste Google (`test/helpers/google-fake.js`).
