---
titel: Werkorder automatisch klaar bij akkoord
---

## Nieuws
- [werkorders, planning] Zodra een offerte akkoord is, staat de werkorder er automatisch: het materiaal is gereserveerd en hij wacht onder In te plannen. Je hoeft niet meer op Werkorder maken te klikken. In Openstaande taken zie je welke werkorders nog ingepland moeten worden. Uit te zetten in Beheer > Modules (Werkorders).

## Changelog
Werkorder automatisch klaarzetten bij akkoord (V-01). Na een akkoord (medewerker via status, klant via het portaal of de openbare link) maakt `workorders.createForAcceptedQuote` één werkorder met status `open` (zonder planning of uitvoerder, eigenaar = eigenaar van de offerte); daarna reserveert `stock.onWorkOrderChange` het materiaal en schrijft het auditlog `werkorder_automatisch_aangemaakt`. Er komt nooit een tweede werkorder als er al een van de offerte is; een fout laat het akkoord staan. Nieuwe instelling `autoWorkOrder` {enabled} (standaard aan, per omgeving) als schakelaar `werkorder-automatisch` bij Beheer > Modules (onderdeel van Werkorders). Nieuwe taak *Werkorders in te plannen* in `GET /api/tasks` (recht `planning`, module Planning aan; `workorders.listToSchedule`). De handmatige knop *Werkorder maken* blijft. Tests: `auto-work-order.test.js`.
