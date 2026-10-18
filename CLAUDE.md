# Aquatech Beregeningsplanner — werkgeheugen

Webapp om tuinberegening te ontwerpen (in de lijn van de DVS Beregnungsplaner).
Groeit uit tot een modulair ERP-achtig pakket: startpagina = **dashboard**
(`frontend/index.html`, moduleregister `frontend/dashboard/modules.js`), de
planner is module `frontend/beregening/` (URL `beregening/`). Gepland:
planning, voorraadbeheer. Een module = map onder `frontend/` met eigen
`index.html`; de server serveert die generiek (relatieve redirect
`<id>` → `<id>/`, express.static met `redirect: false` i.v.m. ingress).
Draait voorlopig als Home Assistant-add-on (paneel **Aquatech**, slug
ongewijzigd `beregeningsplanner`); later op een eigen server via
`docker-compose.yml`.

Zusterprojecten met hetzelfde add-on-patroon: `danieldh00/Hardlooptool`
(poort 3200), `danieldh00/Lijstjes` (3100), `danieldh00/Russianlanguageapp`
(3000). Deze add-on gebruikt **poort 3300**.

## Branchmodel

- **`master`** is de productie- en GitHub-default branch; Supervisor kloont
  die. `feature/beregeningsplanner` is de oude startbranch en wordt niet meer
  gebruikt. Na het omzetten van de default branch de repository in HA
  verwijderen en opnieuw toevoegen (let op: dan verandert mogelijk de slug —
  controleer en werk de slugs hieronder bij).
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
  **versie-bump** in `beregeningsplanner/config.yaml` + entry in `CHANGELOG.md`,
  anders biedt HA geen update aan. `scripts/check_addon_version.py` (workflow
  `addon-version.yml`, op PR's naar en pushes op `master`) bewaakt dat.
  Wijzigingen buiten `beregeningsplanner/` (zoals deze `CLAUDE.md`) hebben
  geen bump nodig.

## Home Assistant

- Repository `https://github.com/danieldh00/Aquatech` (store-slug `c1355dc8`),
  app-slug **`c1355dc8_beregeningsplanner`**, auto_update + watchdog aan.
- Ingress (paneel **Aquatech**, geen login) én gepubliceerde poort 3300
  voor de tunnel **https://aquatech.den-hollander.com**. Op verzoek van de
  gebruiker **openbaar zonder login** zolang `access_code` leeg is; met code
  is inloggen verplicht buiten ingress (sessiesleutel in `/data/session-secret`).
- **Ingress alleen vertrouwen op header + Supervisor-IP (`172.30.32.2`)**
  (`backend/src/auth.js`); de header alleen is te vervalsen. Met code en zonder
  geldige sessie serveert de server op elk pad `backend/src/login.html`.
- Cloudflared-app (`9074a9fa_cloudflared`) → `additional_hosts`:
  `aquatech.den-hollander.com → http://c1355dc8-beregeningsplanner:3300`.
- **Nooit secrets in de repo of in chat**: `access_code` en `anthropic_api_key`
  alleen in de app-opties.
- **Plan herkennen** (`backend/src/planAnalyzer.js`): één Claude API-aanroep
  (vision, gestructureerde JSON-uitvoer, fallback "default") die schaal
  (referentiemaat in pixels + lengte in m), vlakken en elementen teruggeeft. De
  frontend (`js/concept.js`) rekent om naar meters en bouwt het concept. Kosten
  begrensd met `ai_daily_limit` + 10/uur per IP; de route valt achter de login
  als er een `access_code` is. Tests bootsen de API na (geen echte aanroepen).
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
- **Toverstaf** (`js/autotrace.js`) en PDF-import (`vendor/pdf.min.js`, pdf.js
  3.11.174 met `isEvalSupported: false`) werken volledig in de browser.
- Logs: `ha_get_logs(source="supervisor", slug="c1355dc8_beregeningsplanner")`;
  health via ingress: `ha_manage_app(slug=..., path="/api/health")`.

## Harde regels

- **Alle URL's in de frontend relatief** (`css/app.css`, nooit `/css/...`):
  onder ingress draait de app op `/api/hassio_ingress/<token>/`. Geen CDN's:
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
DATA_DIR=/tmp/bp ACCESS_CODE=test PORT=3300 node src/server.js   # http://localhost:3300
npm test                          # node --test
```

Docker is niet beschikbaar in de cloud-sandbox; CI (`ci.yml`) bouwt en
smoketest de image voor amd64 en arm64. Playwright/Chromium staat klaar
(`$(npm root -g)/playwright`, browsers in `/opt/pw-browsers`).
