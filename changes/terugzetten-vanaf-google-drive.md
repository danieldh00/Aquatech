---
titel: Terugzetten vanaf Google Drive
---

## Nieuws
- [beheer] Terugzetten uit een back-up kan nu ook vanaf Google Drive. In Beheer > Systeem > Terugzetten uit back-up staan de back-ups op Drive als aparte groep in de keuzelijst; de app haalt de gekozen back-up eerst op en bewaart hem een kwartier tijdelijk. Verder werkt het hetzelfde: eerst een voorbeeld, wachtwoord ter bevestiging en vooraf een nieuwe back-up.

## Changelog
- `platform/drive-restore-source.js`: back-up van Drive als bron (`drive:<naam>` in het veld `backup` van de restore-routes), tijdelijke kopie in `.drive-restore-cache-*` (15 minuten, opruimen per minuut en bij de start), `DriveError` als leesbare fout in `backup-restore-routes.js`.
- Beheer: keuzelijst met groepen *Op de server* en *Op Google Drive*.
