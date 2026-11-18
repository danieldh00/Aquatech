---
titel: Herinnering bij niet afgeronde betaling
---

## Nieuws
- [beheer] Een klant die een online betaling niet afrondt, krijgt na een uur één herinneringsmail met een link om alsnog te betalen, zolang de reservering loopt. Je zet dit uit in Beheer > Webshop > Betalen.

## Changelog
- Instelling `shopPayment.paymentReminder` (standaard aan). Uurlijkse taak `betalingsherinneringen` (`app.locals.webPaymentsRemind`, `webPayments.remindUnpaid`): bestellingen met status `nieuw`, online betaling open of mislukt, ouder dan een uur en met een lopende reservering; eerst een opvraging bij Mollie, betaald = geen mail. Eén mail per bestelling (`data.pay.reminderAt`, pas gezet na een gelukte verzending, dus een mislukte mail wordt volgende ronde herhaald); hoogstens 50 per ronde. Gastbestellingen krijgen hun persoonlijke link. Geen migratie.
