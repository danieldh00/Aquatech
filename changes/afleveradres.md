---
titel: Afwijkend afleveradres bij bestellingen en offertes
---

## Nieuws
- Bij afrekenen in de webshop staat nu "Afleveradres gelijk aan factuuradres" standaard aan. Haal het vinkje weg om een ander afleveradres op te geven; de factuur gaat dan naar het factuuradres en het pakket naar het afleveradres.
- [offertes] In een offerte kun je een afwijkend afleveradres invullen. Het staat op het offertedocument.

## Changelog
Afleveradres naast factuuradres, zonder migratie (JSON in `web_orders.data` en `quotes.data`).
- Webshop: `data.address` blijft het afleveradres, nieuw `data.billingAddress` (factuuradres, met `country`) en `data.deliverySame`. Formuliervelden `deliveryStreet|Postcode|City|AddressManual`, `billingCountry`; `deliveryForm=1` maakt een niet-aangevinkt vakje (`deliverySame`) herkenbaar, zonder dat veld geldt "gelijk" (oudere aanroepen). `deliverySameOf` in web-orders.js. Beide Nederlandse adressen lopen via PDOK (`resolveParts`), afwijkend adres kan met "zelf invullen" (`deliveryUnverified`).
- `fromWebOrder`: factuuradres op de factuur, afwijkend afleveradres in de opmerkingen. Bevestigingsmail, bestelpagina en Beheer > Webshopbestellingen (ook Excel) tonen beide adressen.
- Offerte: `data.delivery` {same, address} (`QuoteCore.sanitize`), editor, document (NL/EN, `quote.deliveryTo`), Excel, en PDOK-controle op het afleveradres (`deliveryToVerify`). Werkorders/bestellingen uit een offerte gebruiken het veld later (volgende stap).
