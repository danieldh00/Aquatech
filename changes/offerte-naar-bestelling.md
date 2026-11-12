---
titel: Offerte omzetten naar een bestelling
---

## Nieuws
- [beheer] Een geaccordeerde offerte zet u met één knop om in een bestelling: *Omzetten naar bestelling*. De regels, de korting, btw verlegd, de betaaltermijn, de documenttaal, de klant en het afleveradres van de offerte gaan mee. De offerte staat daarna als *Omgezet* in de lijst, met een link naar de bestelling (en andersom), en ligt vast.
- [beheer] De factuur van zo'n bestelling houdt de betaaltermijn en de taal van de offerte aan.

## Changelog
- Nieuw `verkoop/quote-orders.js`: `POST /api/quotes/:id/convert` (recht `offertes` én `beheer`) maakt in één transactie een `web_orders`-bestelling (`createFromQuote` in web-orders.js) en koppelt hem aan de offerte met `quotes.order_id`/`converted_at` (migratie 65, unieke index per organisatie); twee gelijktijdige verzoeken geven één bestelling (409 `already_converted`).
- Prijzen en voorwaarden komen uit de offerte, niet uit de webshop. Regels met een bekende artikelcode (ook `CODE@VERPAKKING`) reserveren voorraad, ook bij een tekort (het antwoord geeft `shortages`); vrije regels (arbeid, tekst) niet. De korting wordt een negatieve regel per btw-tarief, `order.totals` is exact het offertetotaal. Btw verlegd, klantgroep, `paymentDays` en `language` staan op de bestelling.
- Afleveradres: `data.delivery` van de offerte wordt `address` (aflevering) met `billingAddress` = het adres van de klant en `deliverySame` (zoals bij de webshop sinds #199). De interne notitie van de offerte en de notities per regel gaan nooit mee.
- Een omgezette offerte is vergrendeld (PUT geeft 409 `locked`); `quote.order` ({ id, number, convertedAt }) staat alleen in de medewerkersweergave, nooit in de klantweergave. De status in de database blijft `akkoord` (weergave *Omgezet*), dus werkorders en het portaal blijven werken.
- `fromWebOrder` neemt van een bestelling uit een offerte de betaaltermijn en documenttaal over en verwijst in de referentie naar de offerte. Webshopbestellingen zijn ongewijzigd.
- Bestellingen in Beheer tonen de offerte, `?id=` opent direct een bestelling.
