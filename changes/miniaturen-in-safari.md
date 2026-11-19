---
titel: Miniaturen van artikelfoto's maken ook in Safari
---

## Nieuws
- [voorraad] *Afbeeldingen en miniaturen* maakt de miniaturen nu ook in Safari (iPhone, iPad, Mac). Safari kan geen WebP maken, dus daar wordt de miniatuur een JPEG. Bij een eerdere poging gemaakte afbeeldingen krijgen bij een nieuwe run alsnog hun miniatuur.

## Changelog
- `artikelen/item-images.js` (server): `setThumb` accepteert naast WebP ook JPEG (zelfde grenzen: 480 px, 100 kB, controle op inhoud); `thumbFile` herkent het formaat aan de bytes en levert het juiste `Content-Type`.
- Browser (`makeThumb`): probeert WebP en valt terug op JPEG als de browser WebP niet kan coderen.
