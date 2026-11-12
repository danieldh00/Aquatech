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

**Adresindeling** (1.7.1): de webshop is de hoofdmap `/`; de hele app (dashboard, modules, `/app/api`,
inloggen, openbare offerte-/afspraaklinks, `sw.js`/`manifest.json`) staat onder `/app/`. `server.js` haalt het
voorvoegsel eraf (`req.inApp`), dus binnen de app blijven alle paden en relatieve URL's zoals ze waren; de shop-router
(`webshop/storefront.js`) staat op `/`. Oude adressen worden doorgestuurd (`legacyAppRedirect`: modules, `/login`,
`/openbaar/…`, `/admin`, `/winkel/…`); `/api/health` werkt op beide plekken, andere `/api/…` buiten `/app` is 404.
Webshop uit (standaard) → `/` stuurt naar `app/`. Tests: app-paden met `/app/…`, shop-paden zonder `/winkel`.

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
- Werkwijze per taak: wijzigen → `npm test` → releasenotes-bestand `changes/<naam>.md` (als
  `beregeningsplanner/` is gewijzigd; **geen** versie-bump, geen CHANGELOG/releases.js) → README.md bijwerken (bij features/setup) → `git push -u origin <branch>` → PR naar
  `master` → CI groen (`ci.yml` + `version.yml`) → **Claude-review**
  (`claude-review.yml`: jobs *Claude code review* en *Claude security review*, de
  verplichte controles; opmerkingen oplossen of met reden beantwoorden). **CodeRabbit is uitgeschakeld** (besluit Daniël 2026-11-11: config, triggers, inhaalreview en bevindingenissues zijn verwijderd). **Vóór go-live** laat Daniël de code één keer handmatig een deep scan geven met CodeRabbit; bevindingen daarvan lossen we dan op. De Claude-reviews draaien op het Claude-abonnement van Daniël (secret `CLAUDE_CODE_OAUTH_TOKEN`, aan te maken met `claude setup-token`), niet op API-tegoed; de securityreview draait via dezelfde `claude-code-action`. **Kosten van de Claude-review** zijn begrensd: de workflow slaat docs/tests-only wijzigingen over, draait de securityreview alleen bij beveiligingsrelevante code en beoordeelt een volgende push alleen op wat nieuw is; het model komt uit de repository-variabelen `CLAUDE_REVIEW_MODEL` (eerste volledige review) en `CLAUDE_REVIEW_MODEL_PUSH` (lichtere review per push). Na het mergen de branch verwijderen. Een volgende taak begint opnieuw vanaf
  `origin/master`, niet vanaf een oude featurebranch.
- Loopt `master` voor op je branch (andere sessie heeft gemerged): eerst
  `git merge origin/master` in je branch, conflicten oplossen, en de versie
  zo nodig opnieuw verhogen (moet hoger zijn dan die op `master`).
- **Versie en releasenotes zijn automatisch** : een PR verandert `version` in
  `beregeningsplanner/backend/package.json`, `CHANGELOG.md` en `frontend/nieuws/releases.js` **niet**. Elke PR die
  `beregeningsplanner/` wijzigt voegt één bestand `changes/<korte-naam>.md` toe (formaat en voorbeeld: `changes/README.md`:
  `titel:`, `## Nieuws` met punten en optioneel `[rechten]`, `## Changelog`). Na de merge geeft `release.yml` (job *prepare*,
  `backend/tools/release-notes.js`) elk bestand het volgende versienummer (patch + 1, na x.y.9 de volgende minor, `bump: minor`
  in de kop kan; major alleen op Daniëls woord), werkt de drie bestanden bij, verwijdert het fragment en commit naar master
  met `[skip ci]`. De PR-check `version-must-increase` (`version.yml`) faalt bij een eigen versie-/releases.js-/CHANGELOG-wijziging
  of een ontbrekend fragment; alleen docs/CI zonder effect: label `geen-releasenotes`. Het versienummer in een PR staat dus
  altijd op het oude; tests die de versie nodig hebben lezen `package.json`. Voor de push naar de beschermde master is
  het secret `RELEASE_PUSH_TOKEN` nodig (beheerder-PAT) met Repository admin als bypass in de ruleset.
  Wijzigingen buiten `beregeningsplanner/` (zoals deze `CLAUDE.md`) hebben
  geen bump nodig.

## Server, inloggen en opslag

- Publieke URL **https://aquatech.den-hollander.com** via Cloudflare-tunnel
  `apps01` naar de Docker-server (Proxmox-VM `apps01`, `/opt/apps/aquatech`,
  zie `deploy/apps01/README.md`).
- **CI/CD**: `release.yml` bouwt bij een nieuwe versie op `master` (automatisch na een merge met fragment) na tests en
  smoketest het image `ghcr.io/danieldh00/aquatech:<versie>` + `:latest`; de
  server rolt dat binnen 15 min uit (`deploy/apps01/update.sh`, met rollback).
  Zonder fragment geen nieuwe versie, geen nieuw image en dus geen uitrol.
- **Eerste start**: zolang er geen actieve beheerder met een eigen account is
  (`store.countAdmins`), krijgt elke niet-ingelogde bezoeker
  `backend/src/paginas/setup.html` (POST `/api/setup`; met een toegangscode is die
  code nodig). De laatste actieve beheerder kan niet worden uitgeschakeld of
  gedegradeerd. Daarna is inloggen verplicht (`login.html`), tenzij de
  instelling `guestAccess` aan staat en er geen toegangscode is.
- **Nooit secrets in de repo of in chat**: toegangscode en API-sleutel alleen
  in **Beheer → Instellingen** (tabel `settings` in de database,
  `backend/src/platform/settings.js`). Volgorde: database → env → standaard; env is
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
- **Plan herkennen** (`backend/src/beregening/plan-analyzer.js`): één Claude API-aanroep
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
- **Database** (`backend/src/database/db.js`, `node:sqlite`, geen npm-module) in
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
  vergelijkt de schema's. Overstap: `src/migrate-to-postgres.js` (db-copy.js,
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
- **Testomgeving zonder koppelingen** (1.7.4): bij het aanmaken van een testomgeving gaan geheimen en instellingen met
  `liveOnly` in settings.js (webshop, Mollie, mail, Visma, seizoensherinneringen) niet mee; `invoicing` wel, met `autoSend` en
  `shopOrders.enabled` uit (`valueForTest`). **Een nieuwe instelling die een extern systeem aanstuurt krijgt `liveOnly: true`.**
- **Audit 1.7.3 opgelost** (1.7.4, PR #136; Excel in de projectbestanden `audit-fable/`):
  - *Wachtwoord vergeten / e-mail bevestigen* (migratie 48, `platform/account-tokens.js`, `shop-accounts.js`): eenmalige links,
    alleen SHA-256 in `account_tokens`, token in `#t=`; `users.email_verified_at`. Bestelmail naar het accountadres.
  - *VIES* (`webshop/vies.js`, tests `createApp({ viesFetch })` + `test/helpers/vies-fake.js`): btw verleggen alleen met het
    goedgekeurde nummer van het account en niet als VIES het ongeldig noemt; bewijs in `data.vat.vies`.
  - *Terugbetalen* (`webPayments.refund`, `POST /api/admin/web-orders/:id/refund`, `mollie.createRefund`): sleutel per retour of
    annulering; webhook legt `refundedTotal`/`chargedBack` vast. Volledige consumentenretour crediteert ook de verzendkosten.
  - *Eenheden planner → wagen* (migratie 49, `stock_items.unit_content`, `convertPlannedQty` in storefront-cart.js).
  - *Adres zonder PDOK*: vinkje `addressManual` bij afrekenen → `address.unverified`. Bestellimiet per account (`orders.countSince`).
  - *Webadres*: canonical, sitemap, feeds en links in mails alleen uit `shopPayment.publicUrl` (`publicBaseUrl`), nooit de Host-kop.
  - *Sessiecookie* via https `__Host-aquatech_session` (`sessionCookieName`). Klantlinks verlopen (`platform/public-links.js`).
  - *Tenantfilter*: `tools/tenant-filter.js` (`npm run tenant-filter`) + `test/tenant-filter.test.js`; uitzonderingen in
    `tools/tenant-filter-baseline.json` (alleen korter). PostgreSQL `statement_timeout` 30 s (`PG_STATEMENT_TIMEOUT_MS`).
  - Bewust zo gelaten: op rekening voor iedereen (W-02, testfase), limieten in het geheugen (één container), WooCommerce-voorraadsync
    (wordt uitgefaseerd), klantweergave met live-klanten van de eigen organisatie.
- **Functioneel beter uit de audit** (1.7.5): reservering per bestelling (`data.reservedUntil`, `shopPayment.accountHoldDays`,
  `webOrders.releaseExpired` elk uur: op rekening alleen de reservering vrij, bestelling blijft); omschrijving + specificaties per
  artikel (migratie 50, `artikelen/item-details.js`, terugval op `shop_products.description` en zichtbare niet-variatiekenmerken,
  `data.detailsOf` in storefront-data.js met cache); oplopende loginvertraging `loginGuard.wait` (tests: `createApp({ loginDelayMs: 0 })`
  bij veel mislukte pogingen). Een warme shop-pagina kost 0 queries (`queries.test.js`), houd dat zo.
- **Tweestapsverificatie** (1.7.5, migratie 51, `beveiliging/totp.js` + `two-factor.js`, `shared/qr-code.js`): geheim versleuteld
  in `users.totp_secret`, herstelcodes alleen als SHA-256, `totp_last_step` = elke code één keer. Login geeft 401
  `totp_required`/`totp_wrong` (veld `totp`), telling `totp:<user>` in `loginGuard`; winkelinlog weigert zo'n account. Reset door
  beheerder: `DELETE /api/admin/users/:id/totp`.
- **Echte RLS in PostgreSQL** (1.7.5, `database/tenant-scope.js`, `tenantPolicies` in pgdb.js): rol `aquatech_app` + policy
  `aquatech_tenant` per tabel op `current_setting('aquatech.tenants')`; `identify()` zet de scope (`limitTo(familyIds)`), de
  werkthread doet `SET ROLE` per query. **Nieuwe code die bewust over organisaties heen werkt** (achtergrondtaak, audit,
  uitbesteden) gebruikt `asSystem(fn)` of `pinSystem()`; luisteraars op de request-stream via `bindStream`. Noodschakelaar
  `PG_TENANT_RLS=0`; zonder CREATEROLE alleen een waarschuwing. `test/tenant-rls.test.js`.
- **Databasepool** (1.7.7, `database/async-db.js` + `pg-pool.js`): `db.async.get/all/run(sql, ...params)` = Promise, met
  PostgreSQL via `pg.Pool` (`PG_POOL_SIZE`, standaard 5, 0 = uit; houdt `search_path`, `statement_timeout` en de RLS-scope per
  verbinding bij), met SQLite synchroon in een Promise. **Alleen losse queries, nooit een transactie** (geweigerd; transacties
  blijven `db.prepare`/`transaction`). Nu gebruikt voor de sessie van API-verzoeken (`store.prefetchSession`) en de
  webshopcatalogus (`storefrontData.warm`). Een trage leesquery die de server niet mag stilzetten: via `db.async` (alleen met een actieve PostgreSQL-pool; bij SQLite en `PG_POOL_SIZE=0` draait de query synchroon en blokkeert een trage query de eventloop alsnog). Supabase:
  Session pooler houden (niet 6543), *Pool Size* ≥ `PG_POOL_SIZE` + 2.
- **Verwijderen** (0.33.0): live-tenant via `DELETE /api/platform/tenants/:id`
  met `{ confirm: <slug> }` (`store.deleteTenant`: wist elke tabel met
  `tenant_id` voor de tenant + testomgevingen, uit het schema gelezen, met
  `defer_foreign_keys`; verwijzingen naar gewiste gebruikers elders → NULL).
  Geaccordeerde offerte weg alleen met `{ confirm: <offertenummer> }` (409
  `confirm_required`). Back-ups: `DELETE /api/admin/backups/:name`.
- **README bijwerken** (wens Daniël 2026-11-11): elke PR die features, modules, instellingen of de installatie/het
  reviewproces wijzigt, werkt `README.md` (root) in dezelfde PR bij. Het README is het overzicht voor mensen; de details
  blijven in CLAUDE.md, DOCS.md en CHANGELOG.md.
- **Multitenancy-schakelaar** (1.8.0, instelling `multitenancy`, `platform: true`, Hoofdbeheer > Multitenancy, standaard uit):
  uit = alles in de hoofdtenant, geen organisatiecode bij inloggen, andere organisaties kunnen niet inloggen (`inScope` in
  server.js); datamodel en RLS blijven gelijk. Tests met meer organisaties: `createApp({ env: { MULTITENANCY: '1' } })`.
- **Testdata beweegt mee met elke feature** (wens Daniël 2026-10-19): een
  nieuwe feature (tabel, status, koppeling) krijgt in dezelfde PR testdata in
  `backend/src/platform/test-data.js` (`buildTestData` voor de opbouw, `seedFeatures`
  voor alles wat via de echte stores moet: klantlinks, reacties, werkorders,
  webshop). `test/testdata.test.js` faalt als een tabel met `tenant_id` na
  het vullen leeg is (uitzonderingen met reden in `NO_TESTDATA`).
- **Testdata** (0.23.0, `backend/src/platform/test-data.js`): `POST
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
- **Rollenbeheer** (0.49.0): rollen per organisatie in tabel `roles`
  (migratie 18, bij de live-tenant via `rootOf`; test volgt live), store
  `backend/src/platform/roles.js` (`store.roles`: `list`, `rightsFor`, `keysWith`,
  `keysOfKind`, `create/update/remove`, cache 30 s). Tabel bewaart alleen
  afwijkingen van de standaardrollen in roles.js plus eigen rollen;
  `users.role` is een vrije sleutel (geen CHECK meer). `identify()` zet
  `user.rights` (`withRights`), `Roles.rightsOf` gebruikt die. Soort
  `medewerker`|`klant` (`Roles.rightsForKind`), `needs` tussen rechten
  (`withNeeds`). Beheerder heeft vaste rechten en als enige `beheer`.
  Standaardrol **planner** (`werkorders` + `planning`). Rechten `planning`
  (planningmodule, `/schedule`, `/share`, `/send`) en `uitvoerder`
  (`workorders.staff`). Klantenlijsten via `keysOfKind('klant')`, nooit
  `role = 'klant'`. API `/api/admin/roles[/:key]`, UI `beheer/rollen.js`.
- **Bekijken als klant** (1.3.6, `beveiliging/impersonation.js`, mode
  `klant` in `impersonations`, migratie 34): beheerder (recht `beheer`) bekijkt
  in een **testomgeving** (alleen daar, wens Daniël) de app als een klant van
  de eigen organisatie; `/api/admin/view-as-customer`, balk bovenin via
  `shared/env.js` (hint `…|klant`), audit `klantweergave_*`. De
  supportimpersonatie van de hoofdbeheerder (mode `support`) blijft zoals hij was.
- **Plannenoverzicht** (`frontend/plannen/`, voor iedereen): tabel uit
  `/api/plans` (eigen) of `/api/admin/plans` (beheerder, `?deleted=1`,
  `historyCount`); samenvatting per plan via `summarize()` op
  `json_remove(data,'$.background')`; tijdlijn via
  `/api/admin/plans/:id/history`. Hergebruikt `beheer/beheer.css`.
- **Offertes** (`frontend/offertes/`, 0.21.0): rekenkern `quote-core.js`
  (UMD, ook door de server geladen: `sanitize`, `totals`, `fromPlan` met
  BOM + arbeidsnormen `LABOR`), opslag/routes in `backend/src/verkoop/quotes.js`
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
- **Klantkeuze in de offerte** (1.9.8, geen migratie): zoekveld bovenaan het blok Klant in `offertes.js` (`searchCustomers`/`pickCustomer`); `GET /api/quote-customers?q=` zoekt op de server (max 20, actief, via `store.listCustomerPage({ activeOnly })`) en geeft naam, bedrijf, e-mail, telefoon en adres; een keuze vult `customer.*` in en zet `customerId`. Een nieuwe plek die een klant kiest gebruikt deze zoekroute, nooit de hele lijst.
- **Nieuwe klant vanuit de offerte en btw verlegd** (1.9.9, geen migratie): knop *Nieuwe klant* in `offertes.js` (`openNewCustomer`/`saveNewCustomer`) maakt via `POST /api/customers` een klant (adres via de postcodezoeker, alleen met recht `klanten`; Zakelijk alleen met `beheer`) en kiest hem meteen. Het adres staat als tekst (`AddressLookup.mirror`, verborgen veld), niet als invulveld. *Btw verlegd*: `data.vatShift` {on, number, status, checkedAt, requestId, name} in de offerte; `QuoteCore.vatShifted/totals` (alles 0% btw, alleen met nummer én status `geldig`: onbereikbaar of nog niet gecontroleerd = gewoon tarief), `applyVatShift` in quotes.js controleert het nummer bij VIES (gedeelde `vies` uit server.js; nummer geldig en niet NL, `ongeldig` = 409 `vat_invalid`, `onbereikbaar` wordt bewaard) en overschrijft altijd het bewijs uit de browser. Het offerteadres is alleen vrij te typen als VIES het nummer *geldig* noemt (`checkVatShift` draait vóór de adrescontrole, `addressToVerify`; bij onbereikbaar blijft PDOK gelden, en een adres met een Nederlandse postcode wordt altijd gecontroleerd; nieuwe VIES-vragen max. 20 per minuut per gebruiker; `data-address-manual` in address-lookup.js). Een factuur uit zo'n offerte (`fromWorkOrder`) krijgt 0% btw en de vermelding. Een buitenlandse klant als *klantrecord* kan niet: `sanitizeBusinessProfile` eist een KvK-nummer en `requireVerifiedAddress` een PDOK-adres.
- **Betaaltermijn per klant** (1.10.0, migratie 56 `users.payment_days`, leeg = standaard): `store.cleanPaymentDays` (0-365, `''`/null = standaard); in het veld *Betaaltermijn (dagen)* van de klantkaart (`PATCH /api/customers/:id`, recht `klanten`). De offerte heeft `data.paymentDays` (`QuoteCore.sanitizePaymentDays`): de klantkeuze vult hem in (`/api/quote-customers` geeft de termijn van de klant of de standaard), `withPaymentDays` in quotes.js vult de standaard (factuurinstellingen `paymentDays`) in bij een lege waarde, `acceptance.paymentDays` legt hem bij het akkoord vast. `fromWorkOrder` zet hem op de factuur (`data.paymentDays`, `InvoiceCore.sanitize` rekent de vervaldatum ermee, `paymentText({ days })`). Webshop- en losse facturen gebruiken de standaard.
- **Documenttaal per klant** (1.10.2, migratie 58 `users.document_language`, `nl`|`en`): teksten van klantdocumenten staan in `frontend/shared/doc-text.js` (`DocText.text(taal, sleutel, waarden)`, `clean`, `localeOf`; UMD, ook door de server geladen; een nieuwe tekst in een klantdocument komt in beide talen in `TEXTS`, test eist dezelfde sleutels en invulvelden). De taal staat op de offerte (`data.language`, gekozen via de klantkeuze of de lijst *Documenttaal*) en op de factuur (`data.language`, uit de offerte via `fromWorkOrder`); `quote-view.js` (document + `signForm`), `openbaar/offerte.js`, `invoice-pdf.js`, `invoice-mail.js`, de verstuurmail en de bevestiging in quotes.js gebruiken hem. Een Engels document krijgt de Engelse betaaltekst/mail (`paymentText({ language })`); de ingestelde teksten in Facturen > Instellingen zijn Nederlands. Een nieuwe pagina die `DocText` nodig heeft voor de klant laadt `shared/doc-text.js` (de openbare offertepagina staat in `PUBLIC_FILES`). Webshopfacturen blijven Nederlands.
- **Interne notitie per offerte** (1.10.4, geen migratie): `data.internalNote` (`QuoteCore.sanitize`, 2000 tekens), blok *Interne notitie* in de editor; `forCustomer` in quotes.js haalt hem weg (portaal, openbare link), document/pdf/Excel/mail tonen hem niet. `WorkOrderCore.fromQuote` kopieert hem naar `data.internalNote` van de werkorder (alleen medewerkers; `customerWorkOrder` en `handoverOf` zijn whitelists, dus hij lekt niet). **Een nieuw klantgericht uitvoerkanaal van een offerte of werkorder toont `internalNote` nooit.**
- **Kortingsregel op offerte en factuur** (1.10.6, geen migratie): `discountType` (`pct`|`amount`), `discountPct`, `discountAmount` (excl. btw, nooit hoger dan het subtotaal, volgt het teken bij een credit) en `discountNote` (120 tekens, staat op het document) in `QuoteCore`/`InvoiceCore` (`discountOf`, `discountCaption`; `totals` rekent de fractie over de btw-tarieven en geeft `discountType/Amount/Note` terug). Overname offerte → factuur in `fromWorkOrder`, nacalculatie (`hasDiscount`; vast bedrag niet geschaald) en Visma (fractie per regel). **Een nieuwe plek die de korting toont gebruikt `discountCaption`, nooit `discountPct` alleen.**
- **Werkorders** (`frontend/werkorders/`, 0.28.0, recht `werkorders`:
  beheerder + installateur): kern `workorder-core.js` (UMD, `fromQuote`,
  `zonesFromPlan`, `sanitize`, `progress`), opslag/routes
  `backend/src/uitvoering/workorders.js` (tabel `work_orders`, migratie 10, nummer
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
- **Uren en materiaalverbruik** (0.57.0, `backend/src/uitvoering/worklog.js`, kern
  `werkorders/worklog-core.js`, tabellen `work_order_hours`/`work_order_materials`,
  migratie 23): boeken per werkorder (eigen regels; recht `planning` = ook
  voor collega's en na Gereed), `client_id` maakt POST idempotent (offline
  wachtrij in `worklog.js`), urenstaat `GET /api/worklog` → Excel.
  Voorraad haakt in via `workLogStore.hook(fn)` → `stock_movement_id`.
- **Nacalculatie** (0.71.0, recht `nacalculatie`: standaard beheerder): kern
  `werkorders/costing-core.js` (UMD, `compute`), route `GET
  /api/workorders/:id/costing` in `backend/src/uitvoering/costing.js` (hergebruikt
  `invoices.workOrder/quote/list`, `workLogStore.list`, `stock.saleInfo` met
  `{ withCost: true }`; `costPrice`/`hourlyCost` nooit naar facturen-API of klanten), blok + Excel in `werkorders/costing-panel.js`. Kostprijs per
  uur = `quoteProfile.hourlyCost`. Geen eigen tabel.
- **Startscherm installateur** (0.42.0): blok *Vandaag* op het dashboard
  (`dashboard/today.js`, recht `werkorders`), API `GET /api/my-day`
  (`workorders.day`: elke werkdag via `Core.workDays`, `next`, fototelling
  via `ctx.photoCounts`). `werkorders/?id=…#fotos` springt naar de foto's.
- **Installatiedossier per locatie** (0.70.2, `backend/src/uitvoering/locations.js`):
  geen tabel; locatie = adres van werkorder/melding via `locationKey`
  (photos.js, `l-<sha256>`). `GET /api/locations[/:key]` (recht `werkorders`,
  weergave *Per locatie* in `klantdossier/`, `?locatie=`) en
  `GET /api/portal/locations/:key` (klant, zonder bedragen/verbruik/interne
  velden; `portaal/locaties.js`). Portaal-werkorders en -meldingen hebben `location`.
- **Klantportaal** (`frontend/portaal/`, 0.37.0, recht `portaal`: alleen
  klant): `backend/src/uitvoering/portal.js`, `GET /api/portal` (plannen, offertes,
  werkorders, contact) en `/api/portal/workorders/:id` (opleverdossier via
  `customerWorkOrder`, zonder uren/instructies/notities). Werkorder zichtbaar
  als `quotes.customer_id` = klant en offerte ≠ concept. Optioneel:
  `ctx.photos.list(tid, woId, { customerOnly })` en `workorders.respond`
  (afspraak bevestigen, `POST .../appointment`).
- **Klanten** (1.9.7, module `frontend/klanten/`, recht `klanten`: beheerder + installateur, migratie 54 `users.address`, 55 index `invoices_customer`): een klant is een
  account met een rol van het soort klant (`keysOfKind('klant')`), ook zonder inlog (`store.createCustomer`, `password_hash` NULL, niemand
  kan erop inloggen). `verkoop/customers.js`: `GET|POST /api/customers` (zoeken `q`, filter `group`, `limit`/`offset`), `GET|PATCH
  /api/customers/:id` (klantkaart met offertes/werkorders/facturen, elk alleen met het bijbehorende recht), `POST .../invite` (zeven dagen
  geldige wachtwoordlink van de webshop, `shopAccounts.invite`; alleen hoofdtenant + mail + webadres). Klantgroep en groothandel wijzigt
  alleen recht `beheer`; adres altijd via `requireVerifiedAddress`. Beheer > Gebruikers heeft die velden niet meer (knop *Klantkaart*).
- **Foto's + klantdossier** (0.38.0): `backend/src/uitvoering/photos.js` (tabel
  `work_order_photos`, migratie 14; afbeelding + miniatuur via
  `vault.sealBytes` met AAD `<tenant>:foto:<id>:beeld|mini`, als tekst in de
  db zodat ze in back-ups/Supabase meegaan; server controleert JPEG/PNG/WebP
  op inhoud en stript EXIF). Frontend `werkorders/photos.js|.css` (upload,
  camera via `capture`, `PhotoViewer`), module `frontend/klantdossier/`
  (`/api/dossiers[/:key]`, key `a-<klant-id>` of `n-<hash naam>`).
  Klantportaal: `photos.list(..., { customerOnly: true })` en
  `GET /api/portal/photos/:id`.
- **Kleurthema** (0.44.0): `frontend/shared/theme.js` (UMD: `sanitize`,
  `problems` = contrast met wit, `derive`, `vars`, `css`, `apply`). Instelling
  `theme` (`platform: true`, Beheer > Instellingen weigert hem), alleen via
  `GET|PUT /api/admin/theme` (Beheer > Kleuren, recht `beheer`, 1.9.3: de organisatie komt uit de sessie, nooit uit de invoer; de hoofdtenant-standaard wijzigt bij multitenancy alleen een hoofdbeheerder; Hoofdbeheer
  heeft alleen nog platformbreed: tenants, hoofdbeheerders, Multitenancy). Hoofdtenant = standaard voor iedereen, live-tenant
  optioneel eigen thema (`themeFor` in server.js, testomgeving volgt
  live-tenant). Server levert `shared/theme.css` (openbaar, na brand.css op
  elke pagina, statisch leeg bestand voor file://), injecteert het in
  login/setup/wachtwoord, en openbare API's geven `theme` (vars) mee.
  **Nieuwe kleuren in CSS altijd via `--at-*`-variabelen**, nooit hardcoded.
- **Wachtwoord** (0.31.0): eigen wijzigen via `POST /api/account/password`
  (pagina `backend/src/paginas/password.html`, route `/wachtwoord`, inline script op
  CSP-hash). `users.must_change_password` (migratie 12): zolang aan toont
  elke pagina het wachtwoordscherm en geeft de API 403
  `password_change_required` (behalve me/health/auth). Standaard aan bij
  aanmaken door een beheerder en bij een reset (`withMustChange` in server.js);
  tests die met zo'n account inloggen geven `mustChangePassword: false` mee.
- **Mijn profiel** (0.43.0): pagina `frontend/profiel/` (geen tegel in
  modules.js; link in het gebruikersmenu van `dashboard/account.js` en
  onderaan `shared/sidebar.js`). API `GET/PUT /api/account/profile`
  (`store.updateProfile`), kolommen `users.email|phone|preferences`
  (migratie 15). Voorkeuren alleen de sleutels uit `PREFERENCES` in store.js
  (`preferencesOf`): `startPage` (dashboard.js stuurt bij de eerste keer per
  tabblad door) en `mailCopy` (bcc via `copyTo` in quotes/workorders.js).
  Versienummer staat niet meer in de kopbalk, alleen voor beheerders op het profiel.
- **Webshopkoppeling** (0.29.0, prototype WooCommerce): `backend/src/webshop/woocommerce.js`
  (adapter Store API/REST v3, `sanitizeShop`, alleen openbare https tenzij
  `SHOP_ALLOW_INSECURE=1` voor tests) en `backend/src/webshop/shop.js` (tabellen
  `shop_products`/`shop_sync`, migratie 11; koppelen aan `Catalog.articles`:
  handmatig code→sku, meta `aquatech_code`, sku = code). Instellingen
  `shopSource` + geheimen `shopConsumerKey`/`shopConsumerSecret` per tenant.
  API `GET /api/catalog` (ingelogd), `/api/admin/shop[/sync]` (beheerder).
  Frontend `beregening/js/shopcatalog.js` legt de prijzen over de catalogus
  (planner + offertes, vóór `fromPlan`); beheer in `beheer/webshop.js`.
- **Uitbesteden** (0.48.0, module `frontend/uitbesteden/`, recht `uitbesteden`:
  beheerder): `backend/src/uitvoering/outsourcing.js`, tabel `work_order_offers`
  (migratie 17; `tenant_id` = uitbesteder, `to_tenant_id` leeg = iedereen,
  na aannemen `receiver_tenant_id` + `received_work_order_id`, geen FK's naar
  de andere organisatie). Opt-in via instelling `outsourcing` {send, receive,
  region}; alleen tussen omgevingen van hetzelfde soort (live/test). Vóór
  aannemen alleen `previewOf` (geen klantgegevens/instructies), daarna
  `handoverOf` → `workorders.createReceived` (werkorder zonder offerte). De
  uitbesteder ziet alleen `execution` (status, planning, stappen). Werkorder-API
  geeft `outsourcing` mee (`ctx.outsourcingOf`).
- **Voorraadbeheer / Artikelen** (0.59.0; hernoemd in 1.4.0, module `frontend/artikelen/`, recht `voorraad`:
  beheerder + installateur): `backend/src/artikelen/stock.js`, tabellen `stock_items`
  (code uniek per tenant = catalogus-/stuklijstcode, `on_hand`),
  `stock_movements` (logboek met `balance`, `source` `gereed`|`handmatig`|
  `verbruik:<id>`) en `stock_reservations` (migratie 24). Reserveren =
  benodigd − afgeboekt voor open werkorders, via `ctx.onChange` in
  workorders.js (na POST/PUT/DELETE). Gereed boekt de reservering af, tenzij
  er verbruik is (`syncUsage`, idempotent per verbruiksregel; vanuit
  `workLogStore.hook` met `{ nested: true }`, want `transaction` nest niet). Blok Voorraad op de
  werkorder: `werkorders/stock-panel.js`, API `/api/stock/workorders/:id`
  (recht `werkorders`). Bestelvoorstel (0.70.0, migratie 30): `reorder_qty`
  (*Bestellen tot*, leeg = 2× minimum), `GET /api/stock/reorder`
  (`stock.reorderProposal`), Excel in de browser.
- **Leveranciers** (1.10.8, migratie 59, `artikelen/suppliers.js`, tabblad Leveranciers + blok per artikel in `frontend/artikelen/suppliers.js`): `suppliers` (naam uniek per organisatie zonder hoofdletters, archiveren i.p.v. verwijderen zodra een artikel eraan hangt) en `item_suppliers` (artikelnummer leverancier, `cost_price` leeg = prijs van het artikel, `order_qty` = bestellen in veelvouden, hoogstens één `preferred`). `GET|POST|PATCH|DELETE /api/suppliers`, `GET|PUT /api/stock/items/:id/suppliers` (recht `voorraad`); een hoofdartikel heeft er geen, `stock.removeRow`/`setVariants` wissen de koppelingen. Bestelvoorstel per leverancier (1.10.9, geen migratie): `stock.reorderProposal(tenantId, { preferred })` met `suppliers.preferredByItem` rondt op `order_qty` af, gebruikt de leveranciersprijs en geeft `suppliers` (groepen) terug; Excel groepeert per leverancier. 
- **Inkoop in de zijbalk** (1.11.6, geen migratie): groep `inkoop` in modules.js met Bestelvoorstel, Inkooporders, Leveranciers en Mutaties als modules met `partOf: 'voorraad'` en een #-adres als `href` (`artikelen/#orders`); `currentId` in sidebar.js markeert het open tabblad, `showTab` roept `AquatechNav.refresh()` aan. Een nieuwe inkoopregel = één module-regel + een tabblad in `artikelen/` (`TABS`, `data-purchasing`). Bestelvoorstel is een tabblad (`loadReorder`).
- **Inkooporders** (1.11.0, migratie 61, `artikelen/purchase-orders.js`, tabblad Inkooporders in `frontend/artikelen/orders.js`): `purchase_orders` (nummer `IO<jaar>-0001`, status concept|besteld|deels_ontvangen|ontvangen|geannuleerd) en `purchase_order_lines` (momentopname van code/naam/eenheid/artikelnummer leverancier, `qty`, `unit_cost`, `received_qty`). `receive` controleert eerst alles en boekt dan via `stock.book` (soort ontvangst, bron `inkoop:<nummer>`, `unitCost` van de regel → FIFO-laag); **een opslagfunctie die een fout teruggeeft in plaats van gooit, mag binnen `transaction` niets half geschreven hebben** (valideer eerst). `incomingByItem` (concept + besteld + deels ontvangen) gaat als `incoming` in `stock.reorderProposal`, zodat niets dubbel wordt besteld (ook bron voor het verwachte aantal bij backorders, punt 15). `fromProposal` maakt per voorkeursleverancier een concept (binnen een transactie via `insertOrder`, want `transaction` nest niet). Leverancier en artikel met orders worden gearchiveerd i.p.v. verwijderd. **Inlezen** (1.11.4, migratie 64 `purchase_orders.supplier_reference`): `POST /api/purchase-orders/read` (`order-read-route.js`, lezer `order-reader.js` met `createApp({ createOrderReader })` voor tests, koppeling `order-matching.js`) leest PDF/foto met de AI van de omgeving (zelfde limieten als plan herkennen, feature `inkoop_inlezen`) en schrijft niets; `POST /api/purchase-orders` met `receiveNow` maakt en boekt alles in (alles of niets, `createReceived`), `rememberSkus` bewaart leveranciersnummers (`suppliers.rememberSku`).
- **Prijsfactor** (migratie 65, `artikelen/price-factor.js`, tabblad Prijsfactor in `frontend/artikelen/price-factor.js`, sidebar Inkoop): `stock_items.price_mode` (`vast` = zoals altijd | `factor`) + `price_factor` (eigen factor, leeg = erven). Verkoopprijs (excl. btw) = inkoopprijs × factor, afgerond met `roundPrice` (instelling `priceFactors`: `defaultFactor`, `rounding` {mode: cent|0.05|0.10|0.50|1.00|x.95|x.99, direction: dichtstbij|omhoog}, factoren per categorie en leverancier; alleen via `GET|PUT /api/stock/price-factors`, opslaan recht `beheer`). **Rangorde**: artikel > voorkeursleverancier > diepste categorie met factor (via het webshopproduct en `placeIn`) > standaard. Opslaan van een artikel in de modus factor rekent de prijs meteen alleen als modus, eigen factor of inkoopprijs verandert (`stock.setPricer`); een nieuwe inkoopprijs uit een ontvangst wijzigt de verkoopprijs nooit vanzelf: het voorbeeld (`view().preview`) toont afwijkende artikelen en `POST .../apply` rekent opnieuw en voert alleen door wat nog gelijk is aan het voorbeeld (`stock.setSalePrices` zet `shop_dirty`). Verpakkingen zonder eigen prijs en zakelijke kortingen rekenen over de uitkomst. **Een nieuwe plek die een verkoopprijs uit de inkoopprijs berekent gebruikt `PriceFactor.priceFrom`/`roundPrice`, nooit een eigen afronding; een nieuwe verkoopprijs voor meerdere artikelen gaat via `stock.setSalePrices`.** Margeweergave: `PriceFactor.marginPct` (% van de verkoopprijs, `margin` in de artikel-API).
- **Artikelen samenvoegen tot variabel artikel** (1.5.8, `backend/src/artikelen/variant-suggestions.js` + `stock.mergeSuggestions|mergeIntoVariants`, `frontend/artikelen/merge.js`): geen migratie. `GET /api/stock/merge-suggestions` (groepen op naam minus maat/kleur, zelfde eenheid/btw/omzetgroep) en `POST /api/stock/merge { ids, code, name, attributeName, values }` zetten losse artikelen onder een nieuw hoofdartikel; id, code, voorraad, prijzen, boekingen en reserveringen blijven (verwijzingen elders gaan op code). Een apart webshopproduct-koppeling vervalt (daarna *In webshop zetten*). Terugdraaien kan niet automatisch.
- **EAN en etiketten** (1.11.1, migratie 62 `stock_items.ean`, unieke index `(tenant_id, ean)` waar gevuld): `frontend/shared/barcode.js` (UMD: `cleanEan`, `encodeEan`, `encodeCode128`, `forItem`, `bars`; ook door de server geladen), `artikelen/labels.js` (`sanitizeLabelTemplates` = instelling `labelTemplates`, `buildLabelPdf`, routes `GET /api/stock/label-templates` en `POST /api/stock/labels`, recht `voorraad`). PDF via `createPdf({ pageSize })`, één etiket per pagina, geen ZPL. Strepen min. 0,19 mm (`MIN_MODULE_MM`), anders een melding. Frontend: blok *Etiketten* in `artikelen/labels.js`, editor in Beheer (`#s-labels`, `renderLabelTemplates` in beheer.js). **Een nieuwe plek die etiketten afdrukt gebruikt `ItemLabels.print(items, sjabloon)`; streepjescodes altijd via `Barcode`, nooit een eigen codering.**
- **Verpakkingen** (1.11.2, migratie 63, `artikelen/packagings.js`, blok in `frontend/artikelen/packagings.js`): `item_packagings` (code uniek per artikel, `factor` ≥ 2 basiseenheden, `sale_price`/`business_price` leeg = factor × stukprijs, eigen `ean`, `audience` iedereen|zakelijk|groothandel via `visibleFor`). Voorraad blijft in de basiseenheid. `GET|PUT /api/stock/items/:id/packagings` (lijst wordt vervangen; EAN uniek over artikelen én verpakkingen: `eanTaken` in stock.js controleert beide). Deel B (1.11.5, `webshop/web-orders.js`): winkelwagencode `CODE@PAL` (`splitCartCode`), `priceCart` geeft een regel met `code` = wagencode, `baseCode`, `stockPer` (= factor), aantal en prijs per verpakking en beschikbaarheid `floor(voorraad / factor)`; voorraad in de basiseenheid via `stockQtyOf`/`stockLinesOf` (reserveren, afboeken, retour-terugboeking, `web-sales`). Een nieuwe plek die bestelregels naar voorraad vertaalt gebruikt `stockQtyOf`. De keuze van een verpakking op de productpagina volgt bij punt 33. **Nieuwe code die een artikel verwijdert of hoofdartikel maakt wist ook `item_packagings`.**
- **Kortingen per productcategorie voor zakelijke klanten** (geen migratie): instelling `categoryDiscounts` {rules [{categorySlug, discountPct}]} (`internal`, alleen via `GET|PUT /api/admin/category-discounts`, `webshop/category-discounts.js`, Beheer > Webshop > Zakelijke kortingen in `beheer/kortingen.js`); slugs zijn die van het gepubliceerde webshopmenu. **Rangorde**: diepste categorie met een korting wint (`resolverFor`); een eigen zakelijke prijs van het artikel en een verpakking met eigen prijs gaan voor (geen categoriekorting); verpakking zonder prijs = factor × stukprijs met de hoogste van categorie- en (groothandel) klantkorting, geen staffel; groothandel = hoogste van staffel/klant/categorie (`wholesalePrice(…, categoryDiscount)`, bron `categorie`), nooit opgeteld; particulier nooit. `buildCatalog(rows, sold, tree, config)` zet `priceBusiness` (na korting), `priceBusinessList`, `categoryDiscountPct` en `discountByCode`; de catalogcache onthoudt de kortingen (`discountKey`). `priceCart` haalt de kortingen via de injectie `categoryDiscountsOf` (server.js, alleen een catalogus als er regels zijn). Offertes gebruiken geen zakelijke prijzen. **Een nieuwe plek die een zakelijke prijs toont of berekent gebruikt `priceBusiness`/`priceCart`, nooit `business_price` of `sale_price` rechtstreeks; een groothandelsprijs rekent over `priceBusinessList` met `categoryDiscountPct`.** Orderregels van een verpakking dragen `itemName` (artikelnaam voor de rapportage in de basiseenheid).
- **Artikelafbeeldingen** (1.5.7, `backend/src/artikelen/item-images.js`, migratie 41): tabel
  `item_images` (versleuteld via `vault.sealBytes`, `content_hash` = gedeelde foto's,
  `source_url`) + `stock_items.image_id`; één afbeelding per artikel, upload via
  `PUT /api/stock/items/:id/image` (browser verkleint tot 1200 px), shop toont hem via
  `winkel/artikelfoto/<id>` (catalogus-waarde `own:<id>`, `imageOf` in storefront-data.js, geldt vóór
  het adres van het webshopproduct). Overnemen uit de oude webshop: knop *Afbeeldingen uit webshop*,
  `POST /api/stock/images-import { after }` in porties van 25, herhaalbaar. Tests: `imageFetch` in
  `createApp`. Een nieuw artikelveld in een formulier met knoppenrij: gebruik `.row.actions`.
- **Verkoop, webshop en facturen** (0.61.0, Brincr vervangen deel 1; migratie 26):
  `stock_items` heeft `sale_price`/`vat_rate`/`revenue_group` (Aquatech = bron).
  `backend/src/webshop/shop-sync.js`: tweerichting met WooCommerce REST v3
  (`shopSource.push`/`pushStock`): prijs + beschikbaar (stand − gereserveerd)
  terug via `/products/batch`, daling webshopvoorraad t.o.v. `shop_stock_seen`
  = verkoop (afboeking bron `webshop`), alleen-in-webshop gewijzigde prijs
  wordt overgenomen; `shop_dirty` + `stock.onDirty` → na 3 s, elke 10 min
  `app.locals.shopSyncAll`. Facturen: `backend/src/verkoop/invoices.js` + kern
  `facturen/invoice-core.js` (UMD), tabel `invoices`, recht `facturen`
  (beheerder), instelling `invoicing` (voorvoegsel, betaaltermijn,
  omzetcategorieën groep × btw met grootboekrekening). Concept → definitief
  (nummer `<prefix><jaar>-0001`, vergrendeld) → betaald; credit = nieuw
  concept met negatieve regels. Losse verkoop boekt voorraad af (bron
  `factuur:<id>`). Export Visma als Excel (`exportRows`). Gepland: deel 3
  Visma eAccounting-API.
- **Artikelen met varianten** (1.3.3, migratie 33): hoofdartikel
  (`stock_items.has_variants`, kenmerken in `attributes` `[{ name, values }]`)
  zonder eigen voorraad; elke combinatie is een variant (gewoon
  voorraadartikel met `parent_id` + `variant_values`, eigen code/prijs/
  voorraad). `stock.setVariants` (API `PUT /api/stock/items/:id/variants`)
  maakt ontbrekende varianten aan; eenheid/btw/omzetgroep/archiveren volgen
  het hoofdartikel. Hoofdartikel-code op een werkorder reserveert niets
  (`chooseVariant`). Keuzelijst `GET /api/stock/articles` +
  `shared/article-picker.js` (werkorder/offerte: eerst artikel, dan maat).
  WooCommerce: variaties komen mee (REST), `shop_product_id` van een variant =
  variatie-id, push via `/products/<id>/variations/batch`,
  `createMissingVariations` + `publish` (knop *In webshop zetten*) maken
  producten/variaties aan vanuit Aquatech.
- **Online betalen in de eigen webshop** (1.5.3, Mollie): instelling
  `shopPayment` {online, publicUrl, onAccount, holdHours} + geheim
  `mollieApiKey` (alleen hoofdtenant, Beheer > Webshop > Betalen).
  `webshop/mollie.js` (client, tests via `createApp({ mollieFetch })` en
  `test/helpers/mollie-fake.js`), `webshop/web-payments.js` (start, sync,
  expireUnpaid, optionsFor). Bestelling met `data.payment = 'online'` heeft
  `data.pay` {status open|betaald|mislukt|verlopen, id, ids, checkoutUrl}; de
  uitkomst komt altijd uit een opvraging bij Mollie (webhook `POST
  /winkel/mollie/webhook/<bestelling>/` krijgt alleen het id, terugkeer
  `?betaald=1` vraagt zelf op); overgang naar betaald één keer via
  `web-orders.changePay`. Verzenden pas na betaling, bevestigingsmail pas na
  betaling, factuur van online betaalde bestelling al bij de betaling (definitief + betaald, `onPaid`-haak; afrondingsregel in `fromWebOrder` houdt het bedrag gelijk), onbetaald
  vervalt na `holdHours` (`app.locals.webPaymentsExpire`, elk uur). Redirect
  naar Mollie loopt via GET `bestelling/<id>/betalen/` (CSP `form-action
  'self'` blokkeert een redirect direct vanuit het formulier).
- **Afleveradres** (geen migratie): webshopbestelling `data.address` = afleveradres (verzenden/pakbon), `data.billingAddress` = factuuradres, `data.deliverySame`; het formulier stuurt `deliveryForm=1` mee en zonder `deliverySame=ja` geldt "afwijkend" (`deliverySameOf`; een aanroep zonder `deliveryForm` = gelijk). Velden `delivery*` (PDOK-controle per adres, `deliveryUnverified`), `billingCountry`. `fromWebOrder` zet het factuuradres op de factuur. Offerte: `data.delivery` {same, address}; werkorder/bestelling uit een offerte gebruikt dit later (items 7/8). **Een nieuwe plek die een bestelling verzendt of een pakbon maakt gebruikt `address`, een factuur `billingAddress || address`.**
- **Planner ↔ webshop** (1.7.3, geen migratie): `GET /api/config` geeft `shop` (`{ ordering }` of `null`, alleen hoofdtenant met `storefront` aan); planner (`beregening/index.html`, `data-shop-link`) en zijbalk (`shared/sidebar.js`) tonen daarmee de link terug naar `/`. Knop *Alles in winkelwagen* in de stuklijst (`app.js` `_cartForm`) post `q:<code>` naar `POST /winkelwagen/planner` (storefront.js; `plannedLinesFrom` + `setCartLines` in storefront-cart.js): prijs, btw, varianten, voorraad en groothandelsvoorwaarden komen uit `priceCart`, het planaantal *vervangt* het aantal in de wagen, onbekende codes gaan als `?plan=&niet=` naar de winkelwagenpagina. Een nieuwe plek die materiaal naar de wagen stuurt gebruikt dit adres.
- **Knop naar het beheer in de shopkop** (1.9.2, geen migratie): `viewer.isStaff` (shop-accounts.js, = account dat geen klant is) → `staff` in `renderWith`; `layout()` toont `.shop-admin` (header) en *Naar het beheer* (mobiel menu) naar `${root}app/`. Gast/klant/bezoeker nooit; pagina's voor staff zijn `private, no-store`. Een nieuwe shopkop-knop voor ingelogden volgt dit patroon (rol op de server, niet met CSS).
- **Vindbaarheid voor zoekmachines en AI** (1.7.2, `webshop/seo.js`, geen migratie): zuivere functies voor JSON-LD (`Store`, `WebSite`, `Product`/`Offer`, `BreadcrumbList`, `FAQPage` uit de Beheer-pagina `veelgestelde-vragen`), `robots.txt`, `sitemap.xml`, `llms.txt` en `productfeed.xml` (Merchant Center); routes in `storefront.js` (alleen bij shop aan), `layout()` in storefront-pages.js zet canonical/OpenGraph via `seoHead`. Een pagina zonder `canonicalPath` krijgt `noindex`; **een nieuwe openbare pagina die in zoekresultaten hoort geeft dus een `canonicalPath` mee** (en komt in `sitemapEntriesOf`). Webadres: `shopPayment.publicUrl`, anders de host van het verzoek (`publicBaseUrl`). Prijzen in JSON-LD/feed zijn altijd consumentenprijzen incl. btw.
- **Adres via postcode** (1.5.5, PDOK Locatieserver): `backend/src/platform/address-lookup.js`
  (server haalt op, 24 u cache, tests via `createApp({ addressFetch })`), routes
  `GET /api/address-lookup` (login) en `GET /winkel/adres/`; de browser belt nooit
  rechtstreeks naar PDOK. Gedeelde frontendcomponent `shared/address-lookup.js`:
  zet `data-address-lookup` op een adresveld en laad het script; de shop gebruikt
  `AddressLookup.attach` in `storefront-checkout.js`. Nieuwe adresvelden altijd zo. Sinds 1.5.6 is het adresveld zelf alleen-lezen (alleen postcode/huisnummer/toevoeging invulbaar) en controleert de server elk gewijzigd adres met `createAddressGuard`/`requireVerifiedAddress` (moet exact PDOK zijn; ongewijzigd ouder adres blijft geldig); een nieuwe route die een adres opslaat krijgt die middleware. Tests gebruiken `test/helpers/pdok-fake.js` (`addressFetch`).
- **Afrekenen zonder knop** (1.5.5): land/btw-nummer/verzendmethode werken het totaal op de achtergrond bij (`storefront-checkout.js`, `refreshTotals`, onderdeel `data-shipping-options` + `.checkout-summary` worden vervangen); de knop *Totaal bijwerken* is alleen de terugval zonder script. Nieuwe invoer die het totaal beïnvloedt: stuur hem mee in `refreshTotals`.
- **Groothandelsvenster** (1.6.1, `webshop/wholesale.js` + `storefront-wholesale-pages.js`, migratie 44): `/winkel/groothandel/`
  voor klanten met `users.wholesale` (alleen bij klantgroep `zakelijk`, vaste korting `wholesale_discount` 0-50%; Beheer >
  Gebruikers). Snelbestellijst, plakken van code + aantal (`parseOrderList`) en opnieuw bestellen posten alle naar hetzelfde adres
  (veld `action`, dus relatieve links blijven kloppen). Per artikel `order_pack_size`, `order_min_qty` (veelvoud van de eenheid) en
  `price_tiers`; **let op**: `min_qty` is de minimumvoorraad, niet de minimale afname. Stukprijs = zakelijke prijs min de hoogste van
  staffel- en klantkorting (niet opgeteld). Voorwaarden gelden alleen voor groothandelsklanten (`priceCart(..., { wholesale })`;
  `packProblem` blokkeert afrekenen). Winkelwagencookie: 60 regels, 9999 stuks, 3600 tekens (`addCartLines`).
- **Categorieboom en menu** (1.6.9, `webshop/category-tree.js|.json`, geen migratie): de indeling van aquatechshop.nl (hoofdcategorie → tot vijf niveaus) met intro en afbeelding (`assets/cat-*.webp`, lokaal). Een product hangt op *naam* aan de diepste passende categorie (`placeIn`; de webshop levert alleen platte namen); onbekende namen blijven losse categorieën, alleen een hoofdcategorie genoemd = *Overig*, `hidden` = alleen via het adres (Beregening oud). `catalog.categories[]` heeft `children`/`parentSlug`/`depth`/`count` (incl. subcategorieën); `groups[].categories` zijn de bovenste. Menu: koppen zonder link, flyout per niveau (`nav-fly`, CSS), smal scherm geneste `details`. Pagina's `groep/<slug>/` en `categorie/<slug>/` delen `browsePage` (zijbalk, prijsfilter, blokken, sorteren, 24 per pagina). Aanpasbaar (1.7.0) in Beheer > Webshop-inhoud > Menu: content-sleutel `menu` in `shop_content` (concept/live/vorige, `normalizeTree` in shop-content.js, `treeOf` in `createStorefrontData`, editor `beheer/webshop-menu.js`); de vier koppen (`group`) zijn vast, hernoemen houdt de indeling via `match`. De standaardboom (JSON) geldt zolang er niets gepubliceerd is.
- **Dropshipping met eigen pakbon** (1.12.6, migratie 68 `web_order_slips`, `webshop/order-slips.js`, geen DPD): afrekenvelden `dropshipping=ja` + `dropshipProofEmail` (niet bij ophalen) → `data.dropshipping` {proofEmail, slip}; de klant uploadt de PDF na het bestellen via `POST /bestelling/:id/pakbon` (raw `application/pdf`, ≤ 2 MB, ≤ 10 pagina's, `inspectSlip` bouwt hem met pdf-lib opnieuw op, versleuteld per bestelling). `pickable` eist de pakbon; `packing-slips.js` `pdfFor` (async) zet via `assemblePdf` de klantpakbon in plaats van de onze. Verzendmail gaat ook naar `proofEmail`. **Een nieuwe plek die een pakbon van een bestelling toont of afdrukt gebruikt `pdfFor`, nooit `packingSlipsPdf` rechtstreeks.** Het afleverbewijs zelf komt met de DPD-koppeling.
- **Inkoopprijzen, FIFO en margerapportage** (1.6.2, migratie 45): `artikelen/stock-costs.js`
  (prijshistorie `stock_cost_prices`, lagen `stock_layers`, kostregels `stock_cost_entries`); elke mutatie via
  `stock.book` gaat langs de lagen (oudste eerst, retour tegen de prijs van de afboeking via `costBasis`,
  onbekende prijs blijft leeg, nooit raden). Nieuwe code die voorraad wijzigt moet via `book`, nooit
  `on_hand` rechtstreeks. Rapportage `webshop/web-sales.js` (`web_sale_lines`, aangevuld bij elke rapportage
  via `sync`, `GET /api/admin/webshop-report`), tabblad Rapportage in `webshop-bestellingen/`.
- **Debiteuren, webshopbestellingen, PDF en mail** (0.63.0, migratie 27):
  `debtors.js` (tabel `debtors`, `ensure` bij definitief, `match_key`),
  `shop-orders.js` (WooCommerce-bestellingen met status uit
  `invoicing.shopOrders` → factuur met `shop_order_id`, uniek; elke 10 min na
  shopsync), `pdf.js` (eigen PDF-schrijver, geen bibliotheek) +
  `invoice-pdf.js`, `invoice-mail.js` (`send`/`autoSend`, PDF als bijlage,
  `invoicing.autoSend`). Routes `/api/invoices/:id/pdf|mail|send`,
  `/api/invoices/shop-orders/sync`, `/api/debtors[/:id]`.
- **Eigen assortiment in de planner** (0.64.0): `/api/catalog` geeft
  `assortment` (catalogus-codes die als niet-gearchiveerd voorraadartikel of
  gekoppeld webshopproduct bestaan). Niet leeg → `Catalog.setAssortment`
  (via `shopcatalog.js`): planner kiest alleen beschikbare artikelen
  (`C.available`/`C.pick`/`C.typeAvailable`, buizen gefilterd in `C.pipes`,
  rotatorkop via `autoRotatorModel`); `BOM.build` zet de rest in
  `rows.missing` (niet in stuklijst/offerte). Leeg = standaardcatalogus.
  Nieuwe artikelcodes in bom.js altijd via `add()` (en zo mogelijk `pick()`).
- **Visma eAccounting** (0.65.0, `backend/src/verkoop/visma.js`, migratie 28):
  OAuth2 per omgeving (refresh token = geheim `vismaRefreshToken`, keuzes in
  `visma`; beide `internal`: alleen via `/api/visma/*`, recht `facturen`).
  App-registratie óók per omgeving (1.9.3, `vismaApp` + `vismaClientSecret`, beide
  `internal` + `liveOnly`, formulier in Facturen → Visma, `GET|PUT /api/visma/app`,
  recht `facturen`; `app(tenantId)` in visma.js): elke organisatie heeft een eigen
  koppeling, er is niets platformbreeds meer. Factuur
  → verkoopfactuur, debiteur → klant (nummer = debiteurnummer), regel →
  Visma-artikel per omzetcategorie. Automatisch alleen met `visma.autoSync`
  (standaard uit) via `invoices.onFinalized` + `app.locals.vismaAll`, vanaf
  `visma.since`. Tests: nagebootste Visma via `createApp({ vismaFetch })`.
  Veldnamen van de Visma-API nog niet tegen de echte sandbox getest.
  Overzicht + logboek (1.9.4, migratie 52, `verkoop/visma-log.js`): `describeConnection` (scopes in gewone taal, `visma.scopes` uit het tokenantwoord) in `GET /api/visma` (`overview`); tabel `visma_log` (`vismaLog.record(tenantId, …)` via `visma.note`, herhaalde fout = teller `repeat_count`, leesactie max 1× per 30 min, bewaartermijn `auditRetentionDays`), `GET /api/visma/log` met keyset-cursor. **Elke nieuwe Visma-actie schrijft een logregel (kort, nooit tokens/secrets) en krijgt `origin` (handmatig/automatisch) mee.**
  Bediening (1.9.5, geen migratie): `visma.paused` + `visma.parts` {invoices, credits, customers} via `PUT /api/visma/controls`; `pendingFilter(tenantId, …)` geldt voor sync én status (klanten aanmaken uit = alleen al gekoppelde debiteuren); `disconnect` (async) trekt het refresh token in via `/connect/revocation` (best effort, `revoked`). **Een nieuw onderdeel dat naar Visma schrijft krijgt een eigen sleutel in `CONTROL_PARTS` en respecteert `paused`.**
- **Tekening indienen + controle** (0.52.0, `backend/src/beregening/drawings.js`):
  knop *Direct een tekening maken* op login.html → `beregening/?tekenen&org=`
  (`isPublicPlanner` in server.js: pagina alleen met `?tekenen`, code van
  beregening/ + enkele shared-bestanden openbaar; `ANON` in app.js: geen
  serveropslag, eigen localStorage-sleutel). Indienen: `POST
  /api/public/drawing` (instelling `drawingRequests`, limiet per IP en per
  tenant, honeypot `website`, `store.submitDrawing` maakt een gast met
  contactgegevens als eigenaar). Plannen: `review_status` concept |
  ter_controle | goedgekeurd (migratie 20), `POST /api/plans/:id/review-request`
  (klant) en `/review` {approve|reopen} (recht `plannen.goedkeuren`). Klant
  wijzigt goedgekeurd plan → ter_controle. Offerte met `planId` alleen uit een
  goedgekeurd plan (409 `plan_not_approved`, `ctx.planReviewOf`).
- **E-mail** (0.50.0): formulier in Beheer → Instellingen (`#s-mail`), API
  `/api/admin/mail[/test]` (alias van `/api/quote-mail`, in quotes.js).
  `mailServer.mode` `smtp` | `connector` (Exchange Online op IP: geen auth,
  `requireTLS`). WAN-IP via `backend/src/platform/wan-ip.js` (ipify e.a., IPv4, 1 u
  cache, `WAN_IP` gaat voor), route `GET /api/admin/wan-ip`.
- **Meldingen** (0.60.0, `backend/src/uitvoering/service-requests.js`, tabellen
  `service_requests` + `service_request_photos`, migratie 25): klant meldt in
  het portaal een storing/onderhoud met foto's (`/api/portal/requests…`,
  recht `portaal`, foto's via `vault.sealBytes` AAD
  `<tenant>:melding-foto:<id>:…`); medewerkers in module `frontend/meldingen/`
  (recht `werkorders`, `/api/service-requests…`). Omzetten via
  `workorders.createReceived` (werkorder zonder offerte); de klant ziet een
  werkorder als `quotes.customer_id` **of** `service_requests.customer_id` =
  klant (`OF_CUSTOMER` in workorders.js, `portal.ownRow`, `photos.customerOwns`).
- **Seizoensherinneringen** (0.72.0, `backend/src/uitvoering/season-reminders.js`,
  tabel `season_reminders_sent`, migratie 31): instelling `seasonReminders`
  {enabled, portalUrl, items [{key, title, month, day, text}]} in Beheer →
  Instellingen. Elk uur (`app.locals.seasonRemindersAll`) mail via de
  tenant-mailserver aan klanten die in die omgeving wonen (test = alleen
  testaccounts; uitgeschakelde tenants overgeslagen) met e-mail + werkorder, één
  keer per sleutel per jaar (tot 21 dagen na de datum). Portaal: `reminders`
  (60 dagen), knop opent het meldformulier als onderhoud
  (`portaal/?herinnering=<key>`), afmelden via voorkeur `seasonReminders`.
- **Vaste AI-uitkomst + leren** (0.56.0, `backend/src/beregening/recognitions.js`, tabel
  `plan_recognitions`, migratie 22): `/api/plan/analyze` bewaart per omgeving
  onder SHA-256 van de afbeelding + model + `PROMPT_VERSION` (plan-analyzer.js)
  en geeft dezelfde tekening daarna uit de opslag (`recognition.cached`, geen
  kosten/daglimiet); `fresh: true` = opnieuw. Leren: de browser telt per
  kleur/textuur-vakje (`featureKey`, `FEATURE_VERSION`) welk type er lag
  (`LocalRecognizer.learn`) na een AI-herkenning of goedkeuring en stuurt alleen
  tellingen (`POST /api/plan/learn`); `GET /api/plan/learned` telt op,
  `classMap` gebruikt een vakje vóór de vaste regels. Andere vakjesindeling =
  `FEATURE_VERSION` ophogen (in localrecog.js én recognitions.js). Vaste test op
  Daniëls voorbeeldplan `test/fixtures/tuinontwerp-voorbeeld.png`.
- **Sproeierbibliotheek** (0.66.0): `beregening/js/sprinklerlib.js` (UMD,
  `window.SprinklerLib`; elke pagina/sandbox laadt hem vóór catalog.js) met
  behuizingen (`mount`, `regBar`) en nozzles (`group`, `arcs`, `rMin`,
  `matched`, `perf` [{bar, r, q l/u}]). `Catalog.setLibrary(eigen)` leidt
  `rotatorModels`, bereik per sproeiertype en artikelen af; sproeier heeft
  `body` + `model` (nozzle-sleutel, MP-sleutels als voorheen). Rekenen via
  `C.nozzleOf`/`headRange`/`fitHead`/`headPr`/`headMinBar`/`sprinklerFlowLph`.
  Eigen regels per omgeving in tabel `sprinkler_library` (migratie 29,
  `backend/src/beregening/sprinklers.js`, alleen afwijkingen van de standaard), Excel via
  Beheer → Sproeiers (`beheer/sproeiers.js`). Automatisch plaatsen: kostenweging
  `WEIGHTS` in planner.js (groen = 85–130% van het gemiddelde, droog/nat
  omliggend via `dry`/`wet`), type `auto` = `Planner.bestPlace` per gazon.
- **Toverstaf** (`js/autotrace.js`) en PDF-import (`vendor/pdf.min.js`, pdf.js
  3.11.174 met `isEvalSupported: false`) werken volledig in de browser.
- **Snelheid/navigatie** (0.46.0): `shared/common.js` in de `<head>` van elke
  pagina (vóór sidebar.js): `getJson('api/me'|'api/config')` deelt één verzoek
  per pagina, `excel()` laadt ExcelJS pas bij export (geen exceljs-scripttag
  in pagina's, test bewaakt dat), `origin()` = terugknop naar de herkomst
  (referrer), `onReturn()` = herladen na bfcache. Bestanden met `?v=<versie>`
  krijgen `private, max-age=31536000, immutable` (`staticHeaders`). Startpagina:
  server zet `<meta name="aquatech-start">` op het dashboard (`startPageOf`).
  Links naar een item altijd direct (`?id=`), nooit via een overzicht.
- **Queries** (0.47.0): per verzoek één query voor sessie+gebruiker+tenant
  (`store.findSessionWithUser`), tenant per verzoek onthouden
  (`withRequestCache`, AsyncLocalStorage), statische bestanden 30 s zonder
  sessiequery (`auth.isAuthenticatedForAsset`). Geen `SELECT *` als grote
  kolommen niet nodig zijn; overzichten via `jsonDigest` (db.js); geen query
  per regel. `test/queries.test.js` bewaakt dat.
- **Nieuws** (0.51.0, `frontend/nieuws/`, voor iedereen): berichten (tabel
  `news`, migratie 19, `backend/src/platform/news.js`, recht `nieuws` = plaatsen,
  doelgroep `medewerkers`|`iedereen`, optioneel mail naar collega's) en het
  versielogboek in gewone taal `frontend/nieuws/releases.js` (punten met
  `for: [rechten]`). **Het Nieuws-deel van het fragment in `changes/` komt bij de release bovenaan releases.js**
  (test eist dat). `api/me` geeft `news` (aantal nieuw, cache 30 s);
  gezien-stand in voorkeuren `newsSeenAt`/`seenRelease` (`POST /api/news/seen`).
- **Offline/PWA** (0.58.0): `frontend/sw.js` (geregistreerd door
  `shared/common.js`, ook manifest), regels in `shared/offline-core.js`
  (UMD, getest), pagina-API + paneel `shared/offline.js|.css`. Gegevens alleen
  voor de lijst `CACHEABLE` en een eigen account met `werkorders`; gewist bij
  uitloggen/andere gebruiker. **Schrijfactie offline-geschikt maken**: kop via
  `AquatechOffline.headers({ key, label, base, patch })`, 202 `{ queued }`
  afhandelen; server: `Idempotency-Key` werkt generiek (`idempotency.js`),
  conflictcontrole met `ifBaseOf(req)` → 409 `conflict`. Nieuwe GET die offline
  moet werken: in `CACHEABLE`. Nieuwe pagina offline: `PRECACHE_PAGES` in sw.js.
  Nieuwe schrijfactie in de wachtrij: ook in `QUEUEABLE` (offline-core). Een
  verzonden item draagt `X-Aquatech-Owner` (`<user>@<tenant>`, `AquatechCommon.ownerOf`);
  de server weigert een andere eigenaar (409 `owner_mismatch`, 0.69.0).
  Lokaal bewaarde gegevens (planner-concept, terugval-wachtrij) bewaren hun
  eigenaar en worden alleen aan die gebruiker getoond/verstuurd.
- **Foutmeldingen + debugmodus** (1.8.5, `platform/error-report.js`): elke 500 krijgt een foutcode (`errorId`, ook in het log
  `[fout <code>]`). Instelling `debugMode` (per omgeving, Beheer > Instellingen > Foutopsporing): aan + recht `beheer` → foutantwoorden
  (400+) krijgen `debug` (oorzaak, databasecode, plek in `src/`, aanroepketen; geheimen via `redact` eruit) en kop
  `X-Aquatech-Debug`; `shared/common.js` toont dan `shared/debug-panel.js`. `catchAsync` op app en webshoprouter: async routes
  hoeven geen eigen `wrapAsync` meer. **Een eigen foutantwoord na een `catch` bewaart de oorzaak met `withCause(res, error)`**;
  zet nooit `error.message` van een interne fout rechtstreeks in `message` (alleen bij bewust leesbare fouten, zoals SMTP).
  Webshopfouten (1.8.6): `respondShopError(res, error, next)` uit woocommerce.js (`SourceError` = leesbaar, met `cause`; rest → 500).
  Frontend (1.8.9): een terugvalmelding bij een status zonder `message` altijd via `AquatechCommon.statusMessage(status)`, nooit `HTTP ${status}` (test bewaakt dat); een netwerkfout geeft de fetch-hulp in common.js al een leesbare melding.
  Mailfouten (1.8.7): melding altijd via `mailFailure(error)` uit mailer.js (+ `withCause`), nooit `error.message` van nodemailer.
  Webshop (1.9.0): `MollieError` (leesbaar, met `cause`); bij facturen voor webshopbestellingen alleen een `InvoiceStepError` letterlijk bij de bestelling, andere fouten → log + "interne fout"; een foutuitkomst die als JSON naar de browser kan gaan krijgt de oorzaak niet-opsombaar (`withHiddenCause` uit error-report.js).
  Een nieuwe leesbare fout met een onderliggende oorzaak: `new Error(melding, { cause: error })` of `new SourceError(…, status, error)`.
- **AI-koppeling / MCP-server** (1.10.1, `backend/src/mcp/`, migratie 57 `oauth_grants`): `POST /app/mcp` (stateless, JSON,
  `mcp-server.js`), tools in `mcp-tools.js` (`zoek_klant`, `maak_klant`, `zoek_artikelen`, `maak_concept_offerte`: alleen concept,
  prijzen uit de voorraad, twijfel als `line.note` die `forCustomer` weglaat). OAuth 2.1 in `oauth-server.js` (metadata, registratie
  met ondertekende client-id, `/oauth/authorize|token|revoke`, toestemmingsscherm `paginas/koppelen.html`) en `oauth-grants.js`
  (tokens `aqt_<soort>_<tenant>.<geheim>`, alleen SHA-256, rotatie). Instelling `aiConnector` per omgeving; `userForGrant` in
  server.js controleert elk verzoek opnieuw (account, wachtwoord-vingerafdruk, omgeving, koppeling aan, geen klant: alleen intern, wens Daniël). **Een nieuwe tool** krijgt
  een scope in `SCOPES` (met de rechten van de rol), een limiet en audit bij schrijven, en schrijft hoogstens een concept.
  Leesfuncties (1.10.7, `mcp/mcp-lookups.js`, geen migratie): `klant_details`, `prijs_voor_klant` (`webOrders.priceCart` met de klantgroep; scope is een lijst, alle nodig), `status_opvragen` (per soort het recht van de module, `DOCUMENT_RIGHTS`) en `openstaande_debiteuren` (scope `facturen.lezen`). Een leestool geeft geen interne velden (`note`, `internalNote`, kostprijs) en toont per onderdeel alleen wat de rol mag.
- Health: `GET /api/health` (versie uit `package.json`).

## Checklist voor elke nieuwe feature (zonder dat Daniël erom vraagt)

Database-, navigatie- en beveiligingsregels (PR #45, #46, #47) gelden
standaard voor alle nieuwe code. Controleer ze zelf vóór de PR en noem in
de PR-beschrijving kort hoe eraan voldaan is.

**Documentatie**: `README.md` (root) bijwerken als de PR features, modules, instellingen, installatie of het
reviewproces wijzigt; een fragment `changes/<naam>.md` (notes voor CHANGELOG en Nieuws) bij elke wijziging in
`beregeningsplanner/`.

**Queries** (productie = Supabase over het netwerk, elke query is een rondgang):
- Geen `SELECT *`/`t.*`: alleen de kolommen die nodig zijn; grote kolommen
  (`data`, beelden, blobs) niet in overzichten, gebruik `jsonDigest`.
- Geen query per regel (N+1): één query met `IN (...)`/JOIN of een map vooraf.
- Een paar rijen ophalen (winkelwagen, één artikel)? Dan geen `LEFT JOIN (SELECT … GROUP BY)` over
  de hele omgeving, maar per rij via de index (bijv. `(SELECT SUM(r.qty) FROM stock_reservations r
  WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id)`); de groepering past bij hele lijsten (1.6.6).
- Een nieuwe `WHERE`/`ORDER BY` op een groeiende tabel krijgt een index met
  `tenant_id` vooraan (migratie in `MIGRATIONS` én `PG_MIGRATIONS`).
- Gebruiker/tenant per verzoek niet opnieuw opvragen (`req.user`,
  `withRequestCache`). Breid `test/queries.test.js` uit voor nieuwe routes.

**Uitlijning van schermen** (wens Daniël 2026-11-11, "dit moet de standaard zijn"): elke PR die een scherm raakt levert nette
uitlijning op: één raster, kaarten in een rij even hoog zonder lege gaten, formuliervelden op één lijn met het label boven het
veld en een korte hulptekst. Gebruik de gedeelde klassen in `frontend/shared/layout.css` (`.form-grid` met `.full`/`.span-2`/`.cols-4`,
`.card-grid` + `.card`, `.form-actions`), geen eigen marges per scherm. Controleer vóór de PR de uitlijning op 1440 en 375 px
(besluit Daniël 2026-11-11: geen schermafbeeldingen meer in de PR of de projectbestanden, dat kost te veel tokens; de uitlijning moet
wel logisch kloppen, controleer ze met de DOM/CSS of een gerichte meting in plaats van met beelden).

**Navigatie en laden** (frontend):
- Links naar een item direct (`?id=…`), nooit via een overzicht; terugknop
  via `origin()` uit `shared/common.js`.
- `api/me`/`api/config` alleen via `getJson` (één verzoek per pagina);
  onafhankelijke verzoeken parallel (`Promise.all`), het item zelf al
  ophalen terwijl de login-check loopt. Na terugkeer verversen met `onReturn()`.
- Scripts/CSS met `?v=<versie>`; zware bibliotheken pas laden bij gebruik
  (zoals `excel()`). Geen bevestigingsvraag als er niets verloren gaat.

**Beveiliging** (ASVS L2 + AVG):
- Tenant-isolatie: elke query filtert op `tenant_id = req.tenantId`
  (gebruikersbeheer via `homeOf`/`usersTenantOf`); id's uit de URL altijd
  samen met de tenant opzoeken, nooit alleen op id.
- Rechten op de server met `requireRight(recht)` (rechten in
  `shared/roles.js`, `Roles.can`); de frontend verbergt alleen. Klant ziet
  alleen eigen gegevens (`customer_id`), nooit uren/notities/interne velden.
- Limieten per bezoeker via `clientKey(req)` (auth.js: IPv4-adres of
  IPv6-/64, op basis van `remoteIp`/CF-Connecting-IP achter de tunnel; 1.6.5)
  en `createRateLimiter`; elk openbaar of duur endpoint krijgt er één.
  `remoteIp` alleen voor het auditlog/opslaan van het adres.
- Uitgaande verbindingen naar door een tenant ingevulde hosts altijd via
  `netguard.publicAddress` (geen SSRF naar het eigen netwerk).
- Schrijvende `/api`-verzoeken: de `Sec-Fetch-Site`-controle niet omzeilen;
  nieuwe body-routes krijgen een eigen `express.json({ limit })`.
- Uploads: type op inhoud controleren (niet op naam/MIME), grootte begrenzen,
  metadata strippen (`inspectImage` doet JPEG, PNG en WebP), opslaan via
  `vault.sealBytes`. Vaak opgevraagde afbeeldingen via
  `platform/image-cache.js` (wissen bij verwijderen). Openbare links: token alleen
  als SHA-256 opslaan, via een kop (niet in de URL-query) versturen.
- Geheimen als `type: 'secret'` in settings.js, nooit in logs, `audit`-detail
  of frontend. Invoer server-side saneren (`sanitize`), parameters altijd
  via `?`, nooit tekst in SQL plakken.
- Tests voor elke nieuwe route: andere tenant → 404, ontbrekend recht → 403.
- Een nieuwe query op een tabel met `tenant_id` filtert op `tenant_id`; `test/tenant-filter.test.js` faalt anders
  (echte uitzondering: reden in de PR en `node tools/tenant-filter.js --update`).
- Links naar de shop in mails en SEO altijd via `publicBaseUrl` (webadres uit Beheer), nooit uit `req.headers.host`.

## Codestijl (wens Daniël 2026-10-22, geldt voor alle code)

Daniël leest de code zelf na; hij moet zonder zoeken kunnen zien wat iets is.
`test/codestyle.test.js` (met `tools/codestyle.js`, `npm run codestyle`)
bewaakt de eerste twee regels voor elk eigen `.js`-bestand (backend `src/`,
`test/`, `tools/` en `frontend/`, zonder `vendor/`).

- **Duidelijke namen.** Variabelen, parameters en functies zeggen wat erin
  zit of wat ze doen: `row`, `workOrder`, `tenantId`, `formatPrice`, niet
  `r`, `wo`, `t`, `fmt`. Geen namen van één letter, behalve `i`/`j` als
  teller, `x`/`y` als coördinaat, `_` voor een ongebruikte parameter en `$`
  als querySelector-hulp. Ook geen cryptische afkortingen (`q`, `tx`, `el`,
  `cb`, `tmp`, `str`); gangbare termen mogen (`req`/`res` in Express, `id`,
  `url`, `db`, `pdf`). Sorteerfuncties: `(left, right) =>`. Fouten:
  `catch (error)`. Namespaces/modules (`App`, `Catalog`, `Core`, `Roles`)
  blijven zoals ze zijn.
- **Elke functie een commentaarblok** (`/** ... */`, in het Nederlands) direct
  erboven: wat de functie doet (één of twee zinnen), per parameter
  `@param {type} naam uitleg` en `@returns {type} uitleg` als er iets
  terugkomt. Geldt voor function-declaraties, `const naam = (…) => …`,
  methoden en functies in een toegewezen/teruggegeven object; losse
  callbacks als argument (`.map((row) => …)`, `addEventListener`) en korte
  functies in een object op één regel niet.
  Een bestand begint met een kort kopcommentaar: wat erin staat.
- **Mappenstructuur**: één map per module onder `frontend/`, gedeelde code in
  `frontend/shared/`. Backend per onderwerp onder `backend/src/`: `database/`,
  `beveiliging/`, `platform/` (store, instellingen, rollen, mail, nieuws),
  `beregening/`, `verkoop/`, `webshop/`, `uitvoering/`, `artikelen/`,
  `paginas/` (HTML die de server vult); in de root van `src/` alleen de
  opdrachten `server.js`, `backup.js`, `migrate-to-postgres.js` en `paths.js`
  (`FRONTEND_DIR`, `PAGES_DIR`: nooit zelf `'..'` tellen naar de frontend).
  Bestandsnamen in kebab-case (`invoice-pdf.js`). Een nieuw backendbestand
  hoort in de map van zijn onderwerp; een nieuw onderwerp krijgt een eigen map.
  Geen losse bestanden (screenshots, exports) in de root van de repo; die
  horen in de projectbestanden.
- `tools/codestyle-baseline.json` somt de bestanden op die nog niet zijn
  opgeschoond; die lijst wordt alleen korter. Een nieuw bestand moet meteen
  voldoen. Raak je een bestand uit de lijst flink aan, schoon het dan op en
  haal het eraf.
- Opschonen verandert nooit het gedrag: alleen namen en commentaar.
- Tests: gedeelde hulpcode in `backend/test/helpers/` (`http-client.js`:
  `createClient`, `listen(app)` → `{ server, base }`, `createLogin(base,
  { password })` → `as(username, org)`; `png.js`). Geen eigen kopie van
  een testclient of serverstart in een testbestand. Alle tests voldoen
  sinds 0.68.4 aan de codestijl.

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
- **Geen `SELECT *` of `t.*`** in de backend; `test/queries.test.js` controleert dat.
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
