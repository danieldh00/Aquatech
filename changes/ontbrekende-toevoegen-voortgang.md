---
titel: Ontbrekende webshopproducten toevoegen met voortgang
---

## Nieuws
- [voorraad] *Ontbrekende uit webshop toevoegen* loopt nu op de achtergrond: je ziet de voortgang (ophalen, variaties, toevoegen) en een lijst van de binnengehaalde artikelen, ook als Excel. Het werk gaat door als je het venster sluit.

## Changelog
- `POST /api/stock/import-shop-missing` start een taak (202) en `GET` geeft de voortgang (`artikelen/shop-missing-job.js`, stand in het geheugen per omgeving); de gewone aanroep duurde met 888 producten en 96 variabele producten langer dan een verzoek mag en gaf een foutmelding. `fetchProducts` en `addMissingShop` melden voortgang (`onProgress`), toevoegen gaat in porties van 50. Een interne fout geeft in de browser alleen een melding met de code; de details staan in het serverlog.
- Frontend: `artikelen/shop-missing.js` (tijdelijk, samen met de WooCommerce-koppeling weg).
