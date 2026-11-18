---
titel: Winkelwagen en afrekenen duidelijker
---

## Nieuws
- De winkelwagen toont nu al de verzendkosten, de levertijd en hoeveel er nog aan gratis bezorging ontbreekt.
- Bij het afrekenen kies je de verzendmethode uit kaarten met prijs en levertijd, en staat er een strook met levertijd, gratis-vanaf, bedenktijd en het telefoonnummer.
- Het aantal in de winkelwagen wordt direct bijgewerkt en op een telefoon staat elke regel als kaart. Verder winkelen brengt je terug naar de laatst bekeken categorie of zoekopdracht.
- Een zoekopdracht zonder resultaat geeft tips, de categorieën en ons telefoonnummer. Het blok Dropshipping zien alleen zakelijke klanten.

## Changelog
Winkelwagen: `shippingHint`/`shippingBlock` (kosten, levertijd, drempelbalk met `<progress>`), betaalnotitie naar de echte betaalwijzen, cookie `aquatech_laatste_lijst` (`rememberList`/`lastListPath`, alleen bekende soort en veilige tekens) voor Verder winkelen, aantalformulier dat zichzelf verstuurt (`winkelwagen.js`) en een kaartweergave op smalle schermen. Afrekenen: verzendmethode als keuzekaarten (radio, `chosenShipping` in afrekenen.js), kop *Bezorg- en factuuradres* zolang het afleveradres gelijk is, dropshipping alleen in het formulier van zakelijke klanten. `trustStrip` op productpagina, winkelwagen en afrekenen (alleen punten met gegevens). Zoeken zonder resultaat: `noResults`. `shipping.optionsFor` geeft `freeFrom` mee.
