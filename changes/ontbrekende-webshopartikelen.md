---
titel: Ontbrekende webshopproducten als artikel toevoegen
---

## Nieuws
- [voorraad] Bij Artikelen staat een knop *Ontbrekende uit webshop toevoegen*: die maakt artikelen aan voor producten uit de oude webshop die hier nog niet staan, zonder iets te archiveren of te wijzigen. De knop is tijdelijk, zolang WooCommerce nog draait.
- [voorraad] Artikelen met de code WC-<nummer> (producten zonder sku) worden weer aan hun webshopproduct gekoppeld.

## Changelog
- `stock.addMissingShop` + `POST /api/stock/import-shop-missing` (recht `voorraad`, alleen lezen uit WordPress, nooit terugschrijven): `shopSync.sync` kreeg de optie `addMissing`, die ook met spiegelen uit alleen de ontbrekende artikelen aanmaakt (geen archiveren, terugzetten of wijzigen). Audit `voorraad_webshop_ontbrekende_toegevoegd`.
- `matcher` koppelt een artikel met code `WC-<id>` aan het webshopproduct met dat id (voorheen bleef zo'n artikel zonder koppeling na het verlies van de koppeling).
- Tijdelijk: knop en route vervallen samen met de WooCommerce-koppeling.
