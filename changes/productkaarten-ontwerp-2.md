---
titel: Mooiere productkaarten in de webshop
---

## Nieuws
- Productkaarten in de webshop hebben een nieuw ontwerp: foto's op een vaste hoogte met het voorraadlabel erop, titel, variantkeuze, prijs en winkelwagenknop staan in elke kaart op dezelfde plek, en op de home staan de producten in een raster van vier kolommen.

## Changelog
`webshop/storefront.css` en `storefront-pages.js` (`productCard`): vaste fotohoogte (190 px, 130 px op een telefoon) op een zacht vlak, voorraadlabel als pil op de foto (het `stock`-element staat nu direct na de fotolink in de kaart, het script `varianten.js` vindt het nog via `data-variant-stock`), een vaste rij van 52 px voor de variantkeuze (kaarten zonder variant tonen daar `Artikelnr.`), raster `minmax(250px, 1fr)`, teal rand en schaduw bij hover. Het winkelwagenicoon op smalle kaarten (container query) is een witte masker-SVG.
