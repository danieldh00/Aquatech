---
titel: Meetlat voor de planherkenning zonder AI
---

## Changelog
- `backend/src/beregening/recog-metrics.js`: zuivere meetfuncties (rasteroverlap per vlaksoort, nauwkeurigheid, gazonverhouding, schaalfout, elementafstand) om de lokale herkenning met een referentie (AI-uitkomst of goedgekeurd plan) te vergelijken.
- `backend/tools/recog-bench.js` (`npm run recog-bench [map] [--json]`): draait de lokale vlakherkenning over `naam.png` + `naam.json` in een map en toont per tekening de afwijking. Geen netwerk, geen AI. Eerste referentie: het voorbeeldplan in `test/fixtures`.
- Eerste stap van het plan om de planner zonder AI te laten werken; de volgende stappen verbeteren de herkenning steeds aan de hand van deze meetlat.
