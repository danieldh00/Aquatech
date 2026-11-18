---
titel: Werkorders hangen aan een klant
---

## Nieuws
- [werkorders, klanten] Een werkorder hangt nu echt aan een klant uit de klantenlijst. In de werkorder kies je de klant (adres, e-mail en telefoon worden ingevuld) of ontkoppel je hem weer; de werkorder staat dan ook op de klantkaart.
- [werkorders, klanten] Bestaande werkorders zijn gekoppeld via hun offerte of melding. Met *Koppel op naam* in het werkorderoverzicht koppel je de rest als de naam bij precies één klant past (alleen als je op de knop klikt, dus een bewuste ontkoppeling blijft staan); werkorders zonder klant krijgen het label *Niet gekoppeld* en zijn te filteren.
- [werkorders] De AI-koppeling zet bij een werkorder de gekozen klant (klantId) nu ook echt vast.

## Changelog
- Migratie 79: `work_orders.customer_id` (verwijzing naar users, index `(tenant_id, customer_id)`), gevuld uit `quotes.customer_id` en `service_requests.customer_id`. Werkorderdata (`customer.*`) blijft de momentopname voor werkbon en pdf.
- `workorders.create/createReceived/update` nemen `customerId`; `update` laat de koppeling staan bij `undefined`. API: `customerId` in `PUT /api/workorders/:id` (recht `klanten`, klant moet een actieve klant van de organisatie zijn), `GET /api/workorder-customers`, `POST /api/workorders/link-customers` (`workorders.autoLink`: alleen een eenduidige, exacte naam of bedrijfsnaam, alleen op de knop, nooit automatisch op de achtergrond zodat een bewuste ontkoppeling blijft). Werkorderantwoord heeft `customerId` en `customerAccount`.
- Klantkaart (`customers.overview`) toont ook werkorders met `customer_id`; verwijderen van een klant ontkoppelt zijn werkorders; MCP `maak_concept_werkorder` en `plan_omzetten` geven `customerId` door. Het klantportaal en de planning zijn ongewijzigd.
