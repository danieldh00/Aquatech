---
titel: Ontbrekende webshopproducten als artikel toevoegen
---

## Nieuws
- [voorraad] Bij Artikelen staat een knop *Ontbrekende uit webshop toevoegen*: die maakt artikelen aan voor producten uit de oude webshop die hier nog niet staan, zonder iets te archiveren of te wijzigen. De knop is tijdelijk, zolang WooCommerce nog draait.
- [voorraad] Artikelen met de code WC-<nummer> (producten zonder sku) worden weer aan hun webshopproduct gekoppeld.

## Changelog
- `stock.addMissingShop` + `POST /api/stock/import-shop-missing` (recht `voorraad`, alleen lezen uit WordPress, nooit terugschrijven): `shopSync.sync` kreeg de optie `addMissing`: haalt de producten op, maakt alleen de ontbrekende artikelen aan en stopt dan (geen boekingen, prijzen overnemen, variaties aanmaken, archiveren of terugschrijven, ook niet met terugschrijven en spiegelen aan). Audit `voorraad_webshop_ontbrekende_toegevoegd`.
- `matcher` koppelt een artikel met code `WC-<id>` aan het webshopproduct met dat id (voorheen bleef zo'n artikel zonder koppeling na het verlies van de koppeling).
- Tijdelijk: knop en route vervallen samen met de WooCommerce-koppeling.
