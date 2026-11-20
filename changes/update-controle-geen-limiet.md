---
titel: Update-controle zonder limiet voor beheerders
---

## Nieuws
- [beheer] Een handmatige update-controle in Beheer > Systeem > Updates kan nu altijd, zonder melding over te veel verzoeken.

## Changelog
`POST /api/admin/system-update/check` heeft geen snelheidslimiet meer (was 6 per 10 minuten per gebruiker). De route zit achter inloggen en `canUpdate`; een lopende controle wordt hergebruikt (`requestCheck`), dus dubbel klikken geeft 202 zonder tweede aanvraag of auditregel. Starten, intrekken en automatisch aan/uit houden hun limieten.
