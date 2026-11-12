---
titel: Winkelwagenknop op alle artikelkaarten en verpakking kiezen
---

## Nieuws
- In de webshop kun je nu bij elk artikel in het overzicht meteen het aantal invullen en op In winkelwagen drukken.
- Artikelen met uitvoeringen (zoals maten) staan als gewone kaart in het overzicht, met een keuzelijst voor de uitvoering op de kaart zelf.
- Op de productpagina kies je de verpakking (per stuk, doos of pallet); prijs en winkelwagen volgen je keuze.

## Changelog
- Webshop: `productCard` (storefront-pages.js) is voor elk artikel een `<article>` met foto- en naamlink, bij een hoofdartikel met varianten een keuzelijst (`data-variant-row`, gedeeld script `varianten.js`, ook op de startpagina) en een prijs-/voorraadregel met `orderForm` (`card-order`). De paginabrede `variant-row` en `listItem` zijn vervallen; `winkel.css` heeft kaartstijlen (op ≤ 520 px staan aantal en knop onder elkaar).
- Productpagina: verpakkingskeuze (`?p=`, met behoud van `?v=`) uit `data.packagingsOf` (nieuw, gecachet per productpagina, `item_packagings`); zichtbaarheid per klantgroep via `visibleFor`, prijs en beschikbaarheid uit `priceCart` (`CODE@VERPAKKING`). Keuzelijsten op de productpagina versturen zelf (`data-autosubmit`), de knop Kies is de terugval zonder script.
- Tests: `test/product-cards.test.js`.
