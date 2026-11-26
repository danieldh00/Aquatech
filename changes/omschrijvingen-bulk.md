---
titel: Productomschrijvingen in één keer schrijven met AI
bump: minor
---

## Nieuws
- [voorraad] Artikelen > Teksten heeft nu *Alles in één keer schrijven*: de AI zoekt de kenmerken van elk artikel op in de bron van de fabrikant en schrijft daar één natuurlijke omschrijving van, alleen met feiten uit die bron en de gegevens van Past bij. Je ziet vooraf de geschatte kosten en kunt het model kiezen (Sonnet is de standaard).
- [voorraad] Heeft een artikel al een omschrijving, dan beoordeelt de AI of de nieuwe beter is. Alleen dan wordt hij vervangen; per artikel staat zichtbaar of de tekst nieuw, overschreven of behouden is, en de vorige tekst kun je terugzetten. Een tekst met een getal of bewering die niet in de gegevens staat gaat niet live maar wordt een concept.

## Changelog
Nieuw: `artikelen/item-text-bulk.js` (routes `bulk/todo`, `bulk/run`, `bulk/model`, `:itemId/restore`), `item-text-log.js` (kenmerken en logboek in `item_specs.specs`, geen migratie), `researchFeatures` + `validateFeatures` (kenmerken met bron), `buildFacts` neemt de specificaties en kenmerken van Past bij mee, nieuwe schrijfstijlregels en een oordeel over de bestaande omschrijving (`verdict`) in `item-text-writer.js`, instelling `descriptionAiModel` (standaard Sonnet; het schrijven gebruikte eerder `aiModel`), feature `kenmerken_opzoeken` in de AI-kosten, tabblad Teksten met bulkblok, markering en filter per artikel. Past bij bewaart kenmerken en logboek bij het opslaan van nieuwe specificaties en zoekt artikelen met alleen kenmerken nog op. Kostenrem: dagplafond `descriptionBulkDailyItems` (standaard 2000 artikelen) en 120 verzoeken per uur; gelijktijdige runs slaan een artikel in behandeling over en een tekst wordt alleen overschreven als de bestaande omschrijving nog gelijk is aan die waarop de AI oordeelde. Tests: `item-text-bulk.test.js`.
