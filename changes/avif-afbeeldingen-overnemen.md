---
titel: Afbeeldingen uit de oude webshop overnemen werkt ook met AVIF
---

## Nieuws
- [voorraad] *Afbeeldingen en miniaturen* neemt nu ook de foto's over die de oude webshop als AVIF aanbiedt (dat waren alle foto's). Je browser zet ze om naar JPEG en maakt meteen de miniatuur. Een eerdere poging die alles als mislukt toonde, kun je gewoon opnieuw starten.

## Changelog
- `artikelen/item-images.js`: `storeImage` herkent AVIF/HEIC (ftyp-merk) en geeft `unsupported_format` (415) in plaats van de misleidende melding over 8000 pixels; het overnemen meldt zulke artikelen met `convert: true` en `itemId`.
- Nieuwe route `GET /api/stock/items/:id/shop-image` (recht `voorraad`, tenant-gebonden, importlimiet): bytes van de afbeelding van het gekoppelde webshopproduct van dat artikel, via `download` (netguard, geen adres uit het verzoek). Antwoord `application/octet-stream` met sandbox-CSP, `no-store`.
- Browser (`artikelen/item-images.js`): `convertFailed` haalt de bytes op, zet ze met `createImageBitmap` en canvas om naar JPEG (max 1200 px) plus WebP-miniatuur en bewaart ze per artikel; een browser die AVIF niet kan lezen krijgt een duidelijke melding per artikel.
