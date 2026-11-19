---
titel: Telstaat en telformulier als pdf
---

## Nieuws
- Bij een voorraadtelling kun je nu een telstaat als pdf downloaden (ook met alleen de verschillen) voor de boekhouding.
- Voor tellen op papier is er een blanco telformulier: per locatie een blad met de artikelen en een leeg vak, zonder verwacht aantal of prijs.

## Changelog
- Voorraadtelling: `GET /api/stock-counts/:id/telstaat.pdf` (optioneel `?alleen=verschillen`) en `telformulier.pdf` (optioneel `?locatie=`), recht `voorraad`, met de documentopmaak van de organisatie; knoppen in Artikelen > Telling.
