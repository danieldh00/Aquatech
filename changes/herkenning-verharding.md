---
titel: Betere herkenning van huis en terras zonder AI
---

## Nieuws
- Plannen lezen zonder AI herkent een woning (wit vak met omtrek) en egale terrassen (baksteen, hout) nu als verharding in plaats van als beplanting of niets, zodat daar geen sproeiers of druppelslang komen.

## Changelog
`localrecog.js`: `paintEnclosedWhite` zet een compact, rondom door kleur omsloten wit vak (≥ 1,5% van het beeld, niet aan de rand) op verharding; in `classMap` wordt een warme beplantingskleur zonder textuur (`TEX_FLAT`) verharding. Gemeten met de plangenerator op 10 verzonnen plannen (`npm run recog-bench`): functionele nauwkeurigheid 76% → 86%, juist benoemd 40% → 50%, gazon-overlap gelijk (87%). Test in `localrecog.test.js`. Geen wijziging van de leerbak (`FEATURE_VERSION` blijft).
