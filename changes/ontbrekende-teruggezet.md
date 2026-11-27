---
titel: Gearchiveerde webshopartikelen terugzetten
---

## Nieuws
- [voorraad] *Ontbrekende uit webshop toevoegen* zet artikelen die wel bestaan maar gearchiveerd zijn (bijvoorbeeld 110-12) weer terug als de webshop ze nog verkoopt, en koppelt ze aan het webshopproduct. Prijs en voorraad blijven zoals ze waren. De Excel heeft een tabblad *Teruggezet*; voor wat overblijft staat de reden duidelijker in *Overgeslagen* (bijvoorbeeld al een subartikel van een artikelgroep).

## Changelog
- `stock.addMissingShop`: een gearchiveerd los artikel (geen artikelgroep of subartikel) met dezelfde code als een webshopproduct (geen variatie) wordt teruggezet (`archived = 0`, `shop_product_id`, `shop_sync = 1`) en meldt zich als `restoredItems`; de overgeslagen-redenen noemen nu ook gearchiveerde en subartikel-eigenaars. De oorzaak van de 570 overgeslagen producten: 366 artikelen stonden gearchiveerd in de voorraad (de voorraadlijst toont die niet) en 201 zijn subartikelen van een artikelgroep zonder koppeling.
