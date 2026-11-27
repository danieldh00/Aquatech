---
titel: PDF's bij artikelen bewaren
---

## Changelog
Eerste deel van de leverancier-PDF per artikel (nog geen scherm): migratie 105 `item_documents` (versleuteld via `vault.sealBytes`, AAD `<omgeving>:artikel-pdf:<id>`), `artikelen/item-documents.js` met `POST|GET /api/stock/items/:id/documents` (PDF als body, kop `X-Bestandsnaam`), `GET|PATCH|DELETE /api/stock/documents/:id` (recht `voorraad`). De PDF wordt in de werkthread van `inspectSlip` gecontroleerd en opnieuw opgebouwd (geen annotaties, acties of metadata); hoogstens 10 MB, 40 pagina's en 5 PDF's per artikel, dezelfde inhoud twee keer wordt geweigerd, 60 uploads per uur per omgeving. `inspectSlip` en de werkthread nemen nu eigen grenzen mee (de pakbon blijft 2 MB en 10 pagina's). `public` bepaalt straks of de PDF op de productpagina te downloaden is. Testdata: een PDF bij de tuinslang.
