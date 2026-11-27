---
titel: Ontbrekende webshopartikelen: subartikelen terugzetten en koppelen
---

## Nieuws
- [voorraad] *Ontbrekende uit webshop toevoegen* zet nu ook gearchiveerde subartikelen terug en koppelt subartikelen die nog niet aan hun webshopproduct hangen. Zo komen ook de artikelen terug die bij het samenvoegen in een artikelgroep zijn gekomen. De Excel (tabblad *Teruggezet*) toont per artikel wat er is gebeurd.

## Changelog
- `stock.addMissingShop`: een (gearchiveerd) subartikel met dezelfde code als een los webshopproduct wordt teruggezet (`archived = 0`, `archived_by_parent = 0`, artikelgroep mee terug) en gekoppeld (`shop_product_id`) met `shop_sync = 0`, zodat de synchronisatie er nooit naar de webshop schrijft. Een artikel dat al aan een ander bestaand webshopproduct hangt, wordt overgeslagen met een reden. `restoredItems` heeft een veld `kind`.
