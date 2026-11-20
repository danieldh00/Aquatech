---
titel: Database: extra indexen en controles op statussen
---

## Nieuws

## Changelog
Migratie 90 (database-doorlichting 2026-11-20): indexen op `work_orders(owner_id)`, `audit(user_id)`, `stock_cost_entries(item_id)`, `stock_count_entries(line_id)`, `support_grants`/`impersonations(tenant_id)`, functionele indexen op `lower(email)` van `web_orders` en `stock_alerts`; `stock_items_dirty` is nu een gedeeltelijke index (`WHERE shop_dirty = 1`); CHECK-constraints (NOT VALID, bestaande rijen blijven ongemoeid) op de status van `web_orders`, `web_returns` en `purchase_orders`.
