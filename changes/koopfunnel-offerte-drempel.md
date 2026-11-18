---
titel: Drempelbedrag voor Offerte aanvragen instelbaar
---

## Nieuws
- [beheer] In Beheer > Webshop > Betalen stel je in vanaf welk bedrag (excl. btw) een zakelijke klant in de winkelwagen een offerte kan aanvragen (standaard 500 euro), of zet je Offerte aanvragen helemaal uit.

## Changelog
- Instelling `shopPayment` krijgt `quoteRequest` (standaard aan) en `quoteRequestMin` (1 tot 1.000.000 euro excl. btw, standaard 500, ongeldig = 500) in `sanitizePayment`; `quoteRequests.offered(tenantId, cart)` vervangt `qualifies(cart)` bij de knop en de route (`qualifies(cart, minimum)` blijft de zuivere controle). Geen migratie.
