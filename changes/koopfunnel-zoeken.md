---
titel: Beter zoeken in de webshop
---

## Nieuws
- Zoeken in de webshop zet de juiste treffer bovenaan: een exacte artikelnummer (ook met streepje of spatie) komt eerst. Vind je niets precies, dan zoekt de webshop ook op meervouden, verwante woorden (sproeier en sprinkler) en kleine typefouten.

## Changelog
- Nieuw `webshop/search.js` (zuivere functies): normaliseren zonder accenten en leestekens, relevantiescore (exacte code, beginnende code, begin van de naam, alle woorden in de naam, voorraad als tiebreak), en een ruimere tweede ronde met stam, verwante woorden (`SYNONYM_GROUPS`) en tikfouten (Damerau-Levenshtein, 1 fout vanaf 5 tekens, 2 vanaf 8). Varianten blijven één eenheid met het hoofdartikel. De zoekpagina meldt het bij ruimer zoeken.
