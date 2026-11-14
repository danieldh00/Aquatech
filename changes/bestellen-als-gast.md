---
titel: Bestellen in de webshop zonder account
---

## Nieuws
- Klanten kunnen in de webshop afrekenen zonder account: alleen naam, e-mailadres en adres invullen en direct online betalen. Je volgt je bestelling met de persoonlijke link in de bevestigingsmail en kunt daar ook een retour aanvragen of de factuur downloaden.
- Na de bestelling kan een klant alsnog een account maken door alleen een wachtwoord te kiezen; de bestelling staat dan in zijn account.
- [beheer] Onder Beheer > Webshop > Betalen staat een schakelaar *Bestellen zonder account toestaan*. Zakelijk bestellen, op rekening betalen en dropshipping blijven alleen met een account.

## Changelog
Bestellen als gast (webshop):
- Loginmuur op `afrekenen/` krijgt de keuze *Bestellen zonder account* (`?gast=1`) als online betalen werkt en `shopPayment.guestCheckout` (standaard aan) niet is uitgezet. Een gast is altijd een particulier (geen zakelijke prijzen, btw-verlegging, groothandel of dropshipping), betaalt altijd online en bestelt met dezelfde voorraadcontrole als een account.
- Gastbestelling: `web_orders.user_id` leeg, `data.guest` met de SHA-256 van het toegangstoken en het versleutelde token (geen migratie). Toegang via cookie `aquatech_gastbestelling` of de link `bestelling/<id>/?k=<token>` uit de bevestigings- en verzendmail, die tegen het cookie wordt ingewisseld en doorstuurt naar het adres zonder token. Verloopt na 180 dagen (of 90 na de laatste wijziging).
- Bestelpagina, betalen, factuur-PDF en retour (aanvragen en intrekken) werken ook voor een gast; zonder toegang toont een gastbestelling een neutrale pagina zonder gegevens.
- Limieten: 3 gastbestellingen per e-mailadres en 10 per bezoeker per uur.
- Na de bestelling optioneel een account maken (`POST bestelling/<id>/account`): koppelt alleen die bestelling, nooit op e-mailadres aan een bestaand account.
- GA4: `checkout_guest` bij het gastformulier en `checkout_type` op `purchase`.
- Tests: `guest-orders.test.js` (SQLite en PostgreSQL).
