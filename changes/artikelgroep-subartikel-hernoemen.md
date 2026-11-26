---
titel: Artikelgroepen en subartikelen overal dezelfde naam
---

## Nieuws
- [voorraad] Een artikel met maten heet overal een artikelgroep, en de maten eronder heten subartikelen. Er verandert niets aan hoe je werkt.

## Changelog
Hernoeming zonder gedrag te wijzigen: `variant`/`parent`/`has_variants` wordt `subartikel`/`group_id`/`is_group` in code, database (migratie 103: kolommen, index en constraints van `stock_items` en `stock_merges`), API (`PUT /api/stock/items/:id/sub-items`), frontend en tests. Back-ups van vóór schema 103 blijven terug te zetten (`RENAMED_COLUMNS`). WooCommerce-termen, tenants `parent_id`, categorie-`parentSlug` en GA4 `item_variant` blijven.
