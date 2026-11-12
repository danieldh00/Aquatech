---
titel: Mijn profiel netjes uitgelijnd
---

## Nieuws
- Op Mijn profiel staan de kaarten en velden nu netjes onder elkaar op één lijn, op computer en telefoon. Kaarten in een rij zijn even hoog en de knoppen staan onderaan.

## Changelog
- `profiel/index.html` en `profiel.css`: gedeelde klassen uit `shared/layout.css` (`.form-grid`, `.field`, `.form-actions`) i.p.v. eigen marges; kaarten zijn flexkolommen met één tussenruimte, rijen even hoog (`align-items: stretch`), AI-koppeling over de volle breedte; het losse `.form-foot` en de `grid-row: span 2` van de persoonlijke gegevens zijn vervallen.
