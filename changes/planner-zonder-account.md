---
titel: Planner direct gebruiken zonder account
---

## Nieuws
- De knop Planner in de webshop opent de planner meteen, zonder eerst een account te maken. Je tekent, plaatst sproeiers en zet het materiaal in je winkelwagen. Een account heb je pas nodig om je ontwerp te bewaren of te bestellen.
- In de planner zonder account staat de knop Ontwerp bewaren met account. Na registreren of inloggen staat je ontwerp er gewoon.

## Changelog
`GET /planner/` stuurt bezoekers zonder inlog naar `app/beregening/?tekenen` (het aanmeldformulier blijft bereikbaar met `?account=1`). De planner neemt na het inloggen het lokale ontwerp zonder account over (`_adoptAnonymousDraft`, alleen in een leeg plan, daarna wordt de lokale kopie gewist). Knop *Ontwerp bewaren met account* in de balk van de planner zonder account. AI blijft uit voor anonieme bezoekers; de bestaande limieten op de openbare routes gelden.
