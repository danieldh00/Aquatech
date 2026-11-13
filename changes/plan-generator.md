---
titel: Verzonnen tuinplannen om de herkenning te meten
---

## Changelog
`hub/backend/tools/plan-generator.js` (`node tools/plan-generator.js <map> [aantal] [eerste-seed]`) tekent verzonnen tuinontwerpen (gazon, borders, bomen, terras, woning, vijver, labels, titelblok; afwisselend digitaal en scan) met de bekende waarheid in `naam.json`, voor `npm run recog-bench`. De meetlat (`recog-metrics.js`) kent een eigen `layer` per vlak en toont de functionele nauwkeurigheid (gazon = sproeiers, beplanting = druppel, verharding/water = geen beregening). Geen effect op de app zelf.
