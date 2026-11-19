---
titel: Bulkacties in de artikelenlijst
---

## Nieuws
- [voorraad] In de artikelenlijst kun je meerdere artikelen aanvinken en in één keer archiveren of er etiketten voor printen (aantal per artikel en sjabloon te kiezen).

## Changelog
Artikelenlijst (`frontend/artikelen/bulk.js`): selectiekolom met *alles selecteren* voor de zichtbare rijen en een balk met *Archiveren* (één bevestiging, per artikel de bestaande `PUT /api/stock/items/:id` met `archived`; een artikel op een open bestelling of werkorder blijft staan en wordt gemeld) en *Etiketten printen* (hoofdartikelen en gearchiveerde artikelen worden overgeslagen; `ItemLabels.print`, hoogstens 500 etiketten per keer). Geen nieuwe API of migratie; rechten (`voorraad`) en tenantfilter blijven die van de bestaande routes.
