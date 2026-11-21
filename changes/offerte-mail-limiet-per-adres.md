---
titel: Offertemails: limiet per ontvanger
---

## Nieuws
- [offertes] Binnen één organisatie gaan naar één e-mailadres hoogstens 5 offertemails per uur, zodat een klant niet overspoeld wordt.

## Changelog
Offertes versturen (losse mail en bulk) reserveert per ontvangend e-mailadres vooraf een plek (atomair, dus ook bij parallelle verzoeken) en geeft die terug bij een mislukte verzending (`beveiliging/recipient-limit.js`, 5 per uur per organisatie, in het geheugen); daarboven 429 `recipient_limited` bij de losse mail en een overgeslagen regel bij bulk. Bovenop de bestaande limiet per gebruiker.
