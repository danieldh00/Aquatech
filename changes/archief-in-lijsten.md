---
titel: Archief in de overzichten
---

## Nieuws
- [beheer] In de overzichten van offertes, werkorders, facturen, webshopbestellingen en plannen kun je met het filter Archief het archief ook tonen of alleen het archief bekijken. Vink stukken aan en kies Archiveren of Terughalen.

## Changelog
- Nieuw gedeeld onderdeel `shared/archive-ui.js` (+ `.css`): archieffilter (`?archief=toon|alleen`), vinkjes en de acties Archiveren en Terughalen via `/api/admin/archive/archive|restore`, alleen met het recht beheer. Offertes en facturen gebruiken hun bestaande selectie en bulkbalk; het klantenoverzicht blijft buiten deze wijziging.
