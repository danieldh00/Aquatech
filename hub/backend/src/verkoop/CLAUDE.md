# Verkoop: offertes, facturen, klanten, Visma (backend/src/verkoop)

Alleen de regels voor deze map; bij tegenspraak geldt de root-`CLAUDE.md`. het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term).

- Elke PDF van de server tekent kop en voet met `drawHeader`/`drawFooter` en meet tekst met `pdf.wrap`/`pdf.textWidth` van het document; kleuren via `paletteOf`. Nooit eigen kopcode.
- Een klantgericht kanaal van een offerte of werkorder toont `internalNote` nooit (`forCustomer` haalt hem weg). Korting tonen via `discountCaption`, nooit `discountPct` alleen.
- Teksten voor klantdocumenten staan in `shared/doc-text.js` in beide talen (nl en en); de test eist dezelfde sleutels.
- Btw verleggen alleen met een door VIES als geldig bevestigd nummer; het bewijs uit de browser wordt altijd overschreven. Een adres wordt door `requireVerifiedAddress` tegen PDOK gecontroleerd.
- Visma: elke nieuwe actie schrijft een logregel (kort, nooit tokens) met `origin`; een nieuw onderdeel dat naar Visma schrijft krijgt een sleutel in `CONTROL_PARTS` en respecteert `paused`.
- Facturen zijn na definitief vergrendeld; een credit is een nieuw concept met negatieve regels.
