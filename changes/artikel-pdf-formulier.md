---
titel: PDF's van de leverancier beheren in het artikelformulier
---

## Nieuws
- In het artikelformulier staat nu een blok PDF's van de leverancier: PDF toevoegen, kiezen of hij als download op de productpagina staat, en weghalen. [voorraad]

## Changelog
Derde deel van de leverancier-PDF per artikel: blok `#d-documents` in `frontend/artikelen/` (`documents.js`, `window.ArtikelenDocuments`) boven de API van `item-documents.js` (upload als `application/pdf` met `X-Bestandsnaam`, aan/uit voor de productpagina, weghalen; niet bij een artikelgroep, niet te wijzigen bij een gearchiveerd artikel). Geen migratie.
