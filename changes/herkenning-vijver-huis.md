---
titel: Vijvers en huizen aan de tuinrand beter herkend zonder AI
---

## Nieuws
- Plannen lezen zonder AI herkent een lichtblauwe vijver nu als water en een huis dat tegen de rand van de tuin staat als bebouwing.

## Changelog
`localrecog.js`: kleur met tint vanaf 194,5° (lichtblauw) is water in plaats van haag; `paintEnclosedWhite` scheidt het witte huis van het papier via de donkere omtrek (`INK_LUMA`) en eist dat minstens 30% van de omtrek aan gekleurde vlakken grenst. Meting met de plangenerator: 10 bekende plannen functie 86% → 91%; 12 onbekende plannen (seed 101+) functie 90% → 91% (de eerste reeks is dus gedeeltelijk afgesteld, de tweede is de eerlijke maat). Tests in `localrecog.test.js`.
