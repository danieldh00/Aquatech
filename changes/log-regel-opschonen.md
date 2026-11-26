---
titel: Foutlog beter beschermd
---

## Changelog
Het foutlog (`createErrorReport`) geeft regel en detail als `%s`-argumenten aan `console.error` (geen formaattekst uit invoer) en `requestPath` haalt stuurtekens uit het pad (CodeQL: externally-controlled format string, log injection). De Mollie-webhookmeldingen blijven ongewijzigd: het betalings-id is al gecontroleerd op `^tr_[A-Za-z0-9]{4,40}$`.
