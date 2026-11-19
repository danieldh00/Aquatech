---
titel: Bulkacties in de factuurlijst
---

## Nieuws
- [facturen] In het factuuroverzicht kun je meerdere facturen aanvinken, ze in één keer per e-mail versturen en de selectie naar Excel exporteren.

## Changelog
Factuurlijst (`frontend/facturen/`): selectiekolom, bulkbalk en knop *Exporteer naar Excel* (selectie, of alle zichtbare facturen zonder selectie). *Versturen per e-mail* loopt per definitieve factuur over de bestaande routes `GET /api/invoices/:id/mail` (voorstel) en `POST /api/invoices/:id/send`, met één bevestiging vooraf; facturen zonder e-mailadres en fouten worden per factuur gemeld en overgeslagen, zonder mailserver stopt de ronde. Geen nieuwe API of migratie.
