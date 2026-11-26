---
titel: Kleiner en veiliger image
---

## Changelog
Het runtime-image bevat geen npm en npx meer (verwijderd na `npm ci --omit=dev`): de Trivy-meldingen over de npm-eigen bibliotheken (sigstore, picomatch, pacote, brace-expansion, ip-address) gaan daarmee weg. De app en de hostscripts gebruiken alleen `node`.
