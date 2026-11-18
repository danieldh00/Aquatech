---
titel: Startpagina van de webshop laadt veel lichter
---

## Nieuws
- De grote afbeeldingen op de startpagina van de webshop (hoofdbanner, banners en het zakelijke blok) zijn nu ongeveer 70 procent kleiner, op een telefoon nog meer. De pagina laadt daardoor merkbaar sneller.

## Changelog
- `webshop/assets/`: WebP-varianten van `hero-tuin`, `banner-druppelslang`, `banner-pomp` en `zakelijk-achtergrond` (met `-klein` voor smalle schermen), gemaakt met `tools/shop-webp.py`; de JPEG's blijven staan (terugval en bestaande verwijzingen in Beheer).
- `storefront-pages.js` `imageHtml`: een standaardafbeelding met WebP-variant wordt een `picture` met `srcset`/`sizes` en de JPEG als `img`; geüploade afbeeldingen (`media:`) en bestanden zonder WebP blijven een gewone `img`. De standaard hero krijgt `fetchpriority="high"` (bovenaan de pagina, al met afmetingen); de rest laadt lazy. CSS: `picture { display: contents; }` zodat de opmaak gelijk blijft.
- Gewicht van de afbeeldingen op de startpagina: ongeveer 443 kB JPEG naar ongeveer 126 kB (breed scherm) of 63 kB (smal scherm) WebP.
