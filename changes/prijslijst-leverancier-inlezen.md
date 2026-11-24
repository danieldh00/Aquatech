---
titel: Prijslijst van de leverancier inlezen
bump: minor
---

## Nieuws
- [voorraad] Een prijslijst van een leverancier lees je nu in één keer uit Excel in (Artikelen > Leveranciers > Prijslijst inlezen), met eerst een controle. De verkoopprijzen volgen daarna automatisch via de prijsfactor.

## Changelog
Prijslijst van de leverancier inlezen (V-30), gebouwd op het importvenster van V-05.
- `POST /api/stock/price-lists/:supplierId` (+ `GET …/fields`, recht `voorraad`, `artikelen/supplier-price-list.js`): artikelen worden herkend op het artikelnummer van de leverancier, anders EAN, anders eigen code (tegenstrijdig = fout). Statussen nieuw (koppeling erbij), wijzigt, ongewijzigd, onbekend (overgeslagen) en fout; hoogstens 2000 regels.
- Prijs, bestelhoeveelheid en levertijd komen op de koppeling. Alleen bij de voorkeursleverancier (of een artikel zonder leverancier) wordt het ook de inkoopprijs van het artikel (`stock.addCostPrice`, historie, `repriceItem` volgt de prijsfactor); een backup-leverancier verandert nooit de prijs van het artikel.
- `suppliers.priceListContext` (twee queries) voor de koppelingen; `readTable` kent nu `maxRows`; audit `leverancier_prijslijst_ingelezen`.
