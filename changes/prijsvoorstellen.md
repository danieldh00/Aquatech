---
titel: Prijsvoorstellen bij een nieuwe inkoopprijs
---

## Nieuws
- [beheer] Een nieuwe inkoopprijs past de verkoopprijs niet meer vanzelf aan. Bij artikelen met prijs volgens factor komt er een prijsvoorstel (op basis van de ingestelde factor en afronding) onder Inkoop > Prijsfactor. Je keurt het per artikel of voor alles tegelijk goed, of wijst het af. Een afgewezen voorstel komt pas terug als de inkoopprijs verandert. Goedgekeurde prijzen gaan naar de webshop.

## Changelog
- Migratie 68: tabel `price_proposal_rejections` (één afwijzing per artikel: inkoopprijs + voorgestelde prijs), in SQLite en PostgreSQL.
- `artikelen/price-factor.js`: het voorbeeld is nu de lijst met prijsvoorstellen (`rejected`, `changedCount` = open, `rejectedCount`); `POST /api/stock/price-factors/reject` en `/reopen` (recht `beheer`, audit `prijsvoorstel_afgewezen`/`prijsvoorstel_heropend`); afwijzen en goedkeuren controleren de voorgestelde prijs opnieuw (verouderd = overgeslagen); doorvoeren wist de afwijzing.
- `stock.update`: een gewijzigde inkoopprijs rekent de verkoopprijs niet meer meteen; alleen een wijziging van modus of eigen factor doet dat. Artikelen met een vaste prijs krijgen geen voorstel.
- Tabblad Prijsfactor: knoppen Goedkeuren en Afwijzen per regel en voor de selectie, Heropenen bij afgewezen voorstellen.
