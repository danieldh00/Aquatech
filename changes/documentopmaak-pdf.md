---
titel: Opmaak van factuur en pakbon aanpassen
---

## Nieuws
- [beheer] Nieuw in Beheer: Documentopmaak. Kies je eigen logo, de positie van het logo, een gekleurde of witte kop, de kleuren, het lettertype en een eigen voettekst voor de factuur en de pakbon. Het voorbeeld ernaast past zich meteen aan.

## Changelog
- Nieuwe instelling `documentLayout` per organisatie (`verkoop/document-layout.js`, alleen via `GET|PUT /api/admin/document-layout`, niet in de algemene instellingenlijst): logo (PNG als data-adres, ≤ 300 kB en 2400 px, opgeschoond en gecontroleerd), logopositie en -hoogte, kopstijl (balk of wit met lijn), kop- en accentkleur (anders het thema; kopkleur moet contrast 4,5 met wit houden), lettertype (Helvetica of Times), bedrijfsgegevens in de kop, bedrijfsregel en eigen tekst in de voet, paginanummers. Geen migratie.
- `drawHeader` en `drawFooter` vervangen de dubbel aanwezige kop- en voetcode in `invoice-pdf.js` en `packing-slips.js`; de standaardopmaak levert dezelfde PDF's als voorheen (behalve de voet, die nu regels van 9,5 pt tussenruimte krijgt).
- `pdf.js`: lettertype `serif` (Times-Roman en Times-Bold met eigen breedtetabellen); `createPdf({ font })` geeft `pdf.wrap` en `pdf.textWidth` die in dat lettertype meten.
- `POST /api/admin/document-layout/preview` maakt een voorbeeld-PDF (factuur of pakbon) met de opmaak uit het formulier zonder iets op te slaan; Beheer tekent de eerste pagina met pdf.js (lokaal, pas geladen bij gebruik).
- Instellingen kennen de vlag `notInView`: een waarde die alleen zijn eigen scherm nodig heeft komt niet in `GET /api/admin/settings`.
