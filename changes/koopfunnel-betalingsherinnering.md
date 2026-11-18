---
titel: Herinnering bij niet afgeronde betaling
---

## Nieuws
- [beheer] Een klant die een online betaling niet afrondt, krijgt na een uur één herinneringsmail met een link om alsnog te betalen, zolang de reservering loopt. Je zet dit uit in Beheer > Webshop > Betalen.

## Changelog
- Instelling `shopPayment.paymentReminder` (standaard aan). Uurlijkse taak `betalingsherinneringen` (`app.locals.webPaymentsRemind`, `webPayments.remindUnpaid`): bestellingen met status `nieuw`, online betaling open of mislukt, ouder dan een uur en met een lopende reservering; eerst een opvraging bij Mollie, betaald = geen mail. Eén mail per bestelling (`data.pay.reminderAt`, pas gezet na een gelukte verzending, dus een mislukte mail wordt volgende ronde herhaald); hoogstens 50 per ronde. Gastbestellingen krijgen hun persoonlijke link. Geen migratie.
- Misbruikbeperking: een herinnering gaat bij een account-bestelling alleen naar een bevestigd adres dat gelijk is aan dat van de bestelling, hoogstens één per e-mailadres per 24 uur (`orders.reminderAllowed`), en de naam in de aanhef wordt opgeschoond (geen links, regeleinden, max. 60 tekens). Zonder mailserver gaan er geen Mollie-opvragingen uit.
