---
titel: Openstaande taken op het dashboard
---

## Nieuws
- [beheer] Op het startscherm staat nu een blok "Openstaande taken" met de binnengekomen webshopbestellingen die nog niet verzonden zijn (de oudste vijf, met link naar elke bestelling).
- [voorraad] Hetzelfde blok toont de bestelvoorstellen die klaarstaan bij lage voorraad, artikelen onder het minimum zonder voorkeursleverancier en open prijsvoorstellen. Zonder openstaande taken verdwijnt het blok.

## Changelog
- Nieuw: `GET /api/tasks` (`platform/open-tasks.js`, ingelogd; taken volgen de rechten `beheer` en `voorraad`, per omgeving) en het dashboardblok `dashboard/tasks.js`. Nieuw: `webOrders.listUnprocessed` (status Nieuw; online alleen na betaling).
