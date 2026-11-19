---
titel: Kengetallen op het beheerdersdashboard
---

## Nieuws
- [beheer] Het startscherm toont voor beheerders vier kengetallen: openstaand bedrag, vervallen facturen, open offertes en de bezetting van deze week.

## Changelog
Blok *Kengetallen* op het dashboard (`dashboard/kpis.js`, `GET /api/kpis`, `platform/kpis.js`, geen migratie): alleen met recht
`beheer`; elke tegel hoort bij een recht (`facturen`: openstaand bedrag incl. btw van definitieve facturen en credits, vervallen
facturen; `offertes`: verzonden offertes zonder antwoord; `planning`: werkorders met een geplande datum in de huidige week
(maandag-zondag, geannuleerde niet) en het aantal uitvoerders). Een aggregatiequery per tegel op `tenant_id`; de tegels linken
naar de module. Test: `test/kpis.test.js`.
