---
titel: Database: reserveringen verwijzen echt naar hun werkorder of bestelling
---

## Nieuws

## Changelog

- Migratie 96: een voorraadreservering hoort bij een werkorder óf een webshopbestelling. De tekstkolom `work_order_id` met `order:<id>` is gesplitst in `work_order_id` en `web_order_id`, elk met een echte verwijzing (de reservering verdwijnt mee met de order) en een controle dat precies één is gevuld. Reserveringen van orders die niet meer bestaan worden bij de migratie verwijderd. Een back-up van vóór deze migratie wordt bij het terugzetten automatisch gesplitst.
