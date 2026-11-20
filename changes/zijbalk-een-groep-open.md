---
titel: Zijbalk houdt maximaal één groep open
---

## Nieuws
- [beheer] In de zijbalk staat nog maar één groep tegelijk open: klap je een groep open, dan klapt de vorige dicht. Dat houdt het menu compact.

## Changelog
`shared/sidebar.js`: accordeon in de zijbalk (ook in de mobiele lade). Bij het laden staat de groep met de huidige pagina open; een eigen keuze op pagina's zonder groep wordt als één sleutel onthouden (`aquatech_nav_groups`, het oude object met meerdere groepen wordt tot één groep teruggebracht).
