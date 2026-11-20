---
titel: Update-controle zonder 429 voor beheerders
---

## Nieuws
- [beheer] Een handmatige update-controle in Beheer > Systeem > Updates kan nu altijd, praktisch zonder melding over te veel verzoeken.

## Changelog
`POST /api/admin/system-update/check`: limiet per gebruiker van 6 naar 60 per 10 minuten. De route zit achter inloggen en `canUpdate`; een lopende controle wordt hergebruikt (`requestCheck`), dus dubbel klikken geeft 202 zonder tweede aanvraag of auditregel. Starten, intrekken en automatisch aan/uit houden hun limieten.
