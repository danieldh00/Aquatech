---
titel: Aanbetaling op de offerte
---

## Nieuws
- [offertes, facturen] Op een offerte kun je nu een aanbetaling vragen (percentage of vast bedrag, incl. btw). Zodra de klant akkoord geeft, gaat er automatisch een aanbetalingsfactuur met betaallink naar de klant. De eindfactuur uit de werkorder trekt die aanbetaling weer af, dus de klant betaalt alleen het restant.
- [facturen] Is er geen mailserver of e-mailadres, dan blijft de aanbetalingsfactuur definitief maar onverstuurd en staat er een taak in Openstaande taken. Automatisch versturen is uit te zetten in Beheer > Modules; de factuur is dan met een knop op de offerte te maken.

## Changelog
- `data.deposit` {on, type pct|amount, pct, amount} op de offerte (`QuoteCore.sanitizeDeposit/depositOf/depositSplit`: het bedrag is incl. btw en wordt over de btw-tarieven verdeeld). Op het klantdocument staat één kader *Betaling* (`quote.deposit*` in `doc-text.js`, nl en en).
- Aanbetalingsfactuur (`verkoop/deposit-invoices.js`): een gewone factuur met `data.deposit` {quoteId, quoteNumber, amount}; per offerte één (migratie 98: unieke index op `(tenant_id, quote_id)` voor niet-gecrediteerde facturen met dat kenmerk). Bij akkoord (`onAccepted` in server.js, naast de automatische werkorder) definitief maken en versturen met de betaallink; routes `GET|POST /api/quotes/:id/deposit-invoice` (recht `facturen`). Instelling `depositInvoice` {enabled} (standaard aan), module `aanbetaling-automatisch`.
- Eindfactuur: `InvoiceCore.fromWorkOrder` krijgt `deposits` en trekt per btw-tarief een negatieve regel (`deposit: true`, buiten de korting; `InvoiceCore.totals` rekent de korting alleen over de gewone regels) af; een nog niet definitieve aanbetaling geeft een waarschuwing.
- Openstaande taak *Aanbetalingsfacturen versturen* (`invoices.unsentDeposits`).
