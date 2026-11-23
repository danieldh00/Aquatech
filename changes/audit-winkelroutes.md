---
titel: Webshop: retour na account maken, pakbon-upload en afrekenlimiet
---

## Nieuws
- Een retour die je als gast hebt aangevraagd kun je ook intrekken nadat je een account hebt gemaakt.
- [beheer] De upload van een eigen pakbon (dropshipping) en het afrekenen zijn beter begrensd tegen overbelasting.

## Changelog
Audit 1.33.0, thema webshopbetalingen en facturen, deel 3. Geen migratie.

- **T-19** (`web-orders.js` `attachToUser`, `storefront.js`): bij het koppelen van een gastbestelling aan een account gaan de retouren van die bestelling mee (één transactie). De intrekroute zoekt de retour via de toegang tot de bestelling (`orderAccessOf`); een retour zonder eigenaar van een al gekoppelde bestelling is daardoor ook in te trekken, een retour van een ander account niet.
- **B-31** (`order-slips.js` `inspectSlip`): hoogstens twee controles tegelijk; een derde krijgt meteen 429 met `Retry-After` in plaats van nog een werkthread. Daarnaast hoogstens tien uploads per bestelling per minuut. De plek komt ook vrij als de werkthread zonder bericht stopt.
- **B-39** (`POST /afrekenen`): de limiet op bestelpogingen en de captcha staan vóór het doorrekenen van de wagen. Het bijwerken van het totaal (`action=update`, ook op de achtergrond) heeft een eigen limiet van 300 per uur per bezoeker, zodat gewoon invullen de bestelpogingen niet opmaakt.
- **Reviewpunt #422**: het plafond van twee onbetaalde gastbestellingen per e-mailadres telt alleen bestellingen die nog voorraad vasthouden; na de vasthoudtijd van 30 minuten is het adres weer vrij (iemand kan het adres van een ander dus niet langer hinderen). De query houdt `lower(email)`: dat is precies de index `web_orders_email (tenant_id, lower(email))`.
