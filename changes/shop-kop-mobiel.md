---
titel: Compactere webshopkop op mobiel
---

## Nieuws
- Op de telefoon staan logo, klantenservice, beheer, account en winkelwagen van de webshop nu op één rij met de zoekbalk er direct onder; de mededelingenbalk is kleiner.

## Changelog
Oorzaak van de lege ruimte: de klasse `.cart` van de winkelwagenpagina (marge 24px, max-breedte) viel ook op de winkelwagenknop in de kop; nu `.shop-main .cart`. Mobiele webshopkop (`storefront.css`, ≤ 800 px): kleiner logo en iconen, knoppen met minder opvulling, winkelwagenteller over het icoon, kleinere mededelingenbalk, zodat de kop niet meer over twee rijen met een lege ruimte valt.
