---
titel: Tabellen kloppen op de telefoon en producttekst bij het artikel
---

## Nieuws
- Tabellen (zoals de prijshistorie en voorraadlagen van een artikel) blijven op de telefoon binnen hun kaart en scrollen zijdelings.
- [voorraad] De producttekst van een artikel schrijf, controleer en keur je nu goed in het artikel zelf. Het tabblad Teksten blijft voor in bulk concepten schrijven en opent het artikel om te beoordelen.

## Changelog
- Gedeeld tabelpatroon (`beheer/beheer.css`): `.tablewrap` krijgt `max-width: 100%`, kaarten/panelen/rasterkinderen mogen krimpen (`min-width: 0`), en rasterkolommen met `minmax(Npx, 1fr)` (N ≥ 200) in alle CSS gebruiken `minmax(min(100%, Npx), 1fr)` zodat ze een telefoon niet verbreden. `test/mobile-tables.test.js` bewaakt dit.
- Producttekst-blok (`#tx-detail`) verhuisd naar het artikelscherm (`item-texts.js` `showItem`); `GET /api/stock/item-texts/:itemId` geeft nu ook `ai` (aan/sleutel/dagrest). Zelfde backend, feitencontrole, bevestiging bij waarschuwingen en goedkeuring. Varianten en gearchiveerde artikelen krijgen het blok niet. Het tabblad Teksten opent het artikel bij Beoordelen.
