---
titel: Betalingen: opnieuw proberen, terugstorten gemeld en voorraad sneller vrij
---

## Nieuws
- [beheer] Mislukt de bevestigingsmail of de factuur na een online betaling, dan probeert de app het later vanzelf opnieuw.
- [beheer] Betaalt een klant een bestelling die al vervallen of geannuleerd was, of twee keer, dan krijgt hij een mail dat het bedrag teruggaat. Lukt terugstorten niet vanzelf, dan staat dat in Bewaking.
- [beheer] De voorraad van een online bestelling die niet betaald wordt komt nu binnen een half uur vrij (controle elke vijf minuten).
- [facturen] Een online betaling op een factuur die intussen gecrediteerd is staat in het logboek en in Bewaking.

## Changelog
Audit 1.33.0, thema webshopbetalingen en facturen, deel 4 (bedrading in `server.js`). Geen migratie.

- **T-16**: de factuur- en de bevestigingsstap na een betaling hebben een sleutel (`factuur`, `bevestiging`); een mislukte stap wordt door `catchUpPaid` opnieuw geprobeerd. Een bevestigingsmail die niet verstuurd kon worden telt als mislukt (behalve zonder mailserver). Na de laatste poging: auditregel `webshop_betaalstap_mislukt`.
- **T-08, T-17**: `onLatePayment` schrijft `webshop_betaling_teruggestort`, mailt de klant (`sendLatePayment`) en werkt de melding `webshop-terugbetalen` in Bewaking bij (`webOrders.lateRefundsNeeded`; sluit vanzelf als er niets meer openstaat).
- **B-13**: `app.locals.webPaymentsRelease` loopt elke vijf minuten (niet tijdens onderhoud) en geeft de voorraad van onbetaalde online bestellingen vrij.
- **Betaling na creditering**: `invoicePayments.onPaidAfterCredit` → auditregel `factuur_betaald_na_creditering` en melding `factuurbetaling-na-creditering` in Bewaking.
- **T-03**: online factuurbetalen is hard beperkt tot de hoofdtenant (`mainTenantId` in `createInvoicePayments`): in een andere omgeving geen knop in het portaal, geen betaallink in de mail en geen betaling; de webhook en de betaallink zonder inlog kenden al alleen de hoofdtenant.
