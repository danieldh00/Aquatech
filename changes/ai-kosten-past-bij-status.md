---
titel: AI-kosten tellen Past bij niet meer als mislukt
---

## Nieuws
- [beheer] Bij AI-kosten stonden alle opzoekingen van Past bij ten onrechte als mislukt. Dat is hersteld, ook voor de oude regels. De tekst boven het scherm noemt nu het standaardmodel en meldt dat Past bij een eigen model heeft.

## Changelog
`related-routes.js` gaf de uitkomst van het opzoeken (`gevonden`/`niet_gevonden`) door als status van het verzoek aan `aiUsage.record`; alles behalve `ok` telt als mislukt. Nu wordt alleen model en verbruik doorgegeven. `ai-usage.js` behandelt bestaande regels met die twee statussen als gelukt (telling en weergave), zonder migratie. Test: `related-items.test.js` controleert dat alleen de echt mislukte aanvraag meetelt.
