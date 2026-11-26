---
titel: Aantal artikelen per pagina kiezen
---

## Nieuws
- [voorraad] In de artikellijst kies je nu hoeveel artikelen er per pagina staan (25, 50, 100, 300 of alles) en blader je met Vorige en Volgende. Je keuze wordt onthouden.

## Changelog
Artikelen (`frontend/artikelen`): het voorraadoverzicht is gepagineerd in de browser (`paginate`, `renderPager`). Keuze per pagina in localStorage `aquatech_artikelen_paginagrootte` (standaard 50, 0 = alles); een hoofdartikel blijft met zijn open varianten op één pagina; zoeken of filteren begint weer op pagina 1. Geen migratie en geen API-wijziging.
