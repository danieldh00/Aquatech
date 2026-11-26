---
titel: Gerelateerde artikelen: maximaal vier zichtbaar
---

## Nieuws
- In de webshop toont het blok "Past bij" (en "Vaak samen besteld") voortaan vier artikelen. De rest staat achter de knop *Bekijk meer*.

## Changelog
- `relatedSections` (storefront-pages.js): de eerste vier producten van elk blok staan open, de rest in een `<details class="related-more">` met knop *Bekijk meer (n)*; zonder script en zonder nieuwe CSP-uitzondering. Test in `related-items.test.js`.
