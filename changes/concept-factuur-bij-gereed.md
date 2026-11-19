---
titel: Conceptfactuur klaar zodra een werkorder Gereed is
---

## Nieuws
- [facturen] Zet je een werkorder op Gereed, dan staat er meteen een conceptfactuur klaar met de offerteregels, uren en materiaal. Je controleert hem en maakt hem zelf definitief. Uit te zetten bij Facturen > Instellingen.

## Changelog
Doorlichtingspunt 22. Instelling `invoicing.draftOnDone` (standaard aan, `InvoiceCore.sanitizeSettings`): bij de overgang van een werkorder naar `gereed` via `PUT /api/workorders/:id` maakt `draftOnDone` (verkoop/invoices.js, hergebruikt `createDraftFromWorkOrder`, de opbouw van `POST /api/invoices`) een conceptfactuur, alleen als de werkorder nog geen factuur heeft en er regels zijn; nooit definitief of verstuurd. Een tweede keer opslaan als Gereed maakt niets bij. Een fout houdt het opslaan van de werkorder niet tegen. Audit `factuur_concept_bij_gereed`. Test: `test/invoice-draft-on-done.test.js`.
