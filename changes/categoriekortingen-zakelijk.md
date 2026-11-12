---
titel: Kortingen per productcategorie voor zakelijke klanten
---

## Nieuws
- [beheer] Onder Beheer > Webshop > Zakelijke kortingen geef je zakelijke klanten een korting op een hele productcategorie. De prijzen in de webshop, de winkelwagen, de bestelling en de factuur volgen. Een artikel met een eigen zakelijke prijs houdt die prijs; bij groothandelsklanten telt de hoogste korting.

## Changelog
Kortingen per productcategorie voor zakelijke klanten en twee restpunten van de verpakkingen. Geen migratie.

- **Instelling** `categoryDiscounts` { rules: [{ categorySlug, discountPct }] } (`webshop/category-discounts.js`, `internal`: alleen via de beheerroute), één regel per categorie van het webshopmenu, 0,01 tot 90%. `GET|PUT /api/admin/category-discounts` (recht `beheer`, audit `categoriekortingen_gewijzigd`); de server controleert elke categorie tegen het gepubliceerde menu. Scherm: Beheer > Webshop > Zakelijke kortingen (`beheer/kortingen.js`).
- **Rangorde**: de diepste categorie met een korting wint (`resolverFor`). Een artikel met een eigen zakelijke prijs en een verpakking met een eigen prijs houden die prijs; een verpakking zonder prijs (factor × stukprijs) krijgt de korting (bij een groothandelsklant de hoogste van klant- en categoriekorting, zonder staffel). Bij een groothandelsklant telt de hoogste van staffel-, klant- en categoriekorting (`wholesalePrice(…, categoryDiscount)`, bron `categorie`), nooit opgeteld. Particulieren krijgen nooit een categoriekorting.
- **Catalogus** (`buildCatalog`): `priceBusiness` is de prijs na korting, `priceBusinessList` die ervoor, `categoryDiscountPct` de korting en `discountByCode` de kortingen per artikelcode; de catalogus onthoudt de kortingen bij zijn cache. Varianten volgen de categorie van hun hoofdartikel.
- **Winkelwagen en bestelling** (`priceCart`): krijgt de kortingen per artikelcode uit de catalogus (alleen als de organisatie kortingen heeft); de regel meldt `listExcl`, `discountPct` en `discountSource: 'categorie'`. Bestelling, factuur en rapportage gebruiken de kortingsprijs. Offertes gebruiken geen zakelijke prijzen en blijven ongewijzigd.
- **Testdata**: de testomgeving krijgt twee categoriekortingen.
- **Verpakkingen, restpunten**: de rapportageregel van een artikel dat als verpakking is verkocht noemt het artikel zelf (`itemName` op de orderregel); extra test voor factuur en marge met pallet en stuks.
- Tests: `category-discounts.test.js`.
