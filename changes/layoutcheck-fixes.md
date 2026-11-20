---
titel: Kleine uitlijnfouten op mobiel hersteld
---

## Nieuws
- Op een telefoon loopt de pagina AI-kosten (Beheer) en de tabbladbalk van Uitbesteden niet meer buiten het scherm, en lange productnamen in de webshop worden niet meer afgekapt midden in een woord.

## Changelog
Gevonden door de nieuwe layoutcheck: `#tab-aikosten` velden `max-width: 100%`; `.tabs` op smal scherm `minmax(0, 1fr)` met afbreekbare tekst; `.product-name` `overflow-wrap: anywhere`. Zie `tests/layout/`.
