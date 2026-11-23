---
titel: Uitbesteden veiliger
---

## Nieuws
- [uitbesteden] Een opdracht die je aan alle organisaties aanbiedt, gaat pas naar de aanvrager nadat jij die hebt bevestigd. Tot die tijd krijgt niemand de klantgegevens.
- [uitbesteden] Je kunt maximaal 20 opdrachten per uur aanbieden, en een organisatie krijgt per werkorder hoogstens één mail.

## Changelog
Audit B-28 en B-29 (Uitbesteden), geen migratie:
- Een open aanbod (aan iedereen) wordt bij "Aannemen" een aanvraag: `request` houdt het aanbod vast voor de aanvragende organisatie (`receiver_tenant_id` gevuld, `received_work_order_id` leeg = `pending`), de uitbesteder bevestigt (`POST /api/outsourcing/offers/:id/approve`, maakt dan pas de werkorder met klantgegevens) of wijst af (`…/reject`, het aanbod staat weer open voor anderen, de afgewezene komt in `declined`). De aanvrager kan zijn aanvraag zelf intrekken (`decline`). Een gericht aanbod blijft direct aan te nemen. Audit `opdracht_aangevraagd|bevestigd|aanvraag_afgewezen`.
- Het voorbeeld van een open aanbod toont de neutrale titel "Werkorder" (de titel kan klantgegevens bevatten).
- Aanbieden is begrensd op 20 per organisatie per uur (429 `rate_limited`, geteld uit `work_order_offers`) en een ontvanger krijgt per werkorder één aanbiedingsmail (`offeredBefore`), ook na intrekken en opnieuw aanbieden.
