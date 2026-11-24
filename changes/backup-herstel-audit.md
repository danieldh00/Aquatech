---
titel: Back-up en herstel veiliger
---

## Nieuws
- [beheer] Een back-up verwijderen en de koppeling met Google Drive verbreken of opnieuw koppelen vragen nu je wachtwoord, net als terugzetten. De nieuwste back-up kan niet meer handmatig worden verwijderd.
- [beheer] Bewaking meldt als de databaseafscherming per organisatie uitstaat en als een back-up handmatig is verwijderd.
- [beheer] Terugzetten uit een back-up is sneller: een geopende back-up blijft vijf minuten bewaard in plaats van bij elke stap opnieuw te worden ingelezen.

## Changelog
Audit 1.33.0, thema Back-up/herstel:
- B-01: een back-up wordt in één stroom gecomprimeerd en versleuteld (geen onversleutelde `.tmp-*.db` meer); het ontsleutelde tussenbestand van terugzetten wordt direct na het inlezen gewist; het uurlijkse onderhoud (en de start) wist resten ouder dan een uur (`backup.js` `sweepLeftovers`) en tijdelijke schema's `aqt_scratch_*` (`pgdb.js` `dropStaleScratch`, aanmaaktijd in de schemanaam).
- B-17: `platform/identity-confirm.js` (herbevestiging, gedeeld met terugzetten) voor back-up verwijderen, Drive verbreken/koppelen en de Drive-kopie uitzetten; de nieuwste back-up is niet handmatig te wissen; Bewaking-controle `backup-verwijderd` (24 uur, uit het auditlog); frontend `beheer/reauth.js`.
- B-27: Bewaking-controle `tenantafscherming` (fout bij multitenancy, anders waarschuwing).
- T-09: `platform/backup-open-cache.js` bewaart een geopende back-up vijf minuten (teller, verlooptijd, opruimen).
