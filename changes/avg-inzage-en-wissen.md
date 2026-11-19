---
titel: AVG-inzage en wissen per persoon
---

## Nieuws
- [beheer] Op de klantkaart staat een kaart Privacy (AVG): met één klik een Excel met alle persoonsgegevens van de klant (inzage), en een wisfunctie die de gegevens anonimiseert na bevestiging met de naam van de klant. Definitieve facturen en de stukken waarop ze rusten blijven zeven jaar bewaard.

## Changelog
- Nieuw: `verkoop/person-data.js` met `GET /api/customers/:id/privacy-export` (Excel) en `POST /api/customers/:id/anonymize` (bevestiging met de naam, geweigerd bij openstaande bestellingen of werkorders), recht `beheer`, audit `klant_inzage_export` en `klant_geanonimiseerd`.
- Anonimiseren: account (lege huls zonder inlog), offertes, werkorders, conceptfacturen, bestellingen, retouren, meldingen met foto's, plannen, debiteuren, voorraadmeldingen en IP-adressen. Bewaard blijven definitieve facturen met de offerte, werkorder, bestelling en debiteur waarop ze rusten.
