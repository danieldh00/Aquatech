---
titel: Creditfactuur van een retour direct bij goedkeuren
---

## Nieuws
- [facturen, beheer] Nieuwe instelling in Facturen > Instellingen: de creditfactuur van een webshopretour kan nu al bij het goedkeuren worden gemaakt, in plaats van pas bij Afronden. Standaard staat dit uit.

## Changelog
Instelling `invoicing.webOrders.creditOnApproval` (standaard uit, geen migratie). Staat hij aan, dan roept `POST /api/admin/web-returns/:id/decision` bij goedkeuren `webOrderInvoices.creditReturn` aan (idempotent: Afronden maakt geen tweede creditnota; een mislukking staat als `creditError` bij de retour en blokkeert het goedkeuren niet). Voorraad komt nog bij Afronden terug. Test in `test/web-returns.test.js`.
