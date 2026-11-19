---
titel: Meldingenbelletje met teller in de kopbalk
---

## Nieuws
- [beheer] [voorraad] In de kopbalk staat nu een belletje met het aantal openstaande taken (bestellingen verwerken, bestelvoorstellen, prijsvoorstellen). Een klik toont de lijst en brengt je direct naar het juiste scherm; bij één openstaand punt ga je meteen naar dat punt.

## Changelog
- Nieuw: belletje in `dashboard/account.js` (`setupBell`, op elke pagina met kopbalk) op basis van `GET /api/tasks`; ververst bij openen en elke 3 minuten. Het dashboardblok deelt hetzelfde verzoek via `getJson`. Alleen met recht `beheer` of `voorraad`.
