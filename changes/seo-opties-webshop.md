---
titel: SEO-opties voor de webshop
---

## Nieuws
- [beheer, voorraad] Per artikel stel je nu een eigen titel en omschrijving voor zoekmachines in, plus het merk. Laat je ze leeg, dan maakt de webshop er zelf een goede van.
- [beheer] Ook categorieën (Webshop-inhoud > Menu) en pagina's krijgen een eigen titel voor zoekmachines.
- [beheer] Nieuw: Beheer > Webshop > Zoekmachines. Zolang je dat niet aanzet, blijft de webshop onzichtbaar voor Google: elke pagina op noindex, robots.txt blokkeert alles en de sitemap bestaat niet. Zet het aan zodra de webshop live gaat.

## Changelog
- Migratie 73: `stock_items.seo_title`, `seo_description` (70 en 160 tekens, opgeschoond via `item-details.js`) en `brand`; de variant erft per veld van het hoofdartikel (`shownDetails`), de EAN is altijd die van het artikel zelf.
- Categorieknopen in de menuboom (`seoTitle`, `seoDescription`, `normalizeTree`, editor `webshop-menu.js`) en pagina's (`seoTitle`, `normalizePage`) krijgen eigen zoekmachineteksten; de pagina's gebruiken `Seo.pageTitleOf` en de eigen omschrijving, anders de automatische tekst.
- Product-JSON-LD krijgt `brand` en `gtin13`/`gtin8` (alleen bij een enkel artikel of variant, nooit bij een prijsbereik, en alleen een geldige EAN); de prijs blijft de consumentenprijs incl. btw.
- Nieuwe instelling `shopSeo` {indexing} (standaard uit, `liveOnly`, alleen hoofdtenant, Beheer > Webshop > Zoekmachines): zolang uit krijgt elke shoppagina `noindex` (meta en `X-Robots-Tag`), zonder canonical, OpenGraph of JSON-LD; `robots.txt` is `Disallow: /`; sitemap, llms.txt en productfeed geven 404. Open vraagt ook een ingevuld webadres (`Seo.indexingOn`).
- Let op: zolang `shopSeo.indexing` uit staat laat `seoHead` ook OpenGraph en Twitter-kaart weg (gedeelde links krijgen dan geen voorbeeld); dat geldt ook voor een omgeving die al een webadres had ingevuld.
