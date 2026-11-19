---
titel: Offertes in bulk mailen
---

## Nieuws
- [offertes] In het offerteoverzicht kun je meerdere offertes aanvinken en in één keer per e-mail versturen. Elke klant krijgt het standaardbericht met de link; vooraf zie je het aantal en offertes zonder e-mailadres worden overgeslagen.

## Changelog
`POST /api/quotes-bulk/send` ({ ids (max. 10), url }, recht `offertes`, 10 verzoeken per uur per gebruiker, mailserver vereist): per offerte dezelfde stappen als `POST /api/quotes/:id/send` (link maken, mail via `mailBody`, `markSent`, audit `offerte_verstuurd` met `via: 'bulk'`) met het standaardbericht in de documenttaal van de offerte, gericht aan `customer.email`. Bij een mailfout wordt een concept weer teruggezet (link ingetrokken). Beantwoorde, omgezette en afgesloten offertes, onbekende id's en offertes zonder geldig adres worden overgeslagen en met reden teruggemeld. Knop in de bulkbalk van de offertelijst met één bevestiging. Test: `test/quotes-bulk-send.test.js`. Bouwt voort op de bulkbalk uit de selectie-PR.
