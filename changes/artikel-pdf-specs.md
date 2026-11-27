---
titel: Specificaties uit de PDF van de leverancier lezen
---

## Nieuws
- In het artikelformulier staat bij de PDF's een knop Specificaties uit PDF lezen: de AI leest de PDF en zet de technische kenmerken (materiaal, druk, afmetingen) bij de specificaties van het artikel. Eigen specificaties blijven staan. [voorraad]

## Changelog
Vierde deel van de leverancier-PDF per artikel: `POST /api/stock/items/:id/documents/specs` (`artikelen/item-pdf-specs.js`, recht `voorraad`, 60 per uur per omgeving, audit `voorraad_pdf_specs`). `researchPdfFeatures` (related-research.js) geeft de PDF's als bijlage aan de AI (zonder zoeken op internet); `validatePdfFeatures` (related-compat.js) houdt alleen kenmerken met een aangeleverd bestand als bron, een bronzin en alle getallen uit die zin. Een kenmerk uit de PDF gaat voor een eerder opgezocht kenmerk met dezelfde naam, de overige eerder opgezochte kenmerken blijven bewaard; `drafts.applySpecs` voegt alleen nieuwe namen toe (eigen specificaties nooit overschreven). Verbruik als `kenmerken_pdf`. Het blok PDF's staat nu ook bij een artikelgroep. Geen migratie.
