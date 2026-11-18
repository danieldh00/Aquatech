---
titel: Snellere productkaartjes met miniaturen
---

## Nieuws
- [voorraad] Productkaartjes in de webshop gebruiken nu een kleine miniatuur van de foto (ongeveer een tiende van de grootte), zodat overzichten sneller laden, vooral op een telefoon. Nieuwe foto's krijgen er automatisch een. Voor bestaande foto's klik je onder Artikelen op *Afbeeldingen en miniaturen*.

## Changelog
- Migratie 81 (`item_images.thumb`, ook in `PG_MIGRATIONS`): versleutelde WebP-miniatuur (hoogstens 480 px en 100 kB, AAD `<tenant>:artikel-afbeelding-klein:<id>`).
- `artikelen/item-images.js`: `setThumb` (controle op inhoud: alleen WebP binnen de grenzen), `thumbFile` (valt terug op de gewone afbeelding), `thumbsPending` en `thumbCandidates`; routes `PUT /api/stock/images/:id/thumb` en `GET /api/stock/images-thumbs` (recht `voorraad`, tenant-gebonden); een upload kan `thumb` meesturen (een ongeldige miniatuur laat de upload wel slagen).
- Shop: `artikelfoto/<id>/klein` (zelfde limiet en `immutable` cache als de foto); kaartjes (productlijst, assortimentstegels) gebruiken `productImageSrc(root, image, { small: true })`, de productpagina blijft de grote foto tonen.
- Browser (`artikelen/item-images.js`): maakt de miniatuur met een canvas (geen native npm-module); de knop *Afbeeldingen en miniaturen* neemt eerst de afbeeldingen uit de oude webshop over en maakt daarna de ontbrekende miniaturen in porties van 25.
- `deploy/apps01/README.md`: stappen voor de Cloudflare-cacheregel voor `/artikelfoto/` en `/media/` (dashboardinstelling).
