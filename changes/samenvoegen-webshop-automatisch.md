---
titel: Artikelen samenvoegen zonder handmatige webshopkoppelingen
---

## Nieuws
- [voorraad] Artikelen samenvoegen tot één variabel artikel blokkeert niet meer als ze aan een webshopproduct hangen. Aquatech zet het hoofdartikel zelf als één variabel product in de webshop en zet de oude losse producten op concept (niet verwijderd). Lukt het niet in de webshop, dan wordt er niets samengevoegd.
- [voorraad] Nieuwe knop *Alles samenvoegen*: één overzicht met alle voorstellen ter bevestiging, daarna worden ze één voor één uitgevoerd met een uitkomst per voorstel.

## Changelog
- `POST /api/stock/merge`: staat Aquatech in de webshop mag schrijven (REST + "Aquatech is de bron", `shopSync.canPublish`), dan vervalt de blokkade van `refuseLinked`. Na `mergeIntoVariants` roept de route `shopSync.publishMerged` aan: (1) sku van de oude producten leeg zetten (anders is de variatie-sku dubbel), (2) hoofdartikel als variabel product + variaties aanmaken (`publishNow`), (3) oude producten op concept (`patchProducts` in woocommerce.js). Mislukt (1) of (2), dan worden de sku's teruggezet en draait de route de samenvoeging terug met `unmergeVariants` (antwoord 502/409 `shop_failed`); mislukt alleen (3), dan staat er een waarschuwing in het antwoord (`shop.warning`). Zonder schrijfrechten en met "webshop bepaalt de artikellijst" blijft de blokkade, met een duidelijkere melding.
- `GET /api/stock/merge-suggestions` geeft ook `shop` {publishes, blocked}. `mergeIntoVariants` geeft `shopProductIds` terug (ook producten die alleen via code of sku herkend worden).
- Frontend (`artikelen/merge.js`): knop *Alles samenvoegen* met overzichtsstap (vinkjes, code aanpasbaar, uitkomst per voorstel; een mislukt voorstel stopt de rest niet) en een uitleg over de webshop die bij de instelling past.
- `server.js`: twee regels in de context van de voorraadroutes (`shopCanPublish`, `publishMergedToShop`).
- Tests: `variants.test.js` (sync-niveau en via de API, met nagebootste webshop).
