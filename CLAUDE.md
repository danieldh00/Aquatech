# Aquatech Beregeningsplanner — werkgeheugen

Webapp om tuinberegening te ontwerpen (in de lijn van de DVS Beregnungsplaner).
Groeit uit tot een modulair ERP-achtig pakket: startpagina = **dashboard**
(`frontend/index.html`, moduleregister `frontend/dashboard/modules.js`), de
planner is module `frontend/beregening/` (URL `beregening/`). Gepland:
planning, voorraadbeheer. Beheerders/hoofdbeheerders (`usesSidebar` in
modules.js) krijgen op elke pagina een zijbalk (`shared/sidebar.js|.css`,
0.35.0) i.p.v. de tegels; een nieuwe modulepagina laadt `dashboard/modules.js`
en daarna `shared/sidebar.js` (test bewaakt dat). Een module = map onder `frontend/` met eigen
`index.html`; de server serveert die generiek (relatieve redirect
`<id>` → `<id>/`, express.static met `redirect: false` i.v.m. een padprefix achter een proxy).
Huisstijl AquaTech Service (aquatechservice.nl) in `frontend/shared/brand.css`:
navy `#172f5e`, groen `#19924f` (knoppen), teal `#2cb0c0`, Montserrat (lokaal),
wit logo `shared/logo-white.png` op navy. Inlogpagina heeft het logo inline
(data-URI), want die wordt zonder toegang tot bestanden geserveerd.
Draait als gewone webserver in Docker (`docker-compose.yml` in de root,
poort 3300). **Niets in de app mag van Home Assistant afhangen** (besluit
Daniël 2026-10-18): geen ingress, geen HA-opties, geen Supervisor-detectie.
De HA-verpakking is in 0.29.1 verwijderd; Home Assistant speelt geen rol meer.

Zusterprojecten: `danieldh00/Hardlooptool` (poort 3200), `danieldh00/Lijstjes`
(3100), `danieldh00/Russianlanguageapp` (3000). Deze app gebruikt **poort 3300**.

## Branchmodel

- **`master`** is de productie- en GitHub-default branch; `release.yml` bouwt
  daaruit het image. `feature/beregeningsplanner` is de oude startbranch en
  wordt niet meer gebruikt (mag weg).
- **Nooit rechtstreeks op `master` werken.** Elke taak in een eigen branch
  `feature/<naam>` of `claude/<naam>` (de door de sessie toegewezen
  `claude/...`-branch telt als zodanig), altijd vers vanaf `master`:
  ```sh
  git fetch origin master
  git checkout -B claude/<naam> origin/master
  ```
- Werkwijze per taak: wijzigen → `npm test` → versie-bump + changelog (als
  `beregeningsplanner/` is gewijzigd) → `git push -u origin <branch>` → PR naar
  `master` → mergen zodra CI groen is (`ci.yml` + `version.yml`).
  Daarna de branch verwijderen. Een volgende taak begint opnieuw vanaf
  `origin/master`, niet vanaf een oude featurebranch.
- Loopt `master` voor op je branch (andere sessie heeft gemerged): eerst
  `git merge origin/master` in je branch, conflicten oplossen, en de versie
  zo nodig opnieuw verhogen (moet hoger zijn dan die op `master`).
- Elke wijziging in `beregeningsplanner/` op `master` vereist een
  **versie-bump** in `beregeningsplanner/backend/package.json` + entry in
  `CHANGELOG.md`. `scripts/check_version.py` (workflow `version.yml`, op PR's
  naar en pushes op `master`) bewaakt dat.
  Wijzigingen buiten `beregeningsplanner/` (zoals deze `CLAUDE.md`) hebben
  geen bump nodig.

## Server, inloggen en opslag

- Publieke URL **https://aquatech.den-hollander.com** via Cloudflare-tunnel
  `apps01` naar de Docker-server (Proxmox-VM `apps01`, `/opt/apps/aquatech`,
  zie `deploy/apps01/README.md`).
- **CI/CD**: `release.yml` bouwt bij een versie-bump op `master` na tests en
  smoketest het image `ghcr.io/danieldh00/aquatech:<versie>` + `:latest`; de
  server rolt dat binnen 15 min uit (`deploy/apps01/update.sh`, met rollback).
  Zonder versie-bump geen nieuw image en dus geen uitrol.
- **Eerste start**: zolang er geen actieve beheerder met een eigen account is
  (`store.countAdmins`), krijgt elke niet-ingelogde bezoeker
  `backend/src/setup.html` (POST `/api/setup`; met een toegangscode is die
  code nodig). De laatste actieve beheerder kan niet worden uitgeschakeld of
  gedegradeerd. Daarna is inloggen verplicht (`login.html`), tenzij de
  instelling `guestAccess` aan staat en er geen toegangscode is.
- **Nooit secrets in de repo of in chat**: toegangscode en API-sleutel alleen
  in **Beheer → Instellingen** (tabel `settings` in de database,
  `backend/src/settings.js`). Volgorde: database → env → standaard; env is
  alleen een startwaarde. Geheimen gaan nooit volledig naar de
  frontend (`view()` geeft `set` + laatste 4 tekens van de sleutel).
- **Beveiliging opslag** (0.16.0, ASVS L2 + AVG; overzicht in DOCS.md >
  *Beveiliging en privacy*): geheimen (`type: 'secret'` in settings.js)
  versleuteld met `vault.js` (AES-256-GCM, AAD `<tenant>:<veld>`, hoofdsleutel
  `AQUATECH_MASTER_KEY_FILE` → `AQUATECH_MASTER_KEY` → `/data/master-key`).
  Sessies in tabel `sessions` (alleen SHA-256 van het token, vingerafdruk van
  wachtwoord-hash/toegangscode, `sessionIdleDays`/`sessionMaxDays`).
  Wachtwoorden: async scrypt N=2^17 + `passwordProblem` (min. 12),
  rehash bij inloggen. Eerste beheerder vereist installatiecode (log,
  `SETUP_CODE`) of toegangscode. Tabel `audit` (`store.audit`, nooit geheimen
  in `detail`), bewaartermijnen via `app.locals.maintenance` (elk uur).
  Back-ups (`backup.js`, 0.19.0): VACUUM INTO (PostgreSQL: kopie naar SQLite) + AES-GCM (`vault.derive('back-ups')`),
  ook via `node src/backup.js create` (update.sh doet dat vóór elke update),
  `/data/backups` of `BACKUP_DIR`, dagelijks via `app.locals.backupIfDue`,
  `backupKeepDays`; `store.purgePlan` wist plan + historie-inhoud (AVG).
  CSP in server.js: inline scripts alleen in login/setup.html (op hash);
  nieuwe inline scripts elders werken niet. Proces zakt van root naar uid 1000
  (`dropPrivileges`, `RUN_AS_ROOT=1` slaat over). Test-wachtwoorden moeten
  aan het beleid voldoen (bijv. `Tuin-Plan-2026!`).
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
  `/data/aquatech.db` (of PostgreSQL, zie hieronder); migraties via `PRAGMA user_version` (alleen nieuwe
  toevoegen). Tenant-klaar: elke tabel heeft `tenant_id`, id's zijn UUID's.
  `store.js`: users (rol `beheerder`|`installateur`|`klant`, soort `account`|`gast`|
  `systeem`), plans (alleen eigenaar of beheerder) en `history` (append-only
  historie van aanvragen, snapshot zonder achtergrond, wijzigingen binnen 30
  min samengevoegd). Identiteit in `server.js` `identify()`: toegangscode =
  systeembeheerder, sessie-cookie met user-id = account, met gasten aan
  anders gast per browser (`aquatech_guest`). Module **Beheer**
  (`frontend/beheer/`, `role: 'beheerder'` in modules.js) toont historie,
  plannen en gebruikers. De API is ook onder `<module>/api/...` bereikbaar
  (modules gebruiken relatieve `api/...`).
- **Productie draait op Supabase** (sinds 2026-10-20, schema `aquatech`,
  Session pooler, secret `secrets/database-url` op apps01). Elke feature moet
  op PostgreSQL werken: CI (`test-postgres`) en `release.yml` draaien de hele
  suite ook tegen PostgreSQL. SQLite blijft de terugval zonder URL (lokaal,
  tests, noodgeval) en het formaat van de back-ups. Opslag in de database
  telt mee voor de Supabase-limiet (gratis: 500 MB), denk aan grote blobs.
- **PostgreSQL/Supabase** (0.34.0): `DATABASE_URL`/`DATABASE_URL_FILE` →
  `pgdb.js` (zelfde synchrone interface als node:sqlite via werkthread +
  `Atomics.wait`, `?` → `$n`), schema in `pgschema.js` (eigen schema
  `aquatech`, RLS aan, `COLLATE "C"`, BIGINT, DEFERRABLE FK's). Zonder URL
  SQLite. SQL in de code moet in beide werken (`lower()` i.p.v. `COLLATE
  NOCASE`, `lower(x) LIKE lower(?)`); verschillen via helpers in db.js
  (`jsonField`, `jsonWithout`, `listTables`, `tableColumns`, `foreignKeys`,
  `deferForeignKeys`, `schemaVersion`). **Nieuwe migratie: in `MIGRATIONS`
  (db.js) én `PG_MIGRATIONS` (pgschema.js)**; `test/postgres.test.js`
  vergelijkt de schema's. Overstap: `src/migrate-to-postgres.js` (dbcopy.js,
  aantallen + SHA-256 per tabel). Testsuite tegen PG: `TEST_DATABASE_URL`
  (elke `openDb()` een eigen schema `aqt_test_*`; CI-job `test-postgres`).
  Lokaal: `/usr/lib/postgresql/16/bin` staat in de sandbox (initdb als
  gebruiker postgres, poort 5433).
- **Multitenant** (0.20.0): tenants in `tenants` (`environment` `live`|`test`,
  `parent_id`, `disabled`); een testomgeving is een eigen tenant onder een
  live-tenant (eigen plannen/historie/instellingen, gebruikers van de
  live-tenant). Gebruikersnamen zijn uniek per organisatie (live-tenant +
  testomgevingen, `familyIds` in store.js), niet globaal (0.25.0); inloggen
  met organisatiecode = tenant-slug (`store.loginTenant`, leeg = hoofdtenant,
  testcode → live-tenant), onthouden in localStorage `aquatech_org`,
  `login?org=` vult hem in. `users.platform_admin` = hoofdbeheerder (alleen in de
  hoofdtenant, aan/uit via `platformAdmin` op `/api/platform/tenants/:id/users`,
  alleen door een hoofdbeheerder te wijzigen; module
  `frontend/hoofdbeheer/`, API `/api/platform/*`); de hoofdtenant kan niet uit.
  In `server.js` zet `identify()` `req.user` (met `tenant_id` = actieve
  omgeving, `home_tenant_id` = eigen tenant) en `req.tenantId`: gegevens via
  `req.tenantId`, gebruikersbeheer via `homeOf()`. Instellingen per tenant via
  `settingsFor()`. Wisselen: `POST /api/environment` zet de ondertekende
  cookie `aquatech_env` (`<user>:<tenant>`, elke keer opnieuw gecontroleerd)
  en de leesbare `aquatech_env_hint` voor `shared/env.js` (testlabel,
  localStorage-achtervoegsel). Wisselaar in `dashboard/account.js`.
- **Verwijderen** (0.33.0): live-tenant via `DELETE /api/platform/tenants/:id`
  met `{ confirm: <slug> }` (`store.deleteTenant`: wist elke tabel met
  `tenant_id` voor de tenant + testomgevingen, uit het schema gelezen, met
  `defer_foreign_keys`; verwijzingen naar gewiste gebruikers elders → NULL).
  Geaccordeerde offerte weg alleen met `{ confirm: <offertenummer> }` (409
  `confirm_required`). Back-ups: `DELETE /api/admin/backups/:name`.
- **Testdata beweegt mee met elke feature** (wens Daniël 2026-10-19): een
  nieuwe feature (tabel, status, koppeling) krijgt in dezelfde PR testdata in
  `backend/src/testdata.js` (`buildTestData` voor de opbouw, `seedFeatures`
  voor alles wat via de echte stores moet: klantlinks, reacties, werkorders,
  webshop). `test/testdata.test.js` faalt als een tabel met `tenant_id` na
  het vullen leeg is (uitzonderingen met reden in `NO_TESTDATA`).
- **Testdata** (0.23.0, `backend/src/testdata.js`): `POST
  /api/platform/tenants/:id/testdata` (alleen test-tenants) wist de omgeving
  en maakt testaccounts per rol (`<slug>.klant1` enz., één gedeeld
  wachtwoord, alleen in het antwoord), tuinen (zones via de plannerlibs in
  een vm-sandbox) en offertes (`Core.fromPlan`). Testaccounts hebben
  `tenant_id` = de testomgeving; gebruikersbeheer gaat via `usersTenantOf(req)`
  (eigen tenant als het account daar woont, anders `homeOf`).
- **Rollen** (0.22.0): rechten per rol in `frontend/shared/roles.js` (UMD,
  ook door de server ge-required): `Roles.can(user, recht)`; hoofdbeheerder
  (`platform_admin`) heeft alle rechten. Server: `requireRight(recht)`,
  `/api/me` geeft `rights`; dashboardtegels via `right` (en `alt`) in
  modules.js. Installateur ziet alle plannen/offertes van de tenant
  (`/api/plans?all=1`), klant alleen eigen plannen + offertes met
  `quotes.customer_id` = zijn id en status ≠ concept (`POST
  /api/quotes/:id/respond`). Gast = klant. Migratie 6 bouwt `users` opnieuw
  (CHECK op rol) met `foreignKeysOff: true` in `db.js`.
- **Plannenoverzicht** (`frontend/plannen/`, voor iedereen): tabel uit
  `/api/plans` (eigen) of `/api/admin/plans` (beheerder, `?deleted=1`,
  `historyCount`); samenvatting per plan via `summarize()` op
  `json_remove(data,'$.background')`; tijdlijn via
  `/api/admin/plans/:id/history`. Hergebruikt `beheer/beheer.css`.
- **Offertes** (`frontend/offertes/`, 0.21.0): rekenkern `quote-core.js`
  (UMD, ook door de server geladen: `sanitize`, `totals`, `fromPlan` met
  BOM + arbeidsnormen `LABOR`), opslag/routes in `backend/src/quotes.js`
  (tabel `quotes`, migratie 5, nummer `<prefix><jaar>-0001` per tenant),
  bedrijfsprofiel = instelling `quoteProfile` (type `object`). PDF via
  afdrukversie (`#print`, print-CSS), geen PDF-bibliotheek. Document +
  tekenvak/akkoordformulier gedeeld in `offertes/quote-view.js|.css`.
  **Digitale offerte** (0.26.0): openbare pagina `frontend/openbaar/offerte.html`
  (token in `#t=`, naar de server alleen als kop `X-Offerte-Token`; API
  `/api/public/quote[/respond]`); bestanden zonder login via `PUBLIC_FILES`/
  `isPublicAsset` in server.js (nieuwe afhankelijkheid van die pagina daar
  toevoegen). Tabel `quotes`: `share_hash` (SHA-256), `share_token` (vault),
  `acceptance` (JSON-bewijs); met een acceptance geeft PUT 409 `locked`.
  Regels kunnen `optional`/`selected` zijn (`Core.included`, `chooseOptions`).
  E-mail via `mailer.js` (nodemailer, eigen SMTP: `mailServer` + geheim
  `mailPassword`); tests vervangen `mailerFor`.
  afdrukversie (`#print`, print-CSS), geen PDF-bibliotheek.
- **Werkorders** (`frontend/werkorders/`, 0.28.0, recht `werkorders`:
  beheerder + installateur): kern `workorder-core.js` (UMD, `fromQuote`,
  `zonesFromPlan`, `sanitize`, `progress`), opslag/routes
  `backend/src/workorders.js` (tabel `work_orders`, migratie 10, nummer
  `WO-<jaar>-0001`). Alleen uit een offerte met status `akkoord`; koppeling
  met offerte/plan komt altijd uit de offerte. Knop **Werkorder maken** in
  de offerte-editor.
- **Planning + afspraaklink** (0.36.0): module `frontend/planning/` (recht
  `werkorders`; 0.40.0: agenda dag (installateurs als kolommen) / werkweek /
  maand, slepen naar tijdstip → `POST /api/workorders/:id/schedule`; zonder
  eindtijd blok uit geplande uren via `Core.fitHours`, 8 u per werkdag). Werkorder heeft `endTime` en `days`
  (werkdagen, `Core.workDays`). Klantlink zoals de digitale offerte:
  kolommen `share_*`/`viewed_at`/`sent_*` op `work_orders` (migratie 13),
  pagina `frontend/openbaar/afspraak.html` (kop `X-Afspraak-Token`, API
  `/api/public/appointment[/respond]`). Reacties als JSON-logboek in
  `work_orders.appointment`; stand berekend in `appointmentOf` (reactie telt
  alleen voor hetzelfde `Core.momentKey`). `workorders.respond(row, …, { via:
  'account', userId })` is ook bruikbaar voor een klantportaal.
- **Klantportaal** (`frontend/portaal/`, 0.37.0, recht `portaal`: alleen
  klant): `backend/src/portal.js`, `GET /api/portal` (plannen, offertes,
  werkorders, contact) en `/api/portal/workorders/:id` (opleverdossier via
  `customerWorkOrder`, zonder uren/instructies/notities). Werkorder zichtbaar
  als `quotes.customer_id` = klant en offerte ≠ concept. Optioneel:
  `ctx.photos.list(tid, woId, { customerOnly })` en `workorders.respond`
  (afspraak bevestigen, `POST .../appointment`).
- **Foto's + klantdossier** (0.38.0): `backend/src/photos.js` (tabel
  `work_order_photos`, migratie 14; afbeelding + miniatuur via
  `vault.sealBytes` met AAD `<tenant>:foto:<id>:beeld|mini`, als tekst in de
  db zodat ze in back-ups/Supabase meegaan; server controleert JPEG/PNG/WebP
  op inhoud en stript EXIF). Frontend `werkorders/photos.js|.css` (upload,
  camera via `capture`, `PhotoViewer`), module `frontend/klantdossier/`
  (`/api/dossiers[/:key]`, key `a-<klant-id>` of `n-<hash naam>`).
  Klantportaal: `photos.list(..., { customerOnly: true })` en
  `GET /api/portal/photos/:id`.
- **Wachtwoord** (0.31.0): eigen wijzigen via `POST /api/account/password`
  (pagina `backend/src/password.html`, route `/wachtwoord`, inline script op
  CSP-hash). `users.must_change_password` (migratie 12): zolang aan toont
  elke pagina het wachtwoordscherm en geeft de API 403
  `password_change_required` (behalve me/health/auth). Standaard aan bij
  aanmaken door een beheerder en bij een reset (`withMustChange` in server.js);
  tests die met zo'n account inloggen geven `mustChangePassword: false` mee.
- **Webshopkoppeling** (0.29.0, prototype WooCommerce): `backend/src/woocommerce.js`
  (adapter Store API/REST v3, `sanitizeShop`, alleen openbare https tenzij
  `SHOP_ALLOW_INSECURE=1` voor tests) en `backend/src/shop.js` (tabellen
  `shop_products`/`shop_sync`, migratie 11; koppelen aan `Catalog.articles`:
  handmatig code→sku, meta `aquatech_code`, sku = code). Instellingen
  `shopSource` + geheimen `shopConsumerKey`/`shopConsumerSecret` per tenant.
  API `GET /api/catalog` (ingelogd), `/api/admin/shop[/sync]` (beheerder).
  Frontend `beregening/js/shopcatalog.js` legt de prijzen over de catalogus
  (planner + offertes, vóór `fromPlan`); beheer in `beheer/webshop.js`.
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
