---
titel: Klant zonder KvK-nummer en buitenlandse klant
---

## Nieuws
- [klanten] Een zakelijke klant kan nu zonder KvK-nummer worden aangemaakt, bijvoorbeeld een buitenlands bedrijf.
- [klanten] Bij een btw-nummer uit een ander EU-land dat bij VIES geldig is, typ je het adres van de klant zelf in.

## Changelog
- `sanitizeBusinessProfile(input, { kvkRequired })`: de klantenmodule (`POST|PATCH /api/customers`) vraagt geen KvK-nummer meer; een ingevuld nummer moet nog steeds uit 8 cijfers bestaan. De webshopregistratie en Beheer > Gebruikers houden het KvK-nummer verplicht.
- Klantadres vrij te typen als het btw-nummer (uit het verzoek, anders van de klant) een geldig nummer van een ander land is en VIES het geldig noemt (`checkForeignVat`, max. 20 nieuwe vragen per minuut per gebruiker). Onbereikbaar, ongeldig of een Nederlandse postcode: de PDOK-controle blijft gelden.
- Klantenscherm zet het adresveld op vrij typen bij een buitenlands btw-nummer.
