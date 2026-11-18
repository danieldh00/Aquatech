---
titel: Offerte aanvragen en opnieuw bestellen in de webshop
---

## Nieuws
- [beheer] Een zakelijke klant met een winkelwagen vanaf 500 euro excl. btw kan een offerte aanvragen in plaats van af te rekenen. Dat maakt een concept in Offertes (alleen zichtbaar voor medewerkers, bij "alle offertes") en je krijgt een mail. Je controleert het concept en verstuurt de offerte zelf.
- Klanten kunnen een eerdere bestelling met één klik opnieuw bestellen: de artikelen komen in de winkelwagen met de actuele prijzen en voorraad; wat niet meer te koop is wordt gemeld.

## Changelog
- `webshop/quote-requests.js` (`qualifies`, `request`; drempel `QUOTE_REQUEST_MIN_EXCL` = 500 excl. btw, een constante, geen instelling): `POST /winkelwagen/offerte/` (alleen ingelogde zakelijke klant, 5 per uur per klant, prijzen en btw uit `priceCart`, nooit uit de browser) maakt via `quoteStore.create` een concept met `customer_id` = de klant, een interne notitie met de herkomst en de bedrijfsgegevens, en mailt `quoteProfile.email` (mislukt de mail, dan staat het concept er toch). Geen migratie.
- `POST /bestelling/:id/opnieuw/` (via `orderAccessOf`: eigenaar of gast met toegang; `addCartLines` telt op bij de wagen, onbekende codes in `?niet=`). Een afronding op groothandelsvoorwaarden gebeurt zoals altijd in de winkelwagen zelf.
