---
titel: Offertemails: limiet per ontvanger
---

## Nieuws
- [offertes] Naar één e-mailadres gaan hoogstens 5 offertemails per uur, zodat een klant niet overspoeld wordt.

## Changelog
Offertes versturen (losse mail en bulk) telt per ontvangend e-mailadres mee (`beveiliging/recipient-limit.js`, 5 per uur per organisatie, in het geheugen); daarboven 429 `recipient_limited` bij de losse mail en een overgeslagen regel bij bulk. Bovenop de bestaande limiet per gebruiker.
