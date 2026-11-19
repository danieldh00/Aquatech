---
titel: Betaallink in de factuurmail
---

## Nieuws
- [facturen] De factuurmail bevat een link waarmee de klant de factuur direct online kan betalen (iDEAL en andere methodes via Mollie), ook zonder in te loggen. Na betaling staat de factuur automatisch op betaald.

## Changelog
Betaallink in de factuurmail (geen migratie). `invoicePayments.linkFor` maakt een ondertekende link `/app/api/public/invoice-pay/<factuur>/<handtekening>` (HMAC met `vault.derive('factuur-betaallink')`, niets opgeslagen); `invoice-pay-routes.js` controleert de handtekening, de verloopdatum (`linkExpired`) en de status, start een Mollie-betaling en stuurt door; bij terugkeer (`?teruggekeerd=1`) volgt een opvraging bij Mollie. Alleen als online betalen aan staat; veld `{betaallink}` en een regel onder `{betaling}` in de standaardmail (`mail.payOnline`, nl en en). Limiet per bezoeker.
