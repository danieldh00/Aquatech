---
titel: Voorraadtelling: tellen met verpakkingen
---

## Nieuws

- [orderpick] Bij het tellen van een artikel met verpakkingen (bijvoorbeeld bundels of pallets) vul je het aantal per verpakking in, naast losse stuks. De app rekent het totaal voor je uit.

## Changelog

Voorraadtelling, fase 5 (verpakkingsinvoer): `stockCounts.blindLines` geeft per regel de actieve verpakkingen (`packagings` met naam en factor, nooit prijzen; één query via `packagingsByItem`). Het tellen in de orderpick-app toont per verpakking een aantalveld naast *Losse stuks*; `Core.totalOf` rekent aantal × factor + los om naar één getal in de basiseenheid, dat zoals altijd als `qty` met `clientId` wordt opgeslagen (de server en het logboek veranderen niet). Offline tellen blijft een eigen vervolg (raakt `offline-core.js` en `sw.js`). Bereik per locatie bestond al bij het starten van een tussentijdse telling. Tests: `stock-counts.test.js`, `counting-core.test.js`.
