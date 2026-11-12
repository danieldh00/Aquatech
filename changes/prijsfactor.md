---
titel: Prijsfactor op de inkoopprijs
---

## Nieuws
- [voorraad] Nieuw tabblad Prijsfactor onder Inkoop: de verkoopprijs wordt de inkoopprijs maal een factor. Je stelt een standaardfactor in, en eventueel een eigen factor per categorie, per leverancier of per artikel. Het artikel zelf gaat voor de leverancier, de leverancier voor de categorie en de categorie voor de standaard.
- [voorraad] Bij een artikel kies je Prijsbepaling: een vaste verkoopprijs (zoals altijd) of inkoopprijs maal factor. De marge staat nu in de artikellijst en in het artikelformulier.
- [beheer] Prijzen afronden op de cent, 5 of 10 cent, 50 cent, hele euro's of eindigend op ,95 of ,99 (naar het dichtstbijzijnde of naar boven). Een voorbeeld toont per artikel de huidige en nieuwe prijs en de marge; pas na Doorvoeren veranderen de prijzen en gaan ze naar de webshop. Het voorbeeld kun je naar Excel exporteren.

## Changelog
- Migratie 65: `stock_items.price_mode` (`vast`|`factor`) en `price_factor` (eigen factor, leeg = erven), index `(tenant_id, price_mode)`; in `MIGRATIONS` en `PG_MIGRATIONS`.
- Instelling `priceFactors` (`internal`, `{ defaultFactor, rounding: { mode, direction }, categories, suppliers }`), alleen via `GET|PUT /api/stock/price-factors` (lezen recht `voorraad`, opslaan recht `beheer`; categorieën gecontroleerd tegen het webshopmenu, leveranciers tegen de eigen omgeving).
- `artikelen/price-factor.js`: `roundPrice` (rekent in hele centen), `resolveFactor` (artikel > voorkeursleverancier > diepste categorie met factor > standaard), `marginPct`, `createPriceFactorStore` (voorbeeld in één query per omgeving, geen N+1) en de routes.
- `POST /api/stock/price-factors/apply` (recht `beheer`): rekent opnieuw en voert alleen de artikelen door waarvan de nieuwe prijs nog gelijk is aan het voorbeeld; de rest wordt overgeslagen. `stock.setSalePrices` zet `shop_dirty` voor gekoppelde webshopproducten en start de sync. Audit `prijsfactor_gewijzigd` en `prijsfactor_doorgevoerd`.
- Opslaan van een artikel in de modus factor rekent de prijs meteen als modus, eigen factor of inkoopprijs veranderen; een andere naam of locatie laat de prijs staan. Een nieuwe inkoopprijs via een ontvangst wijzigt de verkoopprijs niet vanzelf: het artikel staat dan als afwijkend in het voorbeeld.
- Artikel-API: `priceMode`, `priceFactor` en `margin` (% van de verkoopprijs). Testdata: standaardfactor en vijf artikelen in de modus factor.
