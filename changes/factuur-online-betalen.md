---
titel: Facturen online betalen in het klantportaal
---

## Nieuws
- In het klantportaal staat nu het blok Facturen met uw definitieve en betaalde facturen, met een PDF per factuur.
- Staat online betalen aan, dan betaalt u een openstaande factuur met de knop "Nu betalen" via iDEAL of een andere methode van Mollie. Na de betaling staat de factuur meteen op betaald, ook bij de debiteuren van het bedrijf.

## Changelog
- Nieuw: `verkoop/invoice-payments.js` (tabel `invoice_payments`, migratie 84): per poging één Mollie-betaling. Hergebruikt de Mollie-sleutel en het webadres van de webshop (`configOf`), dus alleen in de hoofdtenant. De uitkomst komt altijd uit een opvraging bij Mollie (metadata `invoiceId` en bedrag moeten kloppen); de overgang naar betaald gebeurt één keer (voorwaardelijke update) en roept `invoices.setPaid` en de auditregel `factuur_betaald_online` aan.
- Nieuw: portaalroutes `GET /api/portal/invoices/:id/pdf`, `POST …/pay` en `POST …/check` (recht `portaal`, alleen eigen facturen, geen concepten of creditfacturen), `api/portal` geeft `invoices`; openbare webhook `POST /api/public/invoice-payment/:id/webhook` (limiet per bezoeker). `invoices.list` kreeg de filters `customerId`, `kinds` en `statuses`. Testdata vult `invoice_payments`.
