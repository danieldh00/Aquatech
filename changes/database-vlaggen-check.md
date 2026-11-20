---
titel: Database: vlaggen mogen alleen 0 of 1 zijn
---

## Changelog
Migratie 93 (database-doorlichting 2026-11-20, stap 2 van de opzet): 22 vlagkolommen (`stock_items.archived`, `shop_dirty`, `shop_sync`, `stock_managed`, `has_variants`, `users.disabled`, `platform_admin`, `tenants.disabled`, `news.pinned`, `visma_log.ok` en andere) krijgen een `CHECK (kolom IN (0, 1))`, `NOT VALID`: bestaande rijen worden niet gecontroleerd, nieuwe en gewijzigde wel. Bewust geen echte `boolean`-kolommen: de code schrijft en vergelijkt overal met 0 en 1, dus een omzetting levert risico en geen winst op.
