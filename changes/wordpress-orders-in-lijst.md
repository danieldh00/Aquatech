---
titel: WordPress-bestellingen zichtbaar bij Webshopbestellingen
---

## Nieuws
- [voorraad, beheer] Bij Webshopbestellingen staan nu ook de bestellingen uit de oude WordPress-webshop, met het label WordPress en een filter op bron. Ze zijn alleen om te bekijken: er gaat niets terug naar WordPress en er raakt geen voorraad, factuur of mail aan vast.

## Changelog
- Migratie 102: tabel `wp_orders` met de kopgegevens (nummer, status, besteldatum, klant, totaal, betaalmethode) van de WordPress-bestellingen; de ophaalcursor van `wp_order_import` gaat terug, zodat de eerstvolgende ronde de koppen van de al opgehaalde bestellingen aanvult (regels en klanten blijven ongemoeid). `wp-order-history.js` schrijft de kop van elke echte bestelling weg (alle statussen behalve concept en prullenbak) en werkt status en totaal bij.
- `GET /api/admin/web-orders?bron=alle|systeem|wordpress` (standaard `systeem`, dus bestaande aanroepen veranderen niet) voegt de WordPress-bestellingen op tijd samen met de eigen bestellingen (`listWithWordPress`, `UNION ALL`); statusfilter `wp-<status>` voor WordPress; WordPress heeft geen archief. `GET /api/admin/web-orders/wordpress/:id` geeft één bestelling met regels (alleen lezen).
- Frontend: bronkeuze (verschijnt zodra er WordPress-bestellingen zijn), label en alleen-lezen detail; de Excel-export blijft beperkt tot de eigen webshop.
