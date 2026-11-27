---
titel: Sorteren in tabellen
---

## Nieuws
- Je kunt in de tabellen nu sorteren door op een kolomkop te klikken: eerst oplopend, dan aflopend, dan weer zoals het was. Een pijl laat zien waarop gesorteerd is en je keuze blijft per tabel bewaard. Het sorteren geldt voor de hele lijst, niet alleen voor de pagina die je ziet.

## Changelog
Sorteren zit in `shared/pager.js` naast de paginering: elke `table.grid` met één kopregel krijgt sorteerbare kolomkoppen (klik of Enter/spatie; oplopend, aflopend, uit; `aria-sort`). De rijen worden vóór het pagineren gesorteerd, dus over de hele tabel. Getallen (€, %, eenheden), datums (dd-mm-jjjj, jjjj-mm-dd, "27 nov. 2026") en tekst (Nederlandse volgorde, getallen in de tekst op waarde) worden per kolom herkend, lege cellen staan altijd onderaan en rijen met `sub-item`/`data-pager-join` blijven bij hun hoofdrij. De keuze staat per pagina en tabel in localStorage (`aquatech_sortering:…`), de kolom wordt op kopnaam herkend. Tabellen die zelf sorteren (`th[data-sort]`: plannen, werkorders, offertes, klantdossier), `data-no-sort` en `data-no-pager` (artikellijst, volgt apart) blijven ongemoeid. Geen nieuwe dependency; tests in `test/pager.test.js`.
