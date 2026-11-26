---
titel: Product bewerken vanuit de webshop
---

## Nieuws
- [voorraad] Op een productpagina in de webshop staat voor medewerkers een knop *Bewerken in beheer* die direct de artikelkaart opent.

## Changelog
`productPage` toont voor `activeShop.staff` een knop naar `app/artikelen/?id=<artikel-id>` (bij een variant de gekozen variant). De catalogus bewaart daarvoor `itemId` per product en variant (alleen in het geheugen, geen extra query; bezoekers zien het id nooit). Test in `storefront.test.js`.
