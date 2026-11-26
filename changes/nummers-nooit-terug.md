---
titel: Nummers van gewiste offertes en werkorders komen nooit terug
---

## Nieuws
- [beheer] Als een offerte of werkorder op verzoek definitief wordt gewist (AVG), krijgt een nieuw document nooit meer dat nummer.

## Changelog
- `quotes.purge` en `workorders.purge` leggen het volgnummer vast in `number_floors`, zodat de nummergenerator er altijd boven blijft; de test voor werkorders is aangepast.
