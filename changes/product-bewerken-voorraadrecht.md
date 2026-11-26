---
titel: Bewerken-knop alleen met voorraadrecht
---

## Changelog
De knop *Bewerken in beheer* op de productpagina verschijnt alleen voor accounts met het recht `voorraad` (of een hoofdbeheerder), niet meer voor elke medewerkersrol. `viewer()` geeft daarvoor `canStock`; de test dekt een planner zonder voorraadrecht.
