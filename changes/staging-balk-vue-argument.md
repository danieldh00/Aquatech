---
titel: Stagingomgeving herkenbaar en niet indexeerbaar
---

## Changelog
- Met `AQUATECH_STAGING=1` krijgt elk antwoord `X-Robots-Tag: noindex, nofollow, noarchive` en de kop `X-Aquatech-Staging`; `shared/common.js` toont dan een vaste balk "STAGING" (stijl in `brand.css`). Zonder de schakelaar verandert er niets.
- Dockerfile: bouwargument `VUE_MODULES` (standaard leeg; het productie-image blijft gelijk). Gevuld faalt het nog duidelijk, tot de eerste Vue-module de bouwstap toevoegt.
