---
titel: Logboek: herhaalde meldingen als één regel
---

## Nieuws
- [beheer] In het Logboek staat een herhaalde melding (bijvoorbeeld een trage taak of stilstand) nu als één regel met het aantal en de eerste en laatste keer, ook in de Excel-export.

## Changelog
- Migratie 83: `app_logs.first_at`. Herhalingen van de bronnen taak, stilstand en traag werken ook na het wegschrijven de bestaande regel bij (`created_at` = laatste keer, `first_at` = eerste keer, `repeat_count`, langste duur) zolang er binnen een uur een nieuwe komt en de regel jonger is dan 24 uur. Fouten blijven los (eigen foutcode en verzoek-id).
- De stilstandmelding heeft een vaste tekst ("Hoofdthread stond stil"); de duur staat in het veld Duur.
- Excel-export: kolommen *Tijdstip (laatste)* en *Eerste keer*.
