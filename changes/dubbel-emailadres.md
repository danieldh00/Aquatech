---
titel: Geen dubbel e-mailadres meer
---

## Nieuws
- [beheer] Een e-mailadres kan maar bij één actief account horen. Ook als je een adres op de klantkaart wijzigt of een uitgeschakeld account weer inschakelt, krijg je een duidelijke melding als een ander account het adres al heeft.

## Changelog
- `store.updateAccount`: een contact-e-mailadres dat al bij een ander actief account hoort geeft 409 (`field: email`, hoofdletters en spaties genegeerd); `disabled: false` wordt geweigerd als het adres van het account intussen bij een ander actief account staat.
- `store.createCustomer`: de controle op een dubbel adres staat nu ook binnen de transactie (twee gelijktijdige aanmaken leveren één klant).
- Bestaande controles blijven: Mijn profiel, registratie in de webshop (blijft de duidelijke melding geven, begrensd door de registratielimiet), nieuwe klant en klantkaart. Tests: `duplicate-email.test.js`.
