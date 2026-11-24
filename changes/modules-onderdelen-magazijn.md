---
titel: Onderdelen van Magazijn en inkoop apart aan of uit
---

## Nieuws
- [beheer] In Beheer > Modules aan/uit kun je bij Artikelen en voorraad nu ook Etiketten, Voorraadtelling, Goederenontvangst en Inkooporder inlezen met AI apart uitzetten. Wat uit staat verdwijnt uit het scherm.

## Changelog
- Schakelaars `etiketten`, `voorraadtelling` en `inkoop-inlezen` (onderdelen van de module voorraad) en een eigen schakelaar voor `ontvangst`; de adressen van een uitgezet onderdeel geven 409 `module_off`.
- `data-feature="<id>"` op een element verbergt het als de module of het onderdeel uit staat (`applyFeatures` in dashboard/modules.js, aangeroepen door de zijbalk).
