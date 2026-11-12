---
titel: Verzendmethode kiezen bij het afrekenen
---

## Nieuws
- Bij het afrekenen in de webshop kies je de verzendmethode in een keuzelijst: bezorging door DPD, per pallet, met eigen transport, of Afhalen in Nunspeet (gratis). Afhalen staat nooit vooraf gekozen. De kosten staan als verzendregel op de bestelling.
- [beheer] In Beheer > Instellingen > Verzending zet je per methode aan of uit, geef je hem een eigen naam en stel je de tarieven per land en gewicht in, met gratis vanaf een bedrag. Pallet en eigen transport staan standaard uit.

## Changelog
Geen migratie. `shopShipping` (shipping.js) kent nu `dpd`, `pallet` en `eigen` (elk `enabled`, `label`, `zones`), `pickup` (standaardnaam *Afhalen in Nunspeet*) en `defaultWeightGrams` op het hoogste niveau (valt terug op de oude plek bij `dpd`). `optionsFor` geeft de bezorgmethodes die aan staan en afhalen als laatste; `countriesOf` voegt de landen van alle methodes samen; `defaultMethod` kiest vooraf de gevraagde methode, anders de eerste bezorgmethode die kan, en afhalen alleen als er niets anders is. Afrekenen: keuzelijst met de toelichting en reden per methode (`storefront-order-pages.js`, `afrekenen.js` leest de keuzelijst). Bezorgcontroles (adres via PDOK, land van het factuuradres, btw verleggen naar een EU-land) gelden nu voor elke methode behalve afhalen; de volgcode blijft alleen voor DPD. Beheer: een blok per bezorgmethode.
