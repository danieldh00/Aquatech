---
titel: Orderpick: terugknop gaat naar de lijst
---

## Nieuws

- [orderpick] De terugknop van je telefoon of browser brengt je in een bestelling nu terug naar de lijst met bestellingen, in plaats van de app te verlaten.

## Changelog

Orderpick: een bestelling openen zet een eigen geschiedenisregel (`pushState`, `?id=`); `onPopState` toont bij terug de lijst en bij vooruit weer de bestelling. Het afronden van een pick vervangt de regel zoals voorheen (geen terugkeer naar een afgeronde bestelling). Tabbladen Ontvangen en Tellen blijven buiten deze wijziging. Test in `orderpick-modes.test.js`.
