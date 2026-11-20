---
titel: Backupleverancier zichtbaar bij een niet-leverbare voorkeur
---

## Nieuws
- [voorraad] Staat de voorkeursleverancier van een artikel op niet leverbaar, dan zie je dat op het artikel zelf, met de backup waar het bestelvoorstel nu bestelt.
- [voorraad] In het blok met automatische voorstellen staat bij elke regel die bij een backup wordt besteld een melding met het meerprijsverschil.
- [voorraad] Bij de leveranciers van een artikel maak je met één klik een andere leverancier de voorkeur.

## Changelog
- `annotateBackups` (purchase-orders.js): backup-melding (`backup` met `preferredUnavailable`) op de regels van `proposals()`, twee queries voor alle voorstellen samen.
- Artikelen > Leveranciers per artikel: melding boven de tabel (`#d-sup-notice`) en de knop *Maak voorkeur*; bestelvoorstelblok toont de backup-melding.
