---
titel: Gasten beter begrensd
---

## Nieuws
- Gasten (zonder account) kunnen in het klantportaal niets meer indienen of bevestigen; daarvoor is een account nodig.

## Changelog
Audit 1.33.0, thema Accounts en toegang, deel 1.
- **B-08**: schrijfroutes van het klantportaal (`/api/portal/requests` aanmaken, foto's toevoegen/verwijderen, intrekken; afspraak bevestigen; factuur betalen/controleren) geven voor een gast 403 `account_required` (`requireAccount` in `service-requests.js` en `portal.js`). Lezen blijft werken.
- **T-11**: het uurlijkse onderhoud ruimt gasten op die 30 dagen niet zijn gezien en geen plan of andere verwijzing hebben (`store.purgeStaleGuests`, hoogstens 200 per ronde; een verwijzing elders laat de gast staan).
- Test: `test/guest-hardening.test.js`.
