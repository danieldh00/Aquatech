---
titel: Productinformatie als PDF downloaden in de webshop
---

## Nieuws
- Bij een product in de webshop staat nu een blok Downloads met de PDF's van de leverancier (bijvoorbeeld een technische fiche), zodra een PDF voor de webshop is vrijgegeven.

## Changelog
Tweede deel van de leverancier-PDF per artikel: `readDetails` (storefront-data.js) geeft per artikelcode `documents` mee (alleen `public = 1`; een subartikel toont ook de PDF's van zijn artikelgroep, via dezelfde 30 seconden cache als de specificaties), `detailsSection` toont het blok Downloads en `GET /artikel-pdf/:id/:naam` (storefront.js) levert de PDF als bijlage (`nosniff`, CSP `sandbox`, 5 minuten cache). `itemDocuments.file(…, { publicOnly: true })` weigert nu ook een PDF van een gearchiveerd artikel. Geen migratie.
