---
titel: Mail via Microsoft Graph versturen na automatisch instellen
---

## Nieuws
- [beheer] Mailen via Microsoft Graph lukt nu ook direct na het instellen: een net verleende machtiging werd soms nog niet herkend. De foutmeldingen noemen nu de gebruikte afzender en dat een nieuwe machtiging tot ongeveer 15 minuten kan duren.

## Changelog
- `mail-graph.js`: een onthouden token bevat de machtigingen van het moment van opvragen. Bij 401/403 op `sendMail` met een onthouden token wordt één keer een vers token opgehaald en opnieuw verstuurd (geen herhaling bij een vers token). `EGRAPH_DENIED` en `EGRAPH_MAILBOX` dragen het afzenderadres (geen geheim) mee.
- `mailer.js` (`mailFailure`): melding noemt de afzender, de wachttijd van een nieuwe machtiging en dat een alias niet werkt als afzender.
