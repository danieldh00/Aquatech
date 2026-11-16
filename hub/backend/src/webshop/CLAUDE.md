# Webshop (backend/src/webshop)

Alleen de regels voor deze map; het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term, lees niet alles).

- Webshop = `/`, app = `/app/`. Links in mails en SEO altijd via `publicBaseUrl` (`shopPayment.publicUrl`), nooit uit de Host-kop. De shop is nog niet live: niet indexeerbaar maken; een nieuwe openbare pagina die in zoekresultaten hoort geeft een `canonicalPath` mee.
- Prijzen: een zakelijke prijs altijd via `priceBusiness`/`priceCart`, nooit `business_price`/`sale_price` rechtstreeks. Groothandel = hoogste van staffel, klant en categoriekorting (niet opgeteld); particulier nooit categoriekorting. Bestelregels naar voorraad via `stockQtyOf`.
- Een nieuwe route op een bestelling gaat via `orderAccessOf`, niet `orders.getForUser` alleen. Een gast is altijd een particulier en betaalt altijd online.
- Bezorgen/afhalen: test op `method !== 'ophalen'`, nooit op `'dpd'`. Een pakbon via `pdfFor`, nooit `packingSlipsPdf` rechtstreeks. Wat nog geleverd moet worden via `remainingOf`/`withFulfilment`.
- Een nieuw openbaar formulier: captcha-actie in `ACTIONS`, `captchaGate` na de limiet en vóór het werk, `captchaFields`, en een limiet via `createRateLimiter`.
- Orderpick-routes (`/api/orderpick`): `requireRight('orderpick')`, nooit prijzen of adressen teruggeven.
- Een nieuwe instelling die een extern systeem aanstuurt: `liveOnly: true`. Een warme shoppagina kost 0 queries (`queries.test.js`).
- Tests: `test/helpers/webshop-world.js`, fakes `mollie-fake.js`, `vies-fake.js`, `pdok-fake.js`, `captcha-fake.js`.
