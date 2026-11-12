---
titel: Menubalk van de webshop altijd op één regel
---

## Nieuws
- De menubalk van de webshop (met Groothandel erbij) blijft op één regel; op smallere schermen worden ruimte en letter iets kleiner.

## Changelog
Webshop `storefront.css`: `.nav-bar` wikkelt niet meer (`flex-wrap: nowrap`, items `white-space: nowrap`), en onder 1180 px en 980 px worden padding, lettergrootte en de minimumbreedte van *Product zoeken* kleiner. Onder 800 px blijft het mobiele menu.
