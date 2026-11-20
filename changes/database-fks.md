---
titel: Database: foreign keys op de belangrijkste verwijzingen
---

## Nieuws

## Changelog
Migratie 92 (database-doorlichting 2026-11-20): `NOT VALID` foreign keys (DEFERRABLE) op `invoices` (werkorder, offerte, klant, debiteur), `work_orders.quote_id`, `stock_items.parent_id`, `service_requests` (werkorder, klant), `oauth_grants.user_id` (ON DELETE CASCADE: koppelingen verdwijnen met het account) en `news.author_id`. Bestaande rijen worden niet gecontroleerd; nieuwe en gewijzigde rijen wel. Verwijzingen die leeg mogen zijn gaan bij verwijderen van het doel naar NULL. Bewust niet gedaan: `quotes.plan_id`, `work_orders.plan_id`, `stock_items.image_id`, `ai_usage.user_id` en `invoice_payments.invoice_id` (de API accepteert daar waarden zonder bestaande rij; eerst invoer valideren, zie de database-doorlichting).
