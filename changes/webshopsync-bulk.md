---
titel: Webshopsync schrijft in bulk en alleen bij verschillen
---

## Nieuws
- De synchronisatie met de oude webshop is veel lichter voor de database: een ronde zonder wijzigingen doet nog maar een handvol queries in plaats van duizenden. [beheer]

## Changelog
- Webshopsync: koppelingen, standen en prijzen worden per ronde in bulk (`UPDATE … FROM unnest`) en alleen bij een verschil weggeschreven; het bijwerkmoment van een ongewijzigd artikel wordt hooguit eens per dag vernieuwd.
- `shop_products` wordt bijgewerkt met één upsert (alleen veranderde rijen) en verdwenen producten worden gewist, in plaats van alles wissen en per product invoegen.
- Test: een ronde zonder verschillen kost bij 60 artikelen minder dan 25 queries.
