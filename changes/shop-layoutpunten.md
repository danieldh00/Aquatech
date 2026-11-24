---
titel: Webshop: knoppen en pictogram op mobiel hersteld
---

## Nieuws
- De winkelwagenknop op productkaarten toont op een smal scherm weer het winkelwagenpictogram, de voorraadtekst is beter leesbaar en de zoekknop is groter om aan te tikken.

## Changelog
Layoutpunten L-04 t/m L-07 uit de layoutcheck: het winkelwagenpictogram staat als eigen bestand `assets/icon-winkelwagen.svg` (CSP `img-src 'self'` blokkeerde de data-URI), `.svg` is toegevoegd aan de shop-assets, knoppen erven het lettertype (`button { font-family: inherit }`), voorraadlabel op productkaarten minimaal 12 px, zoekknop 44 px breed en hoog op smalle schermen, en het inline `style` van het honeypotveld op Registreren en Planner is vervangen door de klasse `.trap`.
