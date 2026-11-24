---
titel: Marge zichtbaar in de offerte
---

## Nieuws
- [nacalculatie, beheer] In de offerte zie je nu de marge: per regel en onder de totalen, met een waarschuwing als de marge onder je minimum ligt. Het minimum stel je in bij Bedrijfsgegevens. De marge staat nooit op het klantdocument.

## Changelog
Marge in de offerte-editor (V-02). `QuoteCore.margin` rekent per regel en in totaal (na korting) over de regels met een bekende kostprijs: materiaal met artikelcode en inkoopprijs, arbeid in uren met de kostprijs per uur uit de bedrijfsgegevens. Regels zonder kostprijs tellen niet mee en worden gemeld. Nieuwe route `GET /api/quote-costs?codes=` (recht `nacalculatie`, hoogstens 300 codes, alleen de eigen voorraad) die de inkoopprijzen geeft; valt onder de module Nacalculatie (uit = 409). Nieuw profielveld `minMarginPct` (intern, 0 = geen waarschuwing, hoogstens 99) bij Offertes > Bedrijfsgegevens. De kaart en de regelmarges zitten alleen in de editor (`offertes-margin.js`), niet in document, PDF, mail of openbare link. Tests: `quote-margin.test.js`.
