---
titel: Levertijd zichtbaar in shop, mail en Beheer
---

## Nieuws
- De webshop toont bij een artikel in gewone taal welke levermethode bij welk aantal geldt, bijvoorbeeld "pallet vanaf 100 stuks".
- De bestelpagina en de orderbevestigingsmail noemen de verwachte levertijd, steeds als indicatie en niet als toezegging.
- [webshop] Bij een webshopbestelling staan de levermethode en de levertijd bij het bestellen, ook in de Excel-export.
- [voorraad] Bij een artikel toont Beheer per levermethode de aantallen en de levertijd, op voorraad en niet op voorraad.

## Changelog
Levertijd tonen (fase 3 van de levermethode-spec): `delivery-times.js` (`etaPhrase`, `etaSentence`) en `delivery-rules.js` (`describeRules`); nieuw invulveld `{levertijd}` in de mailtypes *Orderbevestiging* (online betaald en op rekening; leeg bij afhalen of zonder levertijd), aanvulling in de melding aan het bedrijf; blok *Verwachte levertijd* op de bestelpagina (alleen bij status nieuw, zonder volgcode); beperking per artikel op de productpagina (`leadInfoOf` geeft ook de regels van artikel en hoofdartikel); `GET /api/stock/items/:id/delivery-preview` (recht `voorraad`, `webshop/delivery-preview.js`) en overzicht in het artikelformulier; levermethode en levertijd bij een bestelling in Beheer en kolom *Levertijd bij bestellen* in de Excel. Geen migratie.
