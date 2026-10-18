# Aquatech Beregeningsplanner — werkgeheugen

Webapp om tuinberegening te ontwerpen (in de lijn van de DVS Beregnungsplaner).
Groeit uit tot een modulair ERP-achtig pakket: startpagina = **dashboard**
(`frontend/index.html`, moduleregister `frontend/dashboard/modules.js`), de
planner is module `frontend/beregening/` (URL `beregening/`). Gepland:
planning, voorraadbeheer. Een module = map onder `frontend/` met eigen
`index.html`; de server serveert die generiek (relatieve redirect
`<id>` → `<id>/`, express.static met `redirect: false` i.v.m. een padprefix achter een proxy).
Huisstijl AquaTech Service (aquatechservice.nl) in `frontend/shared/brand.css`:
navy `#172f5e`, groen `#19924f` (knoppen), teal `#2cb0c0`, Montserrat (lokaal),
wit logo `shared/logo-white.png` op navy. Inlogpagina heeft het logo inline
(data-URI), want die wordt zonder toegang tot bestanden geserveerd.
Draait als gewone webserver in Docker (`docker-compose.yml` in de root,
poort 3300). **Niets in de app mag van Home Assistant afhangen** (besluit
Daniël 2026-10-18): geen ingress, geen HA-opties, geen Supervisor-detectie.
De HA-verpakking (`config.yaml`, `apparmor.txt`, `icon.png`, `logo.png`,
`repository.yaml`) staat er alleen nog tijdelijk zodat de oude installatie
updates krijgt tot de Docker-server draait; daarna mag die weg.

Zusterprojecten met hetzelfde add-on-patroon: `danieldh00/Hardlooptool`
(poort 3200), `danieldh00/Lijstjes` (3100), `danieldh00/Russianlanguageapp`
(3000). Deze add-on gebruikt **poort 3300**.

## Branchmodel

- **`master`** is de productie- en GitHub-default branch; Supervisor kloont
  die. `feature/beregeningsplanner` is de oude startbranch en wordt niet meer
  gebruikt (mag weg). HA volgt `master` sinds de herinstallatie van
  2026-10-18 (Supervisor kloont de default branch alleen bij het toevoegen van
  de repository; de store-slug is een hash van de URL en bleef `c1355dc8`).
- **Nooit rechtstreeks op `master` werken.** Elke taak in een eigen branch
  `feature/<naam>` of `claude/<naam>` (de door de sessie toegewezen
  `claude/...`-branch telt als zodanig), altijd vers vanaf `master`:
  ```sh
  git fetch origin master
  git checkout -B claude/<naam> origin/master
  ```
- Werkwijze per taak: wijzigen → `npm test` → versie-bump + changelog (als
  `beregeningsplanner/` is gewijzigd) → `git push -u origin <branch>` → PR naar
  `master` → mergen zodra CI groen is (`ci.yml` + `addon-version.yml`).
  Daarna de branch verwijderen. Een volgende taak begint opnieuw vanaf
  `origin/master`, niet vanaf een oude featurebranch.
- Loopt `master` voor op je branch (andere sessie heeft gemerged): eerst
  `git merge origin/master` in je branch, conflicten oplossen, en de versie
  zo nodig opnieuw verhogen (moet hoger zijn dan die op `master`).
- Elke wijziging in `beregeningsplanner/` op `master` vereist een
  **versie-bump** in `beregeningsplanner/backend/package.json` (en zolang die
  bestaat dezelfde versie in `config.yaml`) + entry in `CHANGELOG.md`. `scripts/check_addon_version.py` (workflow
  `addon-version.yml`, op PR's naar en pushes op `master`) bewaakt dat.
  Wijzigingen buiten `beregeningsplanner/` (zoals deze `CLAUDE.md`) hebben
  geen bump nodig.

## Server, inloggen en opslag

- Publieke URL **https://aquatech.den-hollander.com** via een Cloudflare-tunnel
  naar poort 3300 (nu nog via de oude HA-installatie, slug
  `c1355dc8_beregeningsplanner`).
- **Eerste start**: zolang er geen actieve beheerder met een eigen account is
  (`store.countAdmins`), krijgt elke niet-ingelogde bezoeker
  `backend/src/setup.html` (POST `/api/setup`; met een toegangscode is die
  code nodig). De laatste actieve beheerder kan niet worden uitgeschakeld of
  gedegradeerd. Daarna is inloggen verplicht (`login.html`), tenzij de
  instelling `guestAccess` aan staat en er geen toegangscode is.
- **Nooit secrets in de repo of in chat**: toegangscode en API-sleutel alleen
  in **Beheer → Instellingen** (tabel `settings` in `/data/aquatech.db`,
  `backend/src/settings.js`). Volgorde: database → env → standaard; env is
  alleen een startwaarde. Geheimen gaan nooit volledig naar de
  frontend (`view()` geeft `set` + laatste 4 tekens van de sleutel).
- **Plan herkennen** (`backend/src/planAnalyzer.js`): één Claude API-aanroep
  (vision, gestructureerde JSON-uitvoer, fallback "default") die schaal
  (referentiemaat in pixels + lengte in m), vlakken en elementen teruggeeft. De
  frontend (`js/concept.js`) rekent om naar meters en bouwt het concept. Kosten
  begrensd met de instellingen `aiDailyLimit` en `aiHourlyPerIp`; de route valt
  achter de login (behalve met gasten aan). Tests bootsen de API na (geen echte aanroepen).
- **Beregeningsmethode** per vlak: `Hydraulics.methodOf(state, area)` =
  `area.method` → `settings.methods[type]` → `areaTypes[type].defaultMethod`
  (`dripline` | `drippers` | `sprinklers` | `none`). Sproeiers in beplanting
  hebben `areaId` en eigen zonegroepen (`bed-spray`, `bed-rotator`); druppelslang
  en druppelaars zijn de groepen `drip` en `drippers`. `App._syncBedSprinklers`
  plaatst/verwijdert ze bij een wijziging van de methode.
- **Lokale herkenning** (`js/localrecog.js`, standaard): papiermodel
  (`paperModel`: lichtste neutrale pixels per cel, 3e-graads veelterm, iteratief
  zonder donkere cellen; niet bij egaal wit/digitaal of als >4% lichter dan het
  papier wordt) → delen door papier → middelen zonder inktpixels
  (`inkFreeBlur`) → kleurclassificatie (HSV + chroma in `classify`, werkt op
  bleek potlood) → meerderheidsfilter → sluiten → componenten (beeldrand bij
  foto's, titelblok/los grijs zonder contact met de tuin eruit) → contour met
  sleutelgatsnede voor grote gaten. Pixelpijplijn `areasFromPixels` is zonder
  canvas testbaar. Schaal via Tesseract.js 5.1.1 (lokaal in `vendor/tesseract/`,
  `nld+eng`, absolute URL's) + `measureLine` (maatlijn moet aan beide
  kanten voorbij het tekenkader `textBox` lopen); lezingen sterk/zwak
  (`lengthReadings`), keuze in `pickScale`. Geen maat → `Concept.build` geeft
  `gardenWidthPx` en de app vraagt de tuinbreedte; PDF: `paper` {widthM, ratio
  "1:N"} uit `planimport.js`. Labels (`VOCAB` + `matchLabel`, Levenshtein-speling)
  uit 6 OCR-rondes (`readText`: cijfers recht/gedraaid, tekst normaal/zwart-wit
  recht/gedraaid, taal `nld+eng`) typeren gekleurde vlakken of halen omsloten
  lijnvlakken uit (`enclosedRegions`). Referentie: potloodfoto "De Groenblijver" (geen
  maatlijn, schaal 1:50). Zelfde uitvoerformaat als de AI; bij een AI-fout valt
  `makeConcept` terug op lokaal. Unittests in `backend/test/localrecog.test.js`
  laden de frontendcode in een vm-sandbox.
- **Database** (`backend/src/db.js`, `node:sqlite`, geen npm-module) in
  `/data/aquatech.db`; migraties via `PRAGMA user_version` (alleen nieuwe
  toevoegen). Tenant-klaar: elke tabel heeft `tenant_id`, id's zijn UUID's.
  `store.js`: users (rol `beheerder`|`gebruiker`, soort `account`|`gast`|
  `systeem`), plans (alleen eigenaar of beheerder) en `history` (append-only
  historie van aanvragen, snapshot zonder achtergrond, wijzigingen binnen 30
  min samengevoegd). Identiteit in `server.js` `identify()`: toegangscode =
  systeembeheerder, sessie-cookie met user-id = account, met gasten aan
  anders gast per browser (`aquatech_guest`). Module **Beheer**
  (`frontend/beheer/`, `role: 'beheerder'` in modules.js) toont historie,
  plannen en gebruikers. De API is ook onder `<module>/api/...` bereikbaar
  (modules gebruiken relatieve `api/...`).
- **Plannenoverzicht** (`frontend/plannen/`, voor iedereen): tabel uit
  `/api/plans` (eigen) of `/api/admin/plans` (beheerder, `?deleted=1`,
  `historyCount`); samenvatting per plan via `summarize()` op
  `json_remove(data,'$.background')`; tijdlijn via
  `/api/admin/plans/:id/history`. Hergebruikt `beheer/beheer.css`.
- **Toverstaf** (`js/autotrace.js`) en PDF-import (`vendor/pdf.min.js`, pdf.js
  3.11.174 met `isEvalSupported: false`) werken volledig in de browser.
- Health: `GET /api/health` (versie uit `package.json`).

## Harde regels

- **Alle URL's in de frontend relatief** (`css/app.css`, nooit `/css/...`),
  zodat de app ook onder een padprefix achter een reverse proxy werkt. Geen CDN's:
  vendor-bestanden lokaal in `frontend/<module>/vendor/` (test controleert dit voor alle pagina's).
- Frontend gebruikt gewone `<script>`-tags (geen ES-modules), zodat
  `index.html` ook via `file://` werkt.
- Geen native npm-modules (multi-arch: aarch64 + amd64, image wordt op de host gebouwd).
- UI-teksten, commentaar, changelog en docs in het **Nederlands**.
- Exports: **Excel (.xlsx), geen CSV**, tenzij expliciet anders gevraagd.
- Geen modelnamen/-ID's in commits, PR's, code of docs.
- Prijzen in `frontend/beregening/js/catalog.js` zijn indicatieve placeholders.
- **Nooit `pkill -f`** in de cloud-sandbox; stop een testserver met
  `kill $(lsof -ti tcp:3300)`.

## Lokaal draaien en testen

```sh
cd beregeningsplanner/backend && npm install
DATA_DIR=/tmp/bp PORT=3300 node src/server.js   # http://localhost:3300 -> eerste beheerder aanmaken
npm test                          # node --test
```

Docker is niet beschikbaar in de cloud-sandbox; CI (`ci.yml`) bouwt en
smoketest de image voor amd64 en arm64. Playwright/Chromium staat klaar
(`$(npm root -g)/playwright`, browsers in `/opt/pw-browsers`).
