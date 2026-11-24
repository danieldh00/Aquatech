---
titel: Klanten en artikelen importeren uit Excel
bump: minor
---

## Nieuws
- [klanten] Klanten importeer je nu uit een Excel-bestand: je krijgt een voorbeeldbestand, een controle (wat is nieuw, wat wijzigt, wat klopt niet) en verwerkt daarna alles in één keer.
- [voorraad] Artikelen importeren of in bulk wijzigen kan nu ook uit Excel, met dezelfde controle vooraf.

## Changelog
Import uit Excel (V-05) voor klanten en artikelen. Het bestand wordt in de browser gelezen (ExcelJS, `shared/excel-import.js`) en als kopregel + rijen naar de server gestuurd; de server controleert en schrijft niets bij de controle.
- `platform/excel-import.js`: gedeelde kern (kolomkoppen herkennen met synoniemen, Nederlandse getallen, grenzen: 1000 rijen, 40 kolommen).
- `POST /api/customers/import` (+ `GET …/fields`, recht `klanten`): herkennen op e-mail, anders naam; adres bij PDOK (`addressGuard`); zakelijk en bedrijfsgegevens alleen met recht `beheer`; audit `klanten_geimporteerd`; hoogstens 500 klanten, 30 verzoeken per uur.
- `POST /api/stock/import-excel` (+ `GET …/fields`, recht `voorraad`): herkennen op artikelcode, `stock.create`/`stock.update` (EAN, inkoopprijshistorie, prijsfactor), beginvoorraad alleen bij nieuwe artikelen; audit `voorraad_artikelen_geimporteerd`.
- Verwerken is alles of niets op de controle: met fouten alleen met `skipErrors`.
- `server.js`: één regel, JSON-limiet 256 kB voor `/api/customers/import`.
