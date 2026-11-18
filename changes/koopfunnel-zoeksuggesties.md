---
titel: Zoeksuggesties en zoektermen zonder resultaat
---

## Nieuws
- [beheer] In de webshop verschijnen onder het zoekveld na twee tekens een paar passende producten. Bezoekers komen zo sneller bij het goede artikel.
- [beheer] Bij Webshopbestellingen staat een nieuw tabblad Zoektermen: wat bezoekers zochten zonder iets te vinden, met een Excel-export. Zo zie je welk artikel ontbreekt.

## Changelog
- Migratie 77 (`shop_search_misses`, SQLite en PostgreSQL): per omgeving en genormaliseerde term een teller; alleen de term, nooit wie zocht. Termen met een e-mailadres of een lang cijfer, kortere dan 2 of langere dan 40 tekens worden niet bewaard; hoogstens 500 termen per omgeving (de minst gezochte valt weg); na 90 dagen zonder nieuwe zoekopdracht gewist (uurlijkse taak). Alleen een zoekopdracht zonder enig resultaat telt (niet met het voorraadfilter, niet in het voorbeeld).
- `GET /zoeken/suggesties/?q=` (max. 6 producten, `no-store`, eigen limiet 120 per minuut) en het script `zoeksuggesties.js` (toetsenbord, ARIA-combobox, tekst via `textContent`); zonder script werkt zoeken zoals voorheen.
- `GET /api/admin/shop-search-misses` (beheerders) en het tabblad Zoektermen in `webshop-bestellingen/`.
