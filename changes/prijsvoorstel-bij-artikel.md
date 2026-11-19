---
titel: Prijsvoorstel goedkeuren bij het artikel
---

## Nieuws
- [voorraad] Na een nieuwe inkoopprijs zie je bij het artikel direct "Nieuwe verkoopprijs voorgesteld: oud → nieuw" met de knoppen Goedkeuren en Negeren. In de artikellijst staat een label Voorstel bij de verkoopprijs. De prijs verandert nooit vanzelf.

## Changelog
- `GET /api/stock/price-proposals` (recht `voorraad`) geeft de open prijsvoorstellen (`openProposals` in price-factor.js). Het artikelscherm toont een melding met Goedkeuren/Negeren (beheerders, via bestaande `apply`/`reject`) en de lijst een label. Geen migratie, prijslogica ongewijzigd.
