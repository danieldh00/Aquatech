---
titel: Bulkacties in de offertelijst
---

## Nieuws
- [offertes] In het offerteoverzicht kun je meerdere offertes aanvinken: exporteer alleen de selectie naar Excel of sluit alle open offertes in één keer af als afgewezen.

## Changelog
Offertelijst (`frontend/offertes/`): selectiekolom met *alles selecteren* voor de zichtbare rijen, balk met bulkacties (*Afsluiten als afgewezen* voor concept en verzonden offertes die niet zijn omgezet, één bevestiging, per offerte `PUT /api/quotes/:id` met status; fouten per offerte worden gemeld en overgeslagen) en Excel-export van alleen de selectie. Geen nieuwe API of migratie; rechten en de vergrendeling bij een klantreactie blijven die van de bestaande route.
