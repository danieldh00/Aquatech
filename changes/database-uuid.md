---
titel: Database: id's en verwijzingen zijn echte uuid's
---

## Nieuws

## Changelog

- Migratie 97: alle id's en verwijzingen naar id's (197 kolommen in 62 tabellen, o.a. tenant, gebruiker, plan, offerte, factuur, werkorder, bestelling en artikel) gaan van tekst naar het type uuid. Kleinere tabellen en indexen, en de database weigert nu een verwijzing naar iets wat geen id is. Waarden die al een uuid zijn blijven gelijk; een andere waarde (zou niet moeten voorkomen) krijgt in elke kolom dezelfde afgeleide uuid, zodat verwijzingen blijven kloppen. Bewust tekst gebleven: id's van buiten (WooCommerce, Mollie, Visma), `invoices.shop_order_id`, `client_id` van de offline wachtrij, `request_id`, `step_id` en `material_id`.
- Een id in een adres of verzoek dat geen uuid is, vindt nooit een rij: lezen en wijzigen geven niets terug (404), schrijven met zo'n waarde blijft een fout. De tenantafscherming (policies) vergelijkt als tekst.
- Deterministische regel-id's van de webshoprapportage zijn nu uuid's (afgeleid van dezelfde invoer).
