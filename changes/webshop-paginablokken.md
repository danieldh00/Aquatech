---
titel: Webshoppagina's bouwen met blokken
---

## Nieuws
- [beheer] Nieuwe pagina's voor de webshop maak je nu zonder code in Beheer > Webshop-inhoud > Pagina's: bouw ze uit blokken (tekst, afbeelding, artikelen, veelgestelde vragen en een knop met tekst), zet ze in de gewenste volgorde en bekijk eerst het voorbeeld.
- [beheer] Veelgestelde vragen op een pagina komen ook als gestructureerde gegevens (FAQPage) in de pagina, en pagina's met een korte omschrijving staan met die omschrijving in llms.txt (zodra de webshop is vrijgegeven voor zoekmachines).

## Changelog
- Pagina's in `shop_content` bewaren hun inhoud als `blocks` (nieuw bestand `webshop/page-blocks.js`: `text`, `image`, `products` (codes of categorie), `faq`, `cta`; maximaal 40 blokken, 40 vragen per FAQ-blok, 12 artikelen). Een pagina met alleen `body` krijgt die tekst als één tekstblok (`blocksOf`, `normalizePage`).
- `contentPage` tekent de blokken (`renderPageBlocks`) en zet FAQPage-gegevens uit alle FAQ-blokken (voor `veelgestelde-vragen` zonder FAQ-blok nog steeds uit de koppen). Wat in de gegevens staat, staat ook zichtbaar op de pagina.
- `llms.txt` toont de omschrijving van een pagina. Sitemap en `llms.txt` bestaan nog steeds alleen als de shop is vrijgegeven; een concept komt er nooit in.
- Editor in `beheer/webshop-inhoud.js` met blokken toevoegen, verplaatsen en verwijderen. Geen migratie.
