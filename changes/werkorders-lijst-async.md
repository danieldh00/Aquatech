---
titel: Werkorderlijst laadt via de pool
---

## Nieuws

## Changelog

Doorlichtingspunt 13 (synchrone databasebrug afbouwen), vervolg: `workorders.listAsync` voert de lijstquery van `GET /api/workorders` uit via `db.async` (pool bij PostgreSQL), zodat een grote werkorderlijst de hoofdthread niet vasthoudt. `list` blijft voor de overige aanroepers (portaal, AI-koppeling); beide delen één querybouwer (`listQuery`) en één omzetting (`workOrdersFromRows`).
