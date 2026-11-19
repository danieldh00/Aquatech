---
titel: Artikelscherm overzichtelijker
---

## Nieuws
- [voorraad] Het artikelscherm is opnieuw ingedeeld: Gegevens staan in groepen naast elkaar (Basis, Prijzen en prijsbepaling, Voorraad en locatie, Verpakking en staffel, Webshop) en Mutatie boeken is een compacte balk over de volle breedte.

## Changelog
Alleen frontend (`frontend/artikelen/index.html` en `artikelen.css`): het formulier `#edit-form` blijft één formulier met dezelfde veldnamen, maar is verdeeld in `fieldset.item-group`-groepen in een raster (`.item-groups`); `#move-form` is een compacte rij (`.move-card`). Verkoopprijs blijft alleen-lezen bij prijsbepaling factor. Geen API- of databasewijziging.
