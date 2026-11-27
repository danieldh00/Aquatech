---
titel: Teruggezette subartikelen weer zichtbaar in de eigen webshop
---

## Nieuws

- [voorraad] Subartikelen die uit het archief zijn teruggezet of aan een webshopproduct zijn gekoppeld, staan nu ook in de eigen webshop en zijn bestelbaar.

## Changelog

- Ontbrekende webshopartikelen: een teruggezet of gekoppeld subartikel krijgt `shop_sync = 1` (de vorige versie zette het op 0, waardoor het uit de eigen webshop verdween). Een volgende run zet de eerder op 0 gezette gekoppelde subartikelen weer aan (Excel: "weer in de webshop gezet").
- De synchronisatie koppelt een subartikel dat aan een los WordPress-product hangt alleen en schrijft er nooit prijs of voorraad naar terug.
