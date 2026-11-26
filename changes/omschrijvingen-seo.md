---
titel: Betere vindbaarheid van productteksten
---

## Nieuws
- [voorraad] AI-omschrijvingen beginnen met wat het artikel is, het merk en het belangrijkste gegeven, en krijgen een eigen zoekmachine-omschrijving per artikel.

## Changelog
- Schrijfprompt (`item-text-writer.js`): vindbaarheidsregels (soort product en merk in de eerste zin, geen trefwoordenstapeling, uniek per artikel, unieke seoDescription). Geen hidden tekst.
- Productpagina: de zichtbare specificaties staan ook als Schema.org `additionalProperty` (PropertyValue) in de Product-JSON-LD (`Seo.productJsonLd({ specifications })`), zodat zoekmachines en AI-assistenten de kenmerken kunnen lezen. De shop blijft noindex tot go-live.
