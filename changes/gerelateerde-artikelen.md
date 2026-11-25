---
titel: Gerelateerde artikelen op de productpagina
bump: minor
---

## Nieuws
- [voorraad] Bij elk artikel kun je instellen welke artikelen erbij passen ("Past bij"). De webshop toont ze op de productpagina, alleen als ze leverbaar zijn, met de gewone prijzen.
- [voorraad] Onder "Vaak samen besteld" toont de webshop automatisch wat klanten echt samen bestellen, op relevantie en niet alleen op populariteit, met de knop *Alles in winkelwagen*.
- [voorraad] Met één knop laat de AI "Past bij" voor alle artikelen invullen op basis van echte specificaties van internet. Bij elke koppeling staat de bron met de letterlijke zin; zonder gevonden specificatie wordt er niets gekoppeld.

## Changelog
- Migratie 99: `item_related` (koppelingen met bron en bewijs), `item_specs` (opgezochte specificaties per artikel) en `item_together` (berekende partners uit `web_sale_lines`).
- `artikelen/related-compat.js`: vaste regels voor passen (draad binnen/buiten gelijke maat, buis/slang gelijke maat, overlappende werkdruk, verschillende functie); de AI leest alleen specificaties met bronadres en letterlijke zin, de code controleert beide.
- `artikelen/related-research.js`: opzoeken met het zoekgereedschap van de AI-dienst (instelling `relatedAiModel`, feature `past_bij`); `related-items.js` en `related-routes.js`: opslag, berekening vaak samen besteld (verzonden bestellingen, zonder retouren en bulk), uurlijkse verversing en routes.
- Webshop: blokken op de productpagina uit een cache (warme pagina kost 0 queries), `POST /winkelwagen/samen`. Module-schakelaar `gerelateerde-artikelen`. Beheer: tabblad Gerelateerd bij Artikelen.
