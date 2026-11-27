# Frontend (hub/frontend)

Alleen de regels voor de frontend; bij tegenspraak geldt de root-`CLAUDE.md`. het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term).

- Gewone `<script>`-tags (geen ES-modules), alle URL's relatief, geen CDN's (vendor lokaal in `<module>/vendor/`). Scripts/CSS met `?v=<versie>`.
- Een module = map met eigen `index.html`; een nieuwe modulepagina laadt `dashboard/modules.js` en daarna `shared/sidebar.js`. Registreer de module in `dashboard/modules.js` (met `right`, eventueel `configuration`).
- `api/me` en `api/config` alleen via `getJson` uit `shared/common.js` (één verzoek per pagina); onafhankelijke verzoeken parallel; terugknop via `origin()`, verversen na terugkeer met `onReturn()`. Links naar een item direct (`?id=`), nooit via een overzicht.
- Kleuren via `--at-*`-variabelen, nooit hardcoded. Layout met de klassen uit `shared/layout.css`; netjes uitgelijnd op 1440 en 375 px (controleer via DOM/CSS, geen schermafbeeldingen).
- Een terugvalmelding bij een status zonder `message` via `AquatechCommon.statusMessage(status)`, nooit `HTTP ${status}`.
- Een nieuw adresveld: `data-address-lookup` + `shared/address-lookup.js`. Een nieuw afdrukdocument: `AquatechDocLayout`. Excel laden via `excel()` (geen exceljs-scripttag).
- Rechten verbergen alleen; de server dwingt ze af.
- Lange lijsten: een `table.grid` krijgt vanzelf paginering (`shared/pager.js` + `pager.css` laden); "alles selecteren" via `AquatechPager.shownIds(table)`; `data-no-pager` alleen voor een lijst die zelf in porties tekent (`AquatechPager.attach`).
