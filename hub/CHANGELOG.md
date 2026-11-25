# Changelog

## 1.40.5

Stagingbalk, noindex-modus voor staging en het Dockerfile-argument voor Vue-modules verwijderd; de stagingomgeving bestaat niet meer.

## 1.40.4

De stagingomgeving op apps01 is niet meer nodig en wordt verwijderd. Nieuw: servertaak `016-staging-verwijderen` (`deploy/apps01/remove-staging.sh`) ruimt de timer, units, de twee stagingcontainers, hun netwerk, de lokaal gebouwde images en `/opt/apps/aquatech-staging` op, zonder de testomgeving of de tunnel aan te raken. Weg uit de repo: `deploy/staging/`, `docs/STAGING.md` en hun test; de servertaken 012, 014 en 015 doen niets meer (de id's blijven). De stagingbalk/noindex-code en het Dockerfile-argument `VUE_MODULES` blijven bestaan.

## 1.40.3

`install-staging.sh` slaat een eerder mislukte commit alleen nog over bij `--timer`; een handmatige run (servertaak) probeert hem opnieuw. Taak 014 deed daardoor niets. Nieuwe servertaak 015 voert de herinrichting alsnog uit.

## 1.40.2

De stagingservice heette `aquatech`; Docker zet de servicenaam ook als netwerkalias in het gedeelde tunnelnetwerk, waardoor verkeer naar `http://aquatech:3300` (testomgeving) deels bij de stagingcontainer uitkwam. De services heten nu `aquatech-staging-app` en `aquatech-staging-db`; `install-staging.sh` ruimt containers onder de oude servicenaam op (`retire_old_service`) en een test bewaakt dat elke servicenaam met `aquatech-staging-` begint. Nieuwe servertaak 014 past dit op apps01 toe.

## 1.40.1

Servertaak 013 (schijf van apps01 vergroten) draait nu vóór 012 (stagingomgeving inrichten). Staging eist ruim 6 GB vrije ruimte en faalde daardoor op een bijna volle schijf, waarna taak 013 nooit werd uitgevoerd. Alleen de volgorde in `HOST_TASKS` en `HOST_TASK_IDS` is gewisseld; de id's veranderen niet.

## 1.40.0

Servertaak 013 (`013-schijf-apps01-vergroten`, `deploy/apps01/grow-disk.sh`): laat de VM na het vergroten van de virtuele schijf in Proxmox de nieuwe grootte inlezen en vergroot partitie (growpart), bij LVM ook de physical volume en logical volume, en het bestandssysteem (ext4, xfs, btrfs). Idempotent, zonder herstart. De bewakingscontrole *Vrije schijfruimte* leest de grootte bij elke ronde live uit (`statfs`), zonder cache; de nieuwe grootte zichtbaar maken in de app volgt als daar behoefte aan is.

## 1.39.9

- Staging: de app verbindt met `aquatech-staging-postgres` in plaats van `postgres` (die naam heeft in het tunnelnetwerk ook de database van de testomgeving). Na een mislukte build staat ook de bron in `repo/` weer op de draaiende commit.
- `install-staging.sh` en `docs/STAGING.md`: eerst Cloudflare Access instellen en dan pas de hostnaam publiceren; paragraaf "Vertrouwen en grenzen".

## 1.39.8

- De stagingomgeving is een tweede opstelling op apps01 naast de testomgeving (`deploy/staging/`): eigen compose-project, image (op de server gebouwd), database, geheimen en mappen; alleen de server en de bestaande tunnel zijn gedeeld. `install-staging.sh` richt in én werkt bij (volgt `develop`, terugval bij een mislukte commit, verzonnen testdata, timer elke 15 minuten); servertaak `012-staging-op-apps01-inrichten` (vervangt de eerdere stg01-taak) draait het op een vaste commit.
- Vervallen: de VM stg01, de Cloudflare-API-stappen, Mailpit, de systemd-units `aquatech-stg-update.*` en de workflow `staging.yml` (er gaat geen staging-image meer naar GHCR).

## 1.39.7

- Met `AQUATECH_STAGING=1` krijgt elk antwoord `X-Robots-Tag: noindex, nofollow, noarchive` en de kop `X-Aquatech-Staging`; `shared/common.js` toont dan een vaste balk "STAGING" (stijl in `brand.css`). Zonder de schakelaar verandert er niets.
- Dockerfile: bouwargument `VUE_MODULES` (standaard leeg; het productie-image blijft gelijk). Gevuld faalt het nog duidelijk, tot de eerste Vue-module de bouwstap toevoegt.

## 1.39.6

Servertaak `012-staging-stg01-inrichten`: maakt vanaf de Proxmox-host de aparte VM stg01 aan, regelt via de Cloudflare-API de tunnel `aquatech-staging`, DNS en Access (alleen één e-mailadres) voor `aquatech-staging.den-hollander.com` en richt Docker, eigen PostgreSQL, Mailpit en de update-timer in via `deploy/staging/`. Taken die op de Proxmox-host zelf draaien kennen nu een eigen lijst (`HOST_SIDE_TASK_IDS` in `servertaken.sh`, opdrachten `openstaand-lijst` en `taak-vastleggen` op apps01); zonder Cloudflare API-token blijft de taak openstaan. Het stagingscript rolt alleen `ghcr.io/danieldh00/aquatech-staging` uit, nooit het productie-image. Zie `docs/STAGING.md`.

## 1.39.5

- `data.deposit` {on, type pct|amount, pct, amount} op de offerte (`QuoteCore.sanitizeDeposit/depositOf/depositSplit`: het bedrag is incl. btw en wordt over de btw-tarieven verdeeld). Op het klantdocument staat één kader *Betaling* (`quote.deposit*` in `doc-text.js`, nl en en).
- Aanbetalingsfactuur (`verkoop/deposit-invoices.js`): een gewone factuur met `data.deposit` {quoteId, quoteNumber, amount}; per offerte één (migratie 98: unieke index op `(tenant_id, quote_id)` voor niet-gecrediteerde facturen met dat kenmerk). Bij akkoord (`onAccepted` in server.js, naast de automatische werkorder) definitief maken en versturen met de betaallink; routes `GET|POST /api/quotes/:id/deposit-invoice` (recht `facturen`). Instelling `depositInvoice` {enabled} (standaard aan), module `aanbetaling-automatisch`.
- Eindfactuur: `InvoiceCore.fromWorkOrder` krijgt `deposits` en trekt per btw-tarief een negatieve regel (`deposit: true`, buiten de korting; `InvoiceCore.totals` rekent de korting alleen over de gewone regels) af; een nog niet definitieve aanbetaling geeft een waarschuwing.
- Openstaande taak *Aanbetalingsfacturen versturen* (`invoices.unsentDeposits`).

## 1.39.4

V-04 beschikbaarheid: `plan-runner.js` kent twee rijen (`main`: 2 tegelijk, 20 wachtend voor de AI-koppeling; `lead`: 1 tegelijk, 5 wachtend voor openbare tekeningen), `runPlanTask(methode, args, rij)`. `planWithinLimits` (plan-builder.js) weigert vóór het rekenen een plan met te veel vlakken, hoekpunten, elementen of vreemde coördinaten (de tekening komt wel binnen, zonder concept-offerte). Tests: `plan-builder.test.js`.

## 1.39.3

Openbare planner als verkoopkanaal (V-04), deel 2: server.js sluit `plannerCatalogOf` aan bij `registerDrawingRoutes` (`ordering` alleen voor de hoofdtenant met `storefront` en `shopOrdering` aan) en `createLeadQuote`: bij `POST /api/public/drawing` maakt de server met `quoteLinesFromPlan` (zelfde werkthread als de AI-koppeling) een conceptofferte, eigenaar is het gastaccount van de indiener (`submitDrawing` geeft nu `ownerId` terug), zonder klantrecord, met de contactgegevens in `customer` en een interne notitie. Alleen met de module Offertes aan; een fout of een plan zonder regels laat het indienen zelf slagen. Auditregel `tekening_ingediend` bevat `quoteId`, de melding aan het bedrijf noemt het offertenummer. Tests: `public-planner-lead.test.js`.

## 1.39.2

Werkorder automatisch klaarzetten bij akkoord (V-01). Na een akkoord (medewerker via status, klant via het portaal of de openbare link) maakt `workorders.createForAcceptedQuote` één werkorder met status `open` (zonder planning of uitvoerder, eigenaar = eigenaar van de offerte); daarna reserveert `stock.onWorkOrderChange` het materiaal en schrijft het auditlog `werkorder_automatisch_aangemaakt`. Er komt nooit een tweede werkorder als er al een van de offerte is; een fout laat het akkoord staan. Nieuwe instelling `autoWorkOrder` {enabled} (standaard aan, per omgeving) als schakelaar `werkorder-automatisch` bij Beheer > Modules (onderdeel van Werkorders). Nieuwe taak *Werkorders in te plannen* in `GET /api/tasks` (recht `planning`, module Planning aan; `workorders.listToSchedule`). De handmatige knop *Werkorder maken* blijft. Tests: `auto-work-order.test.js`.

## 1.39.1

- Een prijslijst inlezen voor een gearchiveerde leverancier wordt geweigerd (409 `supplier_archived`).
- Per regel worden koppeling en inkoopprijs samen of niet verwerkt (één transactie, `nested`-opties op `setForItem` en `addCostPrice`); de bestaande koppelingen komen uit één query in `priceListContext`.

## 1.39.0

Prijslijst van de leverancier inlezen (V-30), gebouwd op het importvenster van V-05.
- `POST /api/stock/price-lists/:supplierId` (+ `GET …/fields`, recht `voorraad`, `artikelen/supplier-price-list.js`): artikelen worden herkend op het artikelnummer van de leverancier, anders EAN, anders eigen code (tegenstrijdig = fout). Statussen nieuw (koppeling erbij), wijzigt, ongewijzigd, onbekend (overgeslagen) en fout; hoogstens 2000 regels.
- Prijs, bestelhoeveelheid en levertijd komen op de koppeling. Alleen bij de voorkeursleverancier (of een artikel zonder leverancier) wordt het ook de inkoopprijs van het artikel (`stock.addCostPrice`, historie, `repriceItem` volgt de prijsfactor); een backup-leverancier verandert nooit de prijs van het artikel.
- `suppliers.priceListContext` (twee queries) voor de koppelingen; `readTable` kent nu `maxRows`; audit `leverancier_prijslijst_ingelezen`.

## 1.38.0

Import uit Excel (V-05) voor klanten en artikelen. Het bestand wordt in de browser gelezen (ExcelJS, `shared/excel-import.js`) en als kopregel + rijen naar de server gestuurd; de server controleert en schrijft niets bij de controle.
- `platform/excel-import.js`: gedeelde kern (kolomkoppen herkennen met synoniemen, Nederlandse getallen, grenzen: 1000 rijen, 40 kolommen).
- `POST /api/customers/import` (+ `GET …/fields`, recht `klanten`): herkennen op e-mail, anders naam; adres bij PDOK (`addressGuard`); zakelijk en bedrijfsgegevens alleen met recht `beheer`; audit `klanten_geimporteerd`; hoogstens 500 klanten, 30 verzoeken per uur.
- `POST /api/stock/import-excel` (+ `GET …/fields`, recht `voorraad`): herkennen op artikelcode, `stock.create`/`stock.update` (EAN, inkoopprijshistorie, prijsfactor), beginvoorraad alleen bij nieuwe artikelen; audit `voorraad_artikelen_geimporteerd`.
- Verwerken is alles of niets op de controle: met fouten alleen met `skipErrors`.
- `server.js`: één regel, JSON-limiet 256 kB voor `/api/customers/import`.

## 1.37.3

Marge in de offerte-editor (V-02). `QuoteCore.margin` rekent per regel en in totaal (na korting) over de regels met een bekende kostprijs: materiaal met artikelcode en inkoopprijs, arbeid in uren met de kostprijs per uur uit de bedrijfsgegevens. Regels zonder kostprijs tellen niet mee en worden gemeld. Nieuwe route `GET /api/quote-costs?codes=` (recht `nacalculatie`, hoogstens 300 codes, alleen de eigen voorraad) die de inkoopprijzen geeft; valt onder de module Nacalculatie (uit = 409). Nieuw profielveld `minMarginPct` (intern, 0 = geen waarschuwing, hoogstens 99) bij Offertes > Bedrijfsgegevens. De kaart en de regelmarges zitten alleen in de editor (`offertes-margin.js`), niet in document, PDF, mail of openbare link. Tests: `quote-margin.test.js`.

## 1.37.2

Openbare planner als verkoopkanaal (V-04), deel 1. Nieuwe route `GET /api/public/planner-catalog` (drawings.js; zelfde organisatie, instelling en limiet als tekening indienen) met assortiment en consumentenprijzen uit `registerShopRoutes().publicCatalogOf` (alleen naam, prijs excl. btw, btw-tarief en voorraad). De planner (`shopcatalog.js` `loadPublic`, `app.js` `_publicPriceCard`) toont in stap 6 het totaal incl. btw, de knop *Materiaal bestellen* (bestaand `/winkelwagen/planner`, alleen als bestellen bij de hoofdtenant aan staat) en *Offerte voor aanleg aanvragen* (indienformulier). Tot de route in server.js is aangesloten (`plannerCatalogOf` bij `registerDrawingRoutes`) geeft hij `enabled: false` en blijft de planner zoals hij was. De concept-offerte bij een ingediende tekening volgt apart.

## 1.37.1

Audit 1.33.0, thema Accounts en toegang, deel 3.
- **B-26**: de ruime JSON-limieten (>= 512 kB) staan achter `gatedJson`: wie geen sessie heeft (en als gasten uit staan) krijgt de standaardlimiet van 16 kB, zodat een anonieme bezoeker de server niet herhaald megabytes laat inlezen. Openbare routes (`/api/public/*`) houden hun eigen limiet.
- **B-21**: inloggen met de toegangscode telt mislukte pogingen per bezoeker (10), voor alle bezoekers samen (30) en kent daarboven een kleine gedeelde extra ruimte (20) voor bezoekers zonder eigen mislukte poging: een juiste code komt dan nog binnen, maar er zijn per kwartier hoogstens 50 gokken mogelijk, ook vanaf veel adressen.
- **T-14**: `platform/process-guard.js`: `unhandledRejection` wordt gelogd (console + applicatielogboek, bron `proces`) en geteld voor Bewaking; `uncaughtException` doet hetzelfde en stopt het proces gecontroleerd (logboek wegschrijven, server sluiten, exit 1).
- **B-18**: `POST /api/plan/learn` met een `recognitionId` telt alleen mee voor de gebruiker die de herkenning liet doen, en de som van alle tellingen is begrensd op 1.000.000 (het aantal pixels van de werkresolutie).
- Tests: `process-guard.test.js`, `hardening.test.js`, `plan.test.js`.

## 1.37.0

Audit 1.33.0, thema Accounts en toegang, deel 2.
- **B-20**: de routes voor wachtwoord, profiel en 2FA eisen `identify(req)`; een gebruiker van een uitgeschakelde organisatie krijgt 401 `not_logged_in`.
- **B-35**: `POST /api/account/totp/setup` vraagt het huidige wachtwoord (fout = 400 `wrong_password`, telt mee in de pogingenblokkade); profielscherm heeft een wachtwoordveld.
- **B-22**: `settings.view()` slaat velden met `internal` of `platform` over; `GET /api/admin/settings` toont ze niet meer (eigen schermen en API's blijven).
- **B-34**: `guardedWipe` geeft een vaste melding; de databasefout is een verborgen `cause` die `platformError` via `withCause` aan de debugmodus geeft.
- Tests: `two-factor.test.js`, `settings.test.js`, `tenants-delete.test.js`.

## 1.36.9

Audit 1.33.0, thema Accounts en toegang, deel 1.
- **B-08**: schrijfroutes van het klantportaal (`/api/portal/requests` aanmaken, foto's toevoegen/verwijderen, intrekken; afspraak bevestigen; factuur betalen/controleren) geven voor een gast 403 `account_required` (`requireAccount` in `service-requests.js` en `portal.js`). Lezen blijft werken.
- **T-11**: het uurlijkse onderhoud ruimt gasten op die 30 dagen niet zijn gezien en geen plan of andere verwijzing hebben (`store.purgeStaleGuests`, hoogstens 200 per ronde; een verwijzing elders laat de gast staan).
- Test: `test/guest-hardening.test.js`.

## 1.36.8

Auditthema 4 (1.33.0), T-05:
- Nieuw `platform/list-paging.js`: harde bovengrens (`LIST_LIMIT` 2000), `?limit` en `?offset`, antwoord met `total` en `truncated`.
- `GET /api/quotes` en `GET /api/workorders` lezen een pagina (`listPage`, telquery alleen als de pagina vol is of niet vooraan begint); de klantlijsten in het portaal hebben dezelfde bovengrens.
- `GET /api/invoices` meldt `total` en `truncated` bij de bestaande grens van 1000 (voorheen stil afgekapt).
- `AquatechCommon.truncationNotice` toont kort een melding in de lijsten van offertes, werkorders en facturen als de lijst is ingekort.
- Bewust niet gedaan: `location_key` en `name_key` als kolom met index voor de dossiers; de sleutel is een hash van een in JavaScript genormaliseerd adres of naam, wat een migratie (alleen SQL) niet kan vullen zonder het gedrag te veranderen. De dossierquery's lezen alleen id en adres/naam (geen data), dus de kosten blijven klein.
- Test: `test/list-paging.test.js`.

## 1.36.7

Auditthema 4 (1.33.0), eerste deel:
- **B-09**: de klantweergave van een offerte (portaal, openbare link) geeft `version` mee (SHA-256 over nummer en gegevens zonder interne notities, vóór de optiekeuze); het akkoord stuurt hem terug en `decide` weigert met 409 `changed` bij een verschil. Afwijzen heeft de controle niet nodig.
- **B-24**: klant en openbare link krijgen van het bedrijfsprofiel alleen de documentgegevens (`CUSTOMER_PROFILE_FIELDS`); opslag, tarieven en voorrijkosten blijven intern.
- **B-25**: `owner` (id en inlognaam van de medewerker) ontbreekt in alle klantweergaven van een offerte.
- **B-23**: klant- en installatiedossier tonen offertes (met totaal) alleen met het recht `offertes`.
- **B-32**: `PUT /api/workorders/:id` zonder recht `planning` laat datum, tijden, werkdagen en uitvoerder ongemoeid (`keepPlanning`).
- **T-12**: eigen bodygrens van 128 kB voor `/api/quote-templates` en `/api/quote-profile`.
- **T-13**: een mislukte mail zet een concept-offerte terug (`restoreDraft`) en trekt een alleen daarvoor gemaakte afspraaklink in.
- **B-12 (vervolg)**: test dat de openbare offerte- en afspraaklinks binnen de organisatie van de gevonden rij schrijven.
- Tests: `test/audit-quotes-workorders.test.js`; bestaande akkoordtests sturen `version` mee.

## 1.36.6

Auditthema 3 (AI en mail, audit 1.33.0):
- **B-04**: `createMailer` weigert `mode: 'connector'` buiten de hoofdtenant (`settings.isMainTenant`, `connector_not_allowed`; ook bij opslaan via `PUT /api/admin/mail`), dagplafond van 1000 berichten per organisatie (`DAILY_MAIL_LIMIT`, in het geheugen, mislukte poging telt niet mee) en een limiet van 5 testmails per 10 minuten per organisatie.
- **B-36 en T-22**: nieuwe instelling `appPublicUrl` (`platform/app-address.js`, env `APP_PUBLIC_URL` als startwaarde; terugval op `shopPayment.publicUrl`). `pinShareBase` neemt de herkomst van offerte- en afspraaklinks nooit meer uit de browser: zonder openbaar adres geeft delen 409 `public_url_missing` (alleen een localhost-adres blijft toegestaan voor ontwikkeling). Het OAuth-adres van de AI-koppeling en de Bewaking-link gebruiken dezelfde instelling.
- **B-14**: een batch heeft hoogstens 5 berichten (was 20), elk bericht telt voor de limiet per koppeling, `zoek_klant` en `zoek_artikelen` hebben een eigen limiet (120 per uur), de klantlimiet van `maak_klant` staat vóór de adresopvraging en er is een limiet per bezoeker vóór de tokencontrole.
- **B-15**: de instructies en elke toolomschrijving zeggen dat veldinhoud gegevens zijn en nooit opdrachten; `boek_uren` en `boek_materiaal` zijn als ingrijpend gemarkeerd (`destructiveHint`) zodat de AI-app om bevestiging vraagt.
- **T-21**: de dagelijkse AI-teller en het dagmaximum horen bij de omgeving die de AI-sleutel levert (`aiTenantOf`): een testomgeving zonder eigen sleutel verbruikt geen extra tegoed.

## 1.36.5

Audit 1.33.0, thema Back-up/herstel:
- B-01: een back-up wordt in één stroom gecomprimeerd en versleuteld (geen onversleutelde `.tmp-*.db` meer); het ontsleutelde tussenbestand van terugzetten wordt direct na het inlezen gewist; het uurlijkse onderhoud (en de start) wist resten ouder dan een uur (`backup.js` `sweepLeftovers`) en tijdelijke schema's `aqt_scratch_*` (`pgdb.js` `dropStaleScratch`, aanmaaktijd in de schemanaam).
- B-17: `platform/identity-confirm.js` (herbevestiging, gedeeld met terugzetten) voor back-up verwijderen, Drive verbreken/koppelen en de Drive-kopie uitzetten; de nieuwste back-up is niet handmatig te wissen; Bewaking-controle `backup-verwijderd` (24 uur, uit het auditlog); frontend `beheer/reauth.js`.
- B-27: Bewaking-controle `tenantafscherming` (fout bij multitenancy, anders waarschuwing).
- T-09: `platform/backup-open-cache.js` bewaart een geopende back-up vijf minuten (teller, verlooptijd, opruimen).

## 1.36.4

`beheer/indeling.js`: openklappen van een groep sluit de andere; alleen de laatst geopende groep wordt onthouden (oudere bewaarde keuzes met meerdere groepen tonen alleen de eerste).

## 1.36.3

- Schakelaars `visma` (heeft Facturen nodig; adressen `/api/visma/**` dicht, niet meer automatisch doorsturen), `dashboard-cijfers` (`/api/kpis`, instelling `dashboardKpis`), `dashboard-taken` (`/api/tasks`, blok en bel) en `webshop-voorraadmelding` (formulier op de productpagina en de mails).
- De winkel krijgt `featureOn(id)` mee van de server.
- Een bladwijzer naar een tabblad van Artikelen waarvan het onderdeel uit staat (zoals Telling) opent dat tabblad niet meer.

## 1.36.2

- Schakelaars `etiketten`, `voorraadtelling` en `inkoop-inlezen` (onderdelen van de module voorraad) en een eigen schakelaar voor `ontvangst`; de adressen van een uitgezet onderdeel geven 409 `module_off`.
- `data-feature="<id>"` op een element verbergt het als de module of het onderdeel uit staat (`applyFeatures` in dashboard/modules.js, aangeroepen door de zijbalk).

## 1.36.1

Onderdelen met een eigen schakelaar voor Verkoop, Planner en werk en Klantcontact (geen migratie).
- Register: `configuration.blocked` (patronen met `*` voor één deel van het pad): staat het onderdeel zelf uit, dan geeft de server op die adressen 409 `module_off`, ook bij lezen (staat alleen de module erboven uit, dan geldt haar bestaande regel: schrijven dicht, lezen blijft) (`blockedRoutes`, `matchesRoute`; middleware in server.js, hoofdletters en een slash aan het eind tellen mee). `configuration` geldt nu ook voor regels in `FEATURES`.
- Nieuwe schakelaars: `nacalculatie` (kaart, nodig: werkorders), `offertesjablonen`, `factuur-online-betalen` (`invoicePayments.enabled` via `switchedOn`: geen knop Nu betalen, geen betaallink in de mail; lopende betalingen en de webhook blijven werken), `plan-herkennen-ai` (`aiAvailable`, de planner valt terug op lokale herkenning), `afspraaklink` (maken en versturen dicht; een al verstuurde link blijft voor de klant werken en is nog in te trekken) en `installatiedossier`.
- Frontend: `AquatechModuleTools.featureOn(id)` (via het gedeelde `api/config`); de werkorder verbergt Nacalculatie en het blok Afspraak, de offerte de sjabloonkaart, het portaal de installaties per adres.
- Testsuite: een nieuw testschema is een kopie van één gemigreerd sjabloonschema in plaats van elke keer alle migraties (`database/test-template.js`); de suite loopt daardoor ruim binnen de tijdslimiet van CI. `test/test-template.test.js` bewaakt dat de kopie exact gelijk is aan een echt gemigreerd schema. De app zelf migreert zoals altijd.

## 1.36.0

Scherm Beheer > Modules (`frontend/beheer/modules.js`, eigen paneel `tab-modules`, stijl `.md-*` in beheer.css; geen migratie).
- Tekent de indeling uit `switchTree()` en leest en schrijft via `GET|PUT /api/admin/modules`; alleen gewijzigde schakelaars gaan mee. Zoekveld, filter Alles/Aan/Uit, teller, snelkeuze per categorie, Alles aan/uit per categorie, blok Altijd aan.
- Schakelaars zijn echte checkboxen met `role="switch"` (toetsenbord en schermlezer), tikdoel 40 px; op slot (webshop buiten de hoofdorganisatie, uitbesteden zonder multitenancy) met de reden erbij.
- Register: `section` (link Instellen naar de sectie van Beheer) en `switchTitle` (naam op de kaart).
- `AquatechNav.setDisabled(flags)` in `shared/sidebar.js`: de zijbalk volgt direct na het opslaan.
- Het oude formulier `s-modules` is weg.

## 1.35.1

Voorbereiding voor het nieuwe scherm Beheer > Modules (geen migratie).
- `frontend/dashboard/modules.js`: categorieën (`CATEGORIES`), de lijst Altijd aan (`ALWAYS_ON`) en schakelaars zonder eigen pagina (`FEATURES`). Een module krijgt `category` + `summary`; een onderdeel met een eigen schakelaar is een module met `partOf` + `ownSwitch` of een regel in `FEATURES`. `needs` = werkt alleen als die module aan staat. Nieuwe hulpfuncties `switchTree`, `switchIds`, `entryOf`, `titleOf`; `isOn` volgt nu ook `needs` en onderdelen van onderdelen.
- Een schakelaar met `setting` bedient een bestaande instelling (offerte-opvolging, betalingsherinneringen, tekening indienen, automatische bestelvoorstellen, de webshop met bestellen, gastbestellen, offerte aanvragen, planner, Google Analytics en Clarity, seizoensherinneringen, AI-koppeling): er blijft één waarheid.
- `platform/module-switches.js`: `flagsOf` (de vlaggen zoals ze gelden, ook in `GET /api/config`), `lockedOf` (uitbesteden zonder multitenancy, de webshop buiten de hoofdtenant) en `apply`. Routes `GET|PUT /api/admin/modules` (recht `beheer`, alles of niets, audit `modules_gewijzigd`; onbekende id 400, op slot 409 `module_locked`, onderdeel van een uitgezette module 409 `module_off`).
- Plannenoverzicht is een onderdeel van de Beregeningsplanner, Webshopbestellingen van de Webshop.

- Planner op een telefoon: de menuknop van de zijbalk is in de kopbalk even hoog als de andere knoppen (layoutcheck).

## 1.35.0

Layoutpunten L-04 t/m L-07 uit de layoutcheck: het winkelwagenpictogram staat als eigen bestand `assets/icon-winkelwagen.svg` (CSP `img-src 'self'` blokkeerde de data-URI), `.svg` is toegevoegd aan de shop-assets, knoppen erven het lettertype (`button { font-family: inherit }`), voorraadlabel op productkaarten minimaal 12 px, zoekknop 44 px breed en hoog op smalle schermen, en het inline `style` van het honeypotveld op Registreren en Planner is vervangen door de klasse `.trap`.

## 1.34.9

Planner (L-09): op schermen tot 760 px krijgen `.tbtn`, de ongedaan-maken/opnieuw-knoppen in de kopbalk en `.step`/`.step-nav .btn` een minimale hoogte van 40 px (voorheen alleen bij `pointer: coarse`); legendatitel van 10 naar 12 px.

## 1.34.8

Layoutcheck-bevindingen L-02, L-03, L-10, L-12 en L-13 (thema Beheer + app-shell mobiel):
- `beheer.css`: `.sc-block`, labels en keuzelijsten krimpen (min-width: 0), zodat de fieldsets op 375 px niet breder zijn dan het scherm; `.btn.small` (ook als `a`) is op smal scherm 40 px hoog.
- `dashboard.css`: organisatiewisselaar mag krimpen, gebruikersmenu en belknop niet; belknop 40x40 px.
- `brand.css`: scrollschaduw op `.tablewrap` onder 700 px; `sidebar.css`: nieuwsbadge 11 px.
- `profiel/ai-connections.js`: een klant vraagt de AI-koppelingen niet meer op (voorkomt een 403 in de console).

## 1.34.7

Audit 1.33.0, thema webshopbetalingen en facturen, deel 4 (bedrading in `server.js`). Geen migratie.

- **T-16**: de factuur- en de bevestigingsstap na een betaling hebben een sleutel (`factuur`, `bevestiging`); een mislukte stap wordt door `catchUpPaid` opnieuw geprobeerd. Een bevestigingsmail die niet verstuurd kon worden telt als mislukt (behalve zonder mailserver). Na de laatste poging: auditregel `webshop_betaalstap_mislukt`.
- **T-08, T-17**: `onLatePayment` schrijft `webshop_betaling_teruggestort`, mailt de klant (`sendLatePayment`) en werkt de melding `webshop-terugbetalen` in Bewaking bij (`webOrders.lateRefundsNeeded`; sluit vanzelf als er niets meer openstaat).
- **B-13**: `app.locals.webPaymentsRelease` loopt elke vijf minuten (niet tijdens onderhoud) en geeft de voorraad van onbetaalde online bestellingen vrij.
- **Betaling na creditering**: `invoicePayments.onPaidAfterCredit` → auditregel `factuur_betaald_na_creditering` en melding `factuurbetaling-na-creditering` in Bewaking.
- **T-03**: online factuurbetalen is hard beperkt tot de hoofdtenant (`mainTenantId` in `createInvoicePayments`): in een andere omgeving geen knop in het portaal, geen betaallink in de mail en geen betaling; de webhook en de betaallink zonder inlog kenden al alleen de hoofdtenant.
- **B-31, reviewpunt**: de uploadlimiet per bestelling voor de eigen pakbon telt per account (`pakbon-bestelling:<account>:<bestelling>`), zodat een ander account de limiet van de eigenaar niet kan opmaken.
- **Reviewpunt**: de bestelling onthoudt of de klant zijn bevestiging al heeft (`mail.customerSent`); mislukt alleen de melding aan het bedrijf, dan krijgt de klant bij de nieuwe poging geen tweede bevestiging.

## 1.34.6

Audit 1.33.0, thema webshopbetalingen en facturen, deel 3. Geen migratie.

- **T-19** (`web-orders.js` `attachToUser`, `storefront.js`): bij het koppelen van een gastbestelling aan een account gaan de retouren van die bestelling mee (één transactie). De intrekroute zoekt de retour via de toegang tot de bestelling (`orderAccessOf`); een retour zonder eigenaar van een al gekoppelde bestelling is daardoor ook in te trekken, een retour van een ander account niet.
- **B-31** (`order-slips.js` `inspectSlip`): hoogstens twee controles tegelijk; een derde krijgt meteen 429 met `Retry-After` in plaats van nog een werkthread. Daarnaast hoogstens tien uploads per bestelling per minuut. De plek komt ook vrij als de werkthread zonder bericht stopt.
- **B-39** (`POST /afrekenen`): de limiet op bestelpogingen en de captcha staan vóór het doorrekenen van de wagen. Het bijwerken van het totaal (`action=update`, ook op de achtergrond) heeft een eigen limiet van 300 per uur per bezoeker, zodat gewoon invullen de bestelpogingen niet opmaakt.
- **Reviewpunt #422**: het plafond van twee onbetaalde gastbestellingen per e-mailadres telt alleen bestellingen die nog voorraad vasthouden; na de vasthoudtijd van 30 minuten is het adres weer vrij (iemand kan het adres van een ander dus niet langer hinderen). De query houdt `lower(email)`: dat is precies de index `web_orders_email (tenant_id, lower(email))`.

## 1.34.5

Audit 1.33.0, thema webshopbetalingen en facturen, deel 2. Geen migratie.

- **T-02 Crediteren begrensd** (`verkoop/invoices.js`): bij definitief maken van een creditfactuur controleert `creditProblem` (met een rijslot op de oorspronkelijke factuur) dat de som van de definitieve credits niet boven het factuurbedrag komt en dat per artikelcode niet meer wordt gecrediteerd dan er gefactureerd is (409); daarmee komt ook de voorraad nooit vaker terug dan hij is afgeboekt. `credit()` maakt een nieuw concept met alleen de regels die nog niet definitief gecrediteerd zijn (`creditedSoFar`) en weigert als alles al gecrediteerd is.
- **B-19 Betaald/onbetaald** (`POST /api/invoices/:id/paid`): auditregels `factuur_betaald` en `factuur_onbetaald` (alleen bij een echte wijziging). Terugzetten op openstaand van een factuur met een geslaagde online betaling (portaal, betaallink of online betaalde webshopbestelling) geeft 409 `confirm_required`; met `confirm: true` gaat het door en staat dat in de auditregel. Facturen vraagt de bevestiging.
- **T-15 Visma-redirect** (`verkoop/visma.js`): de vaste standaard met het productiedomein en het oude pad buiten `/app` is weg. Zonder eigen redirect URI geldt het webadres uit Beheer > Webshop > Betalen + `app/api/visma/callback`; ontbreken beide, dan weigert verbinden met een duidelijke melding. Een ingevulde redirect URI moet met https beginnen en op `/app/api/visma/callback` eindigen, anders 400. Een eerder bewaarde waarde met het oude pad telt als leeg.
- **Betaling op een gecrediteerde factuur** (`verkoop/invoice-payments.js`): nieuwe haak `onPaidAfterCredit`, één keer per betaling; de aansluiting op audit en Bewaking volgt in de laatste PR van dit thema (server.js).
- Tests: crediteren (gedeeltelijk, te veel, alles), auditregels, bevestiging bij online betaald, de haak, en dat webhook en betaallink een factuur van een andere organisatie niet raken (B-12).

## 1.34.4

Audit B-03 (vervolg): de Dockerfile en `deploy/apps01/compose.yml` zetten het basisimage `node:22-alpine` en `cloudflared` op digest vast (cloudflared op versie 2026.9.3 in plaats van `latest`). `update.sh` controleert na het ophalen de cosign-handtekening van het image (identiteit: `release.yml` op `master` van deze repo) voordat de onderhoudsmodus aan gaat; een ongeldige of ontbrekende handtekening stopt de update en slaat die versie over. De controle werkt zodra cosign op de server staat (nieuwe servertaak `011-image-handtekening-controleren`, die ook `update.sh` vernieuwt); `IMAGE_SIGNATURE` in `.env` kent `auto` (standaard), `required` en `off`. Het ondertekenen zelf zit in `release.yml` (aparte PR).

## 1.34.3

Audit 1.33.0, thema webshopbetalingen (deel 1).
- **B-13** Online bestellingen krijgen `data.stockHoldUntil` (30 minuten, `PAY_HOLD_MINUTES`). `releaseUnpaidHolds` geeft daarna de voorraad vrij (`reservationReleasedAt`); `holdForPayment` reserveert opnieuw bij het starten van een betaling (onder het rijslot, geweigerd bij te weinig voorraad: `?betaalfout=2`) en `changePay` reserveert opnieuw bij betaald na vrijgave. Plafond op openstaande onbetaalde gastbestellingen: 2 per e-mailadres (`countOpenUnpaidGuest`), 3 per bezoeker (in het geheugen, `unpaidAmong`). De herinneringsmail belooft na het vrijgeven geen reservering meer.
- **T-08** Betaald op een geannuleerde bestelling: geen betaalhaken (bevestiging, factuur), `pay.paidAfterCancel`, automatisch terugbetalen (sleutel `annulering`) en de nieuwe haak `onLatePayment`. Vervallen annuleert de openstaande betaling bij Mollie waar dat kan (`mollie.cancelPayment`); een nieuwe betaling wordt alleen vastgelegd als de bestelling onder het rijslot nog nieuw is.
- **T-16** `onPaid(hook, { key })`: stappen met een sleutel worden bijgehouden in `pay.hooks` en door `catchUpPaid` opnieuw geprobeerd (na 10 minuten, hoogstens 5 keer, daarna `onHookFailed`). De sleutels worden in een volgende wijziging aan de factuur en de bevestigingsmail gehangen.
- **T-17** Een tweede geslaagde betaling komt in `pay.duplicates` en wordt op die betaling zelf terugbetaald.
- **T-18** Terugbetalen in drie stappen: aanvraag vastleggen (`status: 'aangevraagd'`, onder het rijslot), Mollie, afronden. Een weigering haalt de aanvraag weg; bij een onbekende uitkomst stemt `reconcileRefunds` af met `mollie.listRefunds` (onze sleutel gaat als metadata mee) en vervalt de aanvraag na 15 minuten zonder spoor.
- **T-20** De Mollie-webhook werkt ook als de webshop uit staat.
- De uurlijkse vervalronde (`expireUnpaid`) doet ook het vrijgeven, het afstemmen en het inhalen.

## 1.34.2

Audit B-33 (vervolg): `vault.fingerprint()` geeft een SHA-256 over een apart met HKDF afgeleide sleutel, ingekort tot 96 bit (zes groepen van vier tekens); niet terug te rekenen naar de hoofdsleutel. `GET /api/admin/backups` (alleen hoofdbeheerders) geeft `keyFingerprint` mee; Beheer toont hem in het blok Back-ups. Tests in `backup-restore-routes.test.js`.

## 1.34.1

- Artikelen: `ArtikelenMedia.setup` krijgt `api` mee (L-01, "api is not defined"); test `artikelen-media-setup.test.js`.
- `shared/brand.css`: `button { font-family: inherit }` (L-11); `beheer/beheer.css` en `artikelen/artikelen.css`: op smal scherm een hoger tikdoel voor `.btn.small` en `.linkbtn` (L-08).

## 1.34.0

Audit T-07, geen migratie:
- `migratePg` weigert een schemaversie die hoger is dan de code kent (`database nieuwer dan de code`); `AQUATECH_ALLOW_NEWER_SCHEMA=1` slaat dat bewust over.
- `update.sh` herkent die melding na een mislukte terugval en meldt "Database nieuwer dan versie X: herstel uit back-up nodig" in plaats van een algemene fout. Geldt vanaf de eerste versie die deze controle bevat (een oudere vorige versie kent hem nog niet).

## 1.33.9

- Audit B-16: bij wissen gaan ook IP-adres, doorgestuurd IP, browser en gebruikers-id uit het offerte-akkoordbewijs; de inzage heeft de tabbladen *Akkoorden offertes* en *Afspraaklogboek*; `POST /api/customers/:id/anonymize` vraagt `password` (en `totp` bij tweestapsverificatie, met een grens van 5 mislukte pogingen per 15 minuten per beheerder, audit `klant_wissen_wachtwoord_fout`); `GET /api/customers/:id/anonymize-preview` telt werkorders die alleen via `customer_id` gekoppeld zijn (`weakLinksOf`) en de klantkaart toont die waarschuwing.
- Audit T-10: `purchaseOrders.receive` dwingt zelf `seen` (409 `changed`) en `allowOver` (409 `over_received`) af, zodat de Artikelen-route en de orderpick-app dezelfde regel delen; de frontend stuurt per poging een `Idempotency-Key` en vraagt bevestiging bij een overschot.
- Audit B-38: netguard blokkeert ook 6to4 (2002::/16), Teredo (2001::/32), IPv4-compatibel (::/96), site-local (fec0::/10) en 192.88.99.0/24.

## 1.33.8

Audit 1.33.0, punten B-05, B-10 en B-12.
- B-05: `payable()` weigert een gecrediteerde factuur (`creditedAt`); het portaal toont `credited`, `start()` en de betaallink geven een nette melding, en een gecrediteerde factuur telt niet meer als te laat.
- B-12: verzoeken zonder inlog draaien nu binnen de RLS-afscherming: de webshop (hoofdmap) in de hoofdtenant, openbare offerte-, afspraak-, tekening- en betaallinks en de Mollie-factuurwebhook in de organisatie van de gevonden rij (`scopeToTenant`). Zoeken op token-hash en inloggen blijven bewust over organisaties heen. Niet gedaan: de scope van een ingelogd verzoek beperken tot de actieve omgeving (gebruikers, rollen en instellingen van de live-tenant worden ook vanuit een testomgeving gelezen).
- B-10: compose.yml geeft `TRUSTED_PROXIES` door; servertaak 008 zet het subnet van het compose-netwerk in `.env` en vernieuwt compose.yml, zodat proxykoppen alleen van de tunnel geloofd worden en niet van elk ander privé-adres (verbindingen via de gepubliceerde poort 3300 komen via de Docker-gateway en blijven vertrouwd).

## 1.33.7

Audit B-11 (scripts), geen migratie, geen servertaak nodig (het vaste commando haalt servertaken.sh altijd vers op):
- `servertaken.sh openstaand` toont vóór de bevestiging wie de commit maakte, wanneer, de titel en of GitHub de handtekening verifieert.
- `db-local.sh` en `setup-app-update.sh` zetten een branchnaam (standaard `master`) eenmalig om naar een commit en tonen die; alle bestanden van de run komen van die ene commit.
- Het releasetoken zit niet meer in de git-config (workflowwijziging, aparte PR).

## 1.33.6

Audit B-33 (deel 1), geen migratie, servertaak `010-back-up-integriteitscontrole`:
- `pg-backup.sh` schrijft naast elke `aquatech-*.dump.enc` een `.hmac` (HMAC-SHA256, sleutel afgeleid uit de hoofdsleutel); opruimen verwijdert hem mee.
- `restore-test.sh` en `db-local.sh restore` controleren hem vóór het ontsleutelen: een afwijking is `mislukt`/stopt het terugzetten; een oude dump zonder `.hmac` geeft een opmerking.
- Nog open uit B-33: een vingerafdruk van de hoofdsleutel in Beheer (raakt vault/server.js; apart).

## 1.33.5

Audit B-37, geen migratie:
- `docker-compose.yml`: `POSTGRES_PASSWORD` is verplicht (geen publiek bekend standaardwachtwoord meer); `.env.example` en README aangepast.
- `hub/Dockerfile`: `HEALTHCHECK` op `/api/health` in het image zelf. Bewust niet gedaan: `USER node` in het image; de app start als root om `/data` aan uid 1000 te geven (`dropPrivileges`) en dat ligt in de productie-compose vast met `cap_add`.
- Let op voor bestaande installaties met deze voorbeeld-compose: zij gebruikten het oude standaardwachtwoord. Zet `POSTGRES_PASSWORD=aquatech-lokaal` in `.env` om verder te gaan met het bestaande databasevolume; een nieuw wachtwoord past het volume niet aan. (De productie-installatie op apps01 gebruikt `compose.localdb.yml` en is niet geraakt.)

## 1.33.4

Audit B-28 en B-29 (Uitbesteden), geen migratie:
- Een open aanbod (aan iedereen) wordt bij "Aannemen" een aanvraag: `request` houdt het aanbod vast voor de aanvragende organisatie (`receiver_tenant_id` gevuld, `received_work_order_id` leeg = `pending`), de uitbesteder bevestigt (`POST /api/outsourcing/offers/:id/approve`, maakt dan pas de werkorder met klantgegevens) of wijst af (`…/reject`, het aanbod staat weer open voor anderen, de afgewezene komt in `declined`). De aanvrager kan zijn aanvraag zelf intrekken (`decline`). Een gericht aanbod blijft direct aan te nemen. Audit `opdracht_aangevraagd|bevestigd|aanvraag_afgewezen`.
- Het voorbeeld van een open aanbod toont de neutrale titel "Werkorder" (de titel kan klantgegevens bevatten).
- Aanbieden is begrensd op 20 per organisatie per uur (429 `rate_limited`, geteld uit `work_order_offers`) en een ontvanger krijgt per werkorder één aanbiedingsmail (`offeredBefore`), ook na intrekken en opnieuw aanbieden.

## 1.33.3

- Audit T-06: `update.sh` stopt de update vóór het vervangen van de container als `backup.js create` faalt (alleen exitcode 2 = oude versie kent `create` niet, of een eerste installatie zonder draaiende versie, gaat door met een waarschuwing); de huidige versie blijft draaien en run.json meldt `mislukt`. Servertaak `009-update-script-stopt-bij-mislukte-back-up` (zelfde handeling als 001) installeert het nieuwe script.

## 1.33.2

- Audit B-06: de controle op verplicht wachtwoord wijzigen, de no-store-kop en het 404-antwoord voor onbekende API-routes herkennen het API-pad nu hoofdletterongevoelig (`isApiPath`), dus `/API/…` omzeilt ze niet meer.
- Audit T-04: Permissions-Policy `camera=(self)` (eigen site) in plaats van `camera=()`; de rest blijft uit.
- Audit B-07: `accessCode` en `guestAccess` wijzigen (en resetten) mag alleen een hoofdbeheerder of wie al met de toegangscode is ingelogd; de back-uppoort laat de systeemgebruiker (toegangscode) niet meer toe. Test: `entry-hardening.test.js`.

## 1.33.1

Auditpunt T-01 (1.33.0): ondersteund, getest volledig herstel vanaf de Drive-kopie.
- `node src/backup.js noodherstel <back-up.db.enc>` (`restoreAll({ emergency: true })`, schakelaar `AQUATECH_EMERGENCY_RESTORE=1`): zet de hele app-back-up terug in een lege database, alles of niets; weigert zodra in welke tabel dan ook rijen staan (behalve de hoofdtenant).
- `pve/db-local.sh restore-app <bestand>` / `localdb/local-db.sh restore-app`: richt de eigen PostgreSQL in op een nieuwe server (`provision_local_db`, nu gedeeld met `migrate`), zet het terugzetten in een eenmalige app-container en start de app pas na een geslaagd herstel.
- Draaiboek in `deploy/apps01/README.md` (hoofdsleutel uit de wachtwoordkluis, back-up met de hand uit Drive). Tests in `backup-restore-all.test.js` en `deploy-localdb.test.js`; het terugzetten deelt `restoreAll` met de wekelijkse Drive-hersteltest.

## 1.33.0

Offline tellen voor de voorraadtelling: `shared/offline-core.js` cachet `api/orderpick/counts/open` en de blinde regels per locatie (`CACHEABLE`) en zet de ingave `POST api/orderpick/counts/:id/lines/:lineId/count` in de offline wachtrij (`QUEUEABLE`; de ingave heeft een eigen `clientId`). `orderpick/counting.js` haalt alle locaties van de lopende telling alvast op, toont een ingave zonder verbinding als geteld met de aantekening "wacht op verbinding" (bewaard op het toestel, per gebruiker en omgeving) en zet bij het versturen of weggooien de echte stand terug. Afsluiten, hertellen en beheer blijven online. Tests: `offline.test.js` uitgebreid; in een echte browser met de service worker (offline tellen, daarna online: server heeft de ingave, geen consolefouten).

## 1.32.9

Opschoning van `frontend/beregening/js/app.js` (2582 regels): het blok Controle en indienen (controlebalk, tekening indienen, goedkeuren en het leren van een herkenning, ruim 280 regels) staat nu in `beregening/js/app-controle.js`, dat de methoden op `App` zet (`Object.assign`). `app.js` geeft de gedeelde hulpmiddelen mee via `App.helpers`; `index.html` laadt `app-controle.js` na `app.js`. Geen gedrag veranderd: in een echte browser vergeleken met de vorige versie (zelfde methoden aanwezig, planner en tekenen-zonder-account laden zonder consolefouten).

## 1.32.8

Opschoning van `frontend/beheer/beheer.js`: de schermen Seizoensherinneringen, Betalingsherinneringen (`beheer/herinneringen.js`) en Etiketsjablonen (`beheer/etiketten.js`) staan nu in eigen bestanden (ruim 160 regels uit beheer.js). `index.html` laadt ze vóór `beheer.js`. Geen gedrag veranderd: in een echte browser vergeleken met de vorige versie (zelfde weergave, toevoegen van een etiketsjabloon werkt, geen consolefouten).

## 1.32.7

Opschoning van `frontend/facturen/facturen.js` (1514 regels): het Visma-scherm (verbinden, app-gegevens, bediening, overzicht en logboek, ruim 350 regels) staat nu in `facturen/visma.js` als fabriek `window.Facturen.createVisma(context)`; `facturen.js` geeft de gedeelde hulpfuncties en de stand mee en gebruikt `loadVisma`, `setupVisma` en `vismaReturn`. De pagina laadt `visma.js` vóór `facturen.js`. Geen gedrag veranderd: dezelfde weergave en dezelfde API-aanroepen (handmatig vergeleken met de vorige versie in een echte browser: Visma-tabblad zonder fouten).

## 1.32.6

Voorraadtelling, fase 5 (verpakkingsinvoer): `stockCounts.blindLines` geeft per regel de actieve verpakkingen (`packagings` met naam en factor, nooit prijzen; één query via `packagingsByItem`). Het tellen in de orderpick-app toont per verpakking een aantalveld naast *Losse stuks*; `Core.totalOf` rekent aantal × factor + los om naar één getal in de basiseenheid, dat zoals altijd als `qty` met `clientId` wordt opgeslagen (de server en het logboek veranderen niet). Offline tellen blijft een eigen vervolg (raakt `offline-core.js` en `sw.js`). Bereik per locatie bestond al bij het starten van een tussentijdse telling. Tests: `stock-counts.test.js`, `counting-core.test.js`.

## 1.32.5

Orderpick: een bestelling openen zet een eigen geschiedenisregel (`pushState`, `?id=`); `onPopState` toont bij terug de lijst en bij vooruit weer de bestelling. Het afronden van een pick vervangt de regel zoals voorheen (geen terugkeer naar een afgeronde bestelling). Tabbladen Ontvangen en Tellen blijven buiten deze wijziging. Test in `orderpick-modes.test.js`.

## 1.32.4

Doorlichtingspunt 13 (synchrone databasebrug afbouwen), vervolg: `workorders.listAsync` voert de lijstquery van `GET /api/workorders` uit via `db.async` (pool bij PostgreSQL), zodat een grote werkorderlijst de hoofdthread niet vasthoudt. `list` blijft voor de overige aanroepers (portaal, AI-koppeling); beide delen één querybouwer (`listQuery`) en één omzetting (`workOrdersFromRows`).

## 1.32.3

Offertes versturen (losse mail en bulk) reserveert per ontvangend e-mailadres vooraf een plek (atomair, dus ook bij parallelle verzoeken) en geeft die terug bij een mislukte verzending (`beveiliging/recipient-limit.js`, 5 per uur per organisatie, in het geheugen); daarboven 429 `recipient_limited` bij de losse mail en een overgeslagen regel bij bulk. Bovenop de bestaande limiet per gebruiker.

## 1.32.2

- Migratie 97: alle id's en verwijzingen naar id's (197 kolommen in 62 tabellen, o.a. tenant, gebruiker, plan, offerte, factuur, werkorder, bestelling en artikel) gaan van tekst naar het type uuid. Kleinere tabellen en indexen, en de database weigert nu een verwijzing naar iets wat geen id is. Waarden die al een uuid zijn blijven gelijk; een andere waarde (zou niet moeten voorkomen) krijgt in elke kolom dezelfde afgeleide uuid, zodat verwijzingen blijven kloppen. Bewust tekst gebleven: id's van buiten (WooCommerce, Mollie, Visma), `invoices.shop_order_id`, `client_id` van de offline wachtrij, `request_id`, `step_id` en `material_id`.
- Een id in een adres of verzoek dat geen uuid is, vindt nooit een rij: lezen en wijzigen geven niets terug (404), schrijven met zo'n waarde blijft een fout. De tenantafscherming (policies) vergelijkt als tekst.
- Deterministische regel-id's van de webshoprapportage zijn nu uuid's (afgeleid van dezelfde invoer).

## 1.32.1

- Migratie 96: een voorraadreservering hoort bij een werkorder óf een webshopbestelling. De tekstkolom `work_order_id` met `order:<id>` is gesplitst in `work_order_id` en `web_order_id`, elk met een echte verwijzing (de reservering verdwijnt mee met de order) en een controle dat precies één is gevuld. Reserveringen van orders die niet meer bestaan worden bij de migratie verwijderd. Een back-up van vóór deze migratie wordt bij het terugzetten automatisch gesplitst.

## 1.32.0

- Migratie 95: de kolom `data` van `web_orders`, `work_orders`, `invoices` en `quotes` is nu JSONB (gecontroleerde JSON, kleiner in de back-up). De pg-driver geeft de waarde als dezelfde JSON-tekst terug, dus de code verandert niet.
- NUL-tekens in invoer (ook de JSON-schrijfwijze `\u0000`) worden vóór het opslaan weggehaald, omdat JSONB die weigert; een bestelling met zo'n teken in de naam geeft dus geen databasefout meer.
- De controle dat `data` een object is, geldt in migratie 95 ook voor bestaande rijen (niet meer `NOT VALID`).
- De `contentHash` van een nieuw akkoordbewijs van een offerte wordt berekend over JSON met alfabetisch gesorteerde sleutels (`platform/stable-json.js`), omdat JSONB de sleutelvolgorde niet bewaart. Het bewijs is een referentie en wordt nergens opnieuw berekend; herberekenen kan alleen met dezelfde stabiele volgorde.

## 1.31.9

Migratie 94 (database-doorlichting 2026-11-20, stap 3 van de opzet): alle 142 kolommen `*_at` (aangemaakt, bijgewerkt, verlopen, enz.) zijn van `TEXT` naar `TIMESTAMPTZ` omgezet. Productiecijfers uit servertaak 006: de grootste tabel is 36 MB (`item_images`), de rest onder 4 MB, dus de omzetting duurt milliseconden. De pg-driver geeft ze terug als dezelfde ISO-tekst (`database/pg-types.js`), de verbinding staat op UTC (`SET TIME ZONE 'UTC'` in werkthread en pool), dus de rest van de code blijft gelijk. Een waarde die geen ISO-tijdstip is wordt NULL (bij NOT NULL: 1970-01-01). `monitor_incidents`: de meldmomenten gebruikten lege tekst voor 'nog niet'; nu NULL (code in `monitoring.js` en testdata aangepast, de cursor `before` wordt eerst gecontroleerd). `ai-usage.js` groepeert per periode met `to_char(... AT TIME ZONE 'UTC')` in plaats van `substr`. Datum- en tijdkolommen zonder `_at` (bijvoorbeeld `invoice_date`, `planned_date`, `start_time`) blijven tekst.

## 1.31.8

De Drive-test haalt de back-up op en vergelijkt hem zoals voorheen; daarna zet `platform/drive-restore-app-check.js` het bestand klaar in `update/request/drive-restore/` voor het hostscript `restore-test-drive.sh` (path-unit `aquatech-restore-test-drive.path`). Dat script start een wegwerpdatabase op een intern netwerk zonder uitgang, zet de hele back-up terug met een eenmalige container van het app-image (`node src/backup.js restore-into`, alleen met `AQUATECH_RESTORE_TEST=1`; `platform/backup-restore-all.js`, `importLines` kreeg de optie `deferForeignKeys`) en draait daarna dezelfde app-controle als de lokale hersteltest. Die controle is verplaatst naar `restore-app-check.sh`, dat beide scripts laden. De uitslag (`update/status/drive-restore-app.json`) komt als extra regels in de lijst van de Drive-test; een mislukte app maakt de run `mislukt`, een stil hostscript een waarschuwing. Servertaak `007-hersteltest-drive-app-controle` installeert alles. Tests: `restore-test-drive-script.test.js`, `drive-restore-app-check.test.js`, `backup-restore-all.test.js`, bijgewerkte `host-tasks.test.js`.

## 1.31.7

`shared/sidebar.js`: accordeon in de zijbalk (ook in de mobiele lade). Bij het laden staat de groep met de huidige pagina open; een eigen keuze op pagina's zonder groep wordt als één sleutel onthouden (`aquatech_nav_groups`, het oude object met meerdere groepen wordt tot één groep teruggebracht).

## 1.31.6

Servertaak `006-database-grootte-en-indexgebruik` (alleen lezen, `PGOPTIONS default_transaction_read_only`): toont de 25 grootste tabellen en de ongebruikte indexen van de productiedatabase en bewaart de uitvoer in `update/status/db-stats.txt`. Geeft de cijfers voor de beslissing over zware kolomomzettingen (database-doorlichting 2026-11-20).

## 1.31.5

Migratie 93 (database-doorlichting 2026-11-20, stap 2 van de opzet): 22 vlagkolommen (`stock_items.archived`, `shop_dirty`, `shop_sync`, `stock_managed`, `has_variants`, `users.disabled`, `platform_admin`, `tenants.disabled`, `news.pinned`, `visma_log.ok` en andere) krijgen een `CHECK (kolom IN (0, 1))`, `NOT VALID`: bestaande rijen worden niet gecontroleerd, nieuwe en gewijzigde wel. Bewust geen echte `boolean`-kolommen: de code schrijft en vergelijkt overal met 0 en 1, dus een omzetting levert risico en geen winst op.

## 1.31.4

Stap 1 van `opzet-timestamptz-uuid.md` (database-doorlichting 2026-11-20), geen migratie en geen gedragsverandering: `database/pg-types.js` registreert in de werkthread en de pool dezelfde parsers (BIGINT en NUMERIC als getal, `timestamptz`/`timestamp` als ISO-tekst met milliseconden en Z, `jsonb` als JSON-tekst, `boolean` als 1 of 0). Zo blijft de code gelijk als kolommen in de volgende stappen van type veranderen. Test: `test/pg-types.test.js`.

## 1.31.3

- Webshopsync: koppelingen, standen en prijzen worden per ronde in bulk (`UPDATE … FROM unnest`) en alleen bij een verschil weggeschreven; het bijwerkmoment van een ongewijzigd artikel wordt hooguit eens per dag vernieuwd.
- `shop_products` wordt bijgewerkt met één upsert (alleen veranderde rijen) en verdwenen producten worden gewist, in plaats van alles wissen en per product invoegen.
- Test: een ronde zonder verschillen kost bij 60 artikelen minder dan 25 queries.

## 1.31.2

Migratie 92 (database-doorlichting 2026-11-20): `NOT VALID` foreign keys (DEFERRABLE) op `invoices` (werkorder, offerte, klant, debiteur), `work_orders.quote_id`, `stock_items.parent_id`, `service_requests` (werkorder, klant), `oauth_grants.user_id` (ON DELETE CASCADE: koppelingen verdwijnen met het account) en `news.author_id`. Bestaande rijen worden niet gecontroleerd; nieuwe en gewijzigde rijen wel. Verwijzingen die leeg mogen zijn gaan bij verwijderen van het doel naar NULL. Bewust niet gedaan: `quotes.plan_id`, `work_orders.plan_id`, `stock_items.image_id`, `ai_usage.user_id` en `invoice_payments.invoice_id` (de API accepteert daar waarden zonder bestaande rij; eerst invoer valideren, zie de database-doorlichting).

## 1.31.1

Migratie 91 (database-doorlichting 2026-11-20): 46 kolommen van `DOUBLE PRECISION` naar `NUMERIC`: bedragen en betalingen `NUMERIC(14,2)` (facturen, offertes, bestellingen, betalingen, omzetregels, uitbestedingsvergoeding), prijzen en kostprijzen `NUMERIC(14,4)`, hoeveelheden en standen `NUMERIC(14,4)`, prijsfactor, groothandelskorting en inhoud per eenheid `NUMERIC(10,4)`. Bestaande waarden worden bij de omzetting afgerond op het aantal decimalen. De databaselaag las NUMERIC al als getal (`pgdb-worker.js`, `pg-pool.js`), dus de code is ongewijzigd; de volledige testsuite is groen.

## 1.31.0

Migratie 90 (database-doorlichting 2026-11-20): indexen op `work_orders(owner_id)`, `audit(user_id)`, `stock_cost_entries(item_id)`, `stock_count_entries(line_id)`, `support_grants`/`impersonations(tenant_id)`, functionele indexen op `lower(email)` van `web_orders` en `stock_alerts`; `stock_items_dirty` is nu een gedeeltelijke index (`WHERE shop_dirty = 1`); CHECK-constraints (NOT VALID, bestaande rijen blijven ongemoeid) op de status van `web_orders`, `web_returns` en `purchase_orders`.

## 1.30.9

`restore-test.sh` zet de wegwerpdatabase en de wegwerp-app op een intern Docker-netwerk zonder uitgang (`docker network create --internal`), start het image van de draaiende app (512 MB, alleen-lezen, tmpfs-datamap, hoofdsleutel alleen-lezen, `CAPTCHA_DISABLED=1`) en draait een controlescript in die container: status (geen eerste start), wegwerpwachtwoord op een actieve beheerder in de wegwerpdatabase, inloggen via de echte route, `api/me`, `api/plans`, `api/quotes`, `api/admin/users`. De uitkomsten komen als extra regels in de bestaande sanity-lijst; een mislukte regel maakt de test `mislukt`. Container en netwerk worden altijd opgeruimd. Servertaak `005-hersteltest-app-controle` installeert het script. Tests: nagebootste docker in `restore-test-script.test.js` (geslaagd, inloggen mislukt, app start niet, app niet gezond); het controlescript is daarnaast met de echte app tegen een teruggezette database geprobeerd.

## 1.30.8

`POST /api/admin/system-update/check`: limiet per gebruiker van 6 naar 60 per 10 minuten. De route zit achter inloggen en `canUpdate`; een lopende controle wordt hergebruikt (`requestCheck`), dus dubbel klikken geeft 202 zonder tweede aanvraag of auditregel. Starten, intrekken en automatisch aan/uit houden hun limieten.

## 1.30.7

`pg-backup.sh`, `restore-test.sh` en `local-db.sh restore` lazen de inhoudsopgave met `openssl … | pg_restore -l | grep` onder `pipefail`. `pg_restore -l` stopt na de inhoudsopgave, waarna openssl "error writing output file" gaf en de hele controle faalde zodra de dump groter was dan de pijpbuffer: elke back-up werd afgekeurd en niet bewaard. De controle ontsleutelt nu eerst het hele bestand en vangt de uitvoer van `pg_restore -l` daarna in een variabele op. Servertaak `004-pg-back-up-script-herstellen` installeert de scripts op apps01 en maakt een back-up. Regressietest in `restore-test-script.test.js` (grote dump, `pg_restore -l` stopt vroeg).

## 1.30.6

- `platform/drive-restore-source.js`: back-up van Drive als bron (`drive:<naam>` in het veld `backup` van de restore-routes), tijdelijke kopie in `.drive-restore-cache-*` (15 minuten, opruimen per minuut en bij de start), `DriveError` als leesbare fout in `backup-restore-routes.js`.
- Beheer: keuzelijst met groepen *Op de server* en *Op Google Drive*.

## 1.30.5

- `platform/drive-restore-test.js` (+ routes `/api/admin/restore-test-drive`, instelling `driveRestoreTest`, bewakingscontrole `hersteltest-drive`): Drive-back-up ophalen als stroom (`driveBackup.download`), `openBackup` in een tijdelijk schema, vergelijken met de actieve database, altijd opruimen; planning via de uurlijkse onderhoudsronde.
- Beheer: `hersteltest.js` is nu een fabriek voor beide schermen.
- `restore-test.sh`: minimaal 1 s wachttijd bij het wachten op een lopende back-up, duidelijker melding bij een afgebroken `pg-backup.sh`.
- Servertaak `003-hersteltest-script-bijwerken`: een app-update vernieuwt het hostscript `restore-test.sh` niet; deze taak installeert de nieuwste versie (hergebruikt taak 002).

## 1.30.4

- `createSlowLog({ taskThresholdMs })`: eigen drempel per taaknaam (server.js: Drive-back-up en back-up 90 s, webshopsynchronisatie 5 min, bestellingen ophalen en Visma 30 s, bewaking 25 s); overige taken blijven op `SLOW_REQUEST_MS`.
- Bewaking (`monitoring.js`, `noteSlow`): een controle of melding van 5 s of langer komt als `taak`-regel `Trage bewaking (controle|melding): <titel>` in het logboek (samenvoegbaar, met `controle` en `fase` in de details).
- `beheer/logboek.js`: Excel-export met Date-cellen, kolommen Bereik, Queries, Database (ms), Externe aanroepen, Extern (ms) en Overige details, autofilter en vaste kopregel.

## 1.30.3

`restore-test.sh`: ontbreekt `backups/postgres/aquatech-*.dump.enc`, dan draait `pg-backup.sh` eerst (dezelfde dagelijkse back-up) en wordt opnieuw gezocht. Lukt dat niet, dan noemt de melding de oorzaak (map ontbreekt, geen `pg-backup.sh`, of de laatste regels van de mislukte back-up). Test uitgebreid.

## 1.30.2

- Migratie 89: tabel `price_proposal_rejections` (ongebruikt sinds prijzen automatisch de factor volgen) verwijderd en index `web_returns_user` op `(tenant_id, user_id)` toegevoegd voor het opzoeken en anonimiseren van retouren per klant.

## 1.30.1

- `deploy/apps01/restore-test.sh` (+ systemd `aquatech-restore-test.{service,timer,path}`): ontsleutelt de nieuwste `pg_dump` als stroom, zet hem terug in een wegwerp-postgres (zelfde image, `--memory 768m`, `--network none`, geen vaste opslag, altijd opgeruimd) en controleert tabellen, schemaversie, rijtellingen (marge) en sanity-queries; schrijft `update/status/restore-test.json`.
- Servertaak `002-hersteltest-back-up-inrichten` installeert script en units (`SYSTEMD_DIR` overschrijfbaar voor tests).
- `platform/restore-test.js` + `restore-test-routes.js` (`/api/admin/restore-test`, `canUpdate`, audit `hersteltest_ingesteld|aangevraagd`), instelling en *Nu testen* via `update/request/`; bewakingscontrole `hersteltest` in `monitoring-checks.js`.
- Beheer > Systeem > Hersteltest (`beheer/hersteltest.js`): laatste uitslag, planning, historie en Excel-export. `system-update.js` exporteert zijn bestandshulpjes.
- Tests: `restore-test-script.test.js` (nep-docker), `restore-test-routes.test.js`, `host-tasks.test.js` aangepast voor meerdere taken.

## 1.30.0

- Offerte- en afspraaklinks: de herkomst komt uit `shopPayment.publicUrl` (`pinShareBase`), niet uit de browser van de medewerker; zonder ingevuld webadres blijft het gedrag gelijk.
- Losse mails (offerte, werkorder-afspraak, factuur) hebben een limiet van 30 per uur per gebruiker.

## 1.29.9

- `annotateBackups` (purchase-orders.js): backup-melding (`backup` met `preferredUnavailable`) op de regels van `proposals()`, twee queries voor alle voorstellen samen.
- Artikelen > Leveranciers per artikel: melding boven de tabel (`#d-sup-notice`) en de knop *Maak voorkeur*; bestelvoorstelblok toont de backup-melding.

## 1.29.8

- Webshop: kleine script `kaartaantal.js` zet − / + knoppen om het aantalveld van productkaarten; zonder script blijft het een gewoon invoerveld.

## 1.29.7

- Lijstroutes `GET /api/quotes`, `/api/invoices` en `/api/debtors` lezen via `db.async` (pool) met `listAsync`; de query-opbouw is gedeeld met de synchrone `list`, uitkomst ongewijzigd.

## 1.29.6

- `storefront-analytics.js`: `showConsentSettings` zet de schakelaar Analytisch vooraf aan bij een bezoeker zonder eerdere keuze (besluit Daniël 2026-11-20); een eerdere keuze blijft zoals die was. De banner (Accepteren en Weigeren even groot) en het laden na toestemming zijn ongewijzigd.

## 1.29.5

- Beheer: zoekwoorden voor Microsoft Clarity en de cookiebanner toegevoegd aan de sectie Webshop (`indeling.js`).

## 1.29.4

- Webshop: toestemmingsbalk herbouwd (`webshop/storefront-analytics.js`, `storefront.css`): titel, Accepteren/Weigeren (zelfde grootte) en *Instellingen* met een venster per categorie (Noodzakelijk altijd aan, Analytisch standaard uit). De balk verschijnt zodra Google Analytics of Clarity actief is; zonder beide staat er niets in de pagina.
- De keuze staat in `localStorage` (`aquatech_shop_consent`) als JSON met versie, keuze en datum; een oude of andere versie vraagt opnieuw. Intrekken wist de cookies van Google Analytics (`_ga*`) en Clarity (`_clck`, `_clsk`, e.a.).
- Nieuwe instelling `shopClarity` {enabled, projectId} (`liveOnly`, alleen hoofdtenant, standaard uit), formulier in Beheer > Webshop. Het script `https://www.clarity.ms/tag/<id>` wordt pas na toestemming ingevoegd, met `consentv2` (advertentie-opslag altijd geweigerd), `data-clarity-mask` op alle invoervelden en formulieren (ook nieuwe, via een `MutationObserver`) en op pagina's zonder canonicalPath (account, bestelling, afrekenen, retour, winkelwagen) op de hele pagina, en wordt niet geladen voor medewerkers. De CSP krijgt `clarity.ms`, `c.bing.com` en `worker-src blob:` alleen als Clarity actief is.
- Privacyverklaring: sectie *Cookies en meten* vervangt de tekst "geen tracking" en beschrijft de categorieën, bewaartermijn van de keuze, de cookies en de verwerkers.

## 1.29.3

Het nieuwspunt over de tabbladbalk van Uitbesteden (1.28.9) kreeg een doelgroep (`beheer`, `uitbesteden`), waardoor een klant het niet meer ziet en `test/news.test.js` weer slaagt. `checkFragments` in `tools/release-notes.js` weigert voortaan een nieuwspunt zonder doelgroep dat over Beheer → …, of Uitbesteden gaat (de planner niet: die is ook voor klanten), zodat dit bij de PR zelf opvalt.

De PR-bewaker (`tools/release-notes.js`, `audienceOnlyChange`) staat nu een wijziging van `frontend/nieuws/releases.js` toe als alleen een doelgroep (`for: [...]`) is toegevoegd aan een bestaand punt zonder doelgroep; bestaande doelgroepen wijzigen of weghalen (dat maakt een punt zichtbaar voor meer mensen), tekst, versies, datums en nieuwe of verwijderde punten blijven geweigerd. Zo kan een vergeten doelgroep via een gewone PR worden hersteld, zonder label.

## 1.29.2

`orderpick/receiving.js` en `counting.js` luisteren naar `hashchange`: een klik op de zijbalklink `orderpick/#ontvangst` (of `#tellen`) op dezelfde pagina laadt niet opnieuw en toonde daardoor Picken. Het scherm volgt nu de hash.

## 1.29.1

`td.actions` in de factuurtabel van het portaal erfde `display: flex` van `.card .actions` en viel daardoor uit de tabellay-out; nu `display: table-cell` met verticale uitlijning in het midden.
Het Contact-blok is uit het portaal verwijderd (de API geeft `contact` nog mee).

## 1.29.0

Nieuwe Playwright-layoutcheck in `tests/layout/` (workflow `layout.yml`, draait alleen bij wijzigingen in frontend of webshop-CSS): doorloopt alle app- en shoppagina's voor beheerder, installateur, planner, picker, klant en de shop (bezoeker, klant, medewerker) op 1440 en 375 px op testdata en meldt horizontale overflow, elementen buiten hun container, overlap, tabelcellen die uit hun rij vallen of scheef staan, afgekapte tekst en kaarten van ongelijke hoogte. Lokaal: `TEST_DATABASE_URL=… node tests/layout/layout-check.js`.

## 1.28.9

Gevonden door de nieuwe layoutcheck: `#tab-aikosten` velden `max-width: 100%`; `.tabs` op smal scherm `minmax(0, 1fr)` met afbreekbare tekst; `.product-name` `overflow-wrap: anywhere`. Zie `tests/layout/`.

## 1.28.8

`webshop/storefront.css` en `storefront-pages.js` (`productCard`): vaste fotohoogte (190 px, 130 px op een telefoon) op een zacht vlak, voorraadlabel als pil op de foto (het `stock`-element staat nu direct na de fotolink in de kaart, het script `varianten.js` vindt het nog via `data-variant-stock`), een vaste rij van 52 px voor de variantkeuze (kaarten zonder variant tonen daar `Artikelnr.`), raster `minmax(250px, 1fr)`, teal rand en schaduw bij hover. Het winkelwagenicoon op smalle kaarten (container query) is een witte masker-SVG.

## 1.28.7

`contentPage` toont de pagina `over-ons` met dezelfde kop (`aboutHero`), bedrijfsgegevens (`aboutFacts`) en afsluiting (`aboutCta`) als de standaardpagina; de eigen tekst staat in de verhaalkolom. Alleen HTML en CSS, geen migratie.

## 1.28.6

Standaardpagina Over ons (`aboutPage`) herontworpen: kop met intro, verhaal naast bedrijfsgegevens (telefoon, e-mail, adres en KvK uit de bedrijfsinstellingen), twee onderscheidende punten, waarden en een afsluitend blok met knoppen. De bestaande teksten zijn overgenomen; nieuw zijn de ondertitel in de kop, de zin in het afsluitende blok en de knoppen daarin; een eigen pagina uit Beheer gaat nog steeds voor. Alleen CSS en HTML, geen migratie.

## 1.28.5

Het frontendbestand `offertes/offertes.js` is zonder gedragswijziging opgesplitst in `offertes-share.js`, `offertes-customers.js`, `offertes-export.js`, `offertes-bulk.js` en `offertes-templates.js` (fabrieken op `window.Offertes`).

## 1.28.4

- Het script van de werkorderspagina is verdeeld over eigen bestanden (gedeelde hulpfuncties, afspraak met de klant, afdrukken en exporteren) zonder wijziging in gedrag.

## 1.28.3

Intern: de update van e-mail en telefoon van het gastaccount bij een ingediende tekening filtert nu ook op `tenant_id`; twee uitzonderingen uit `tenant-filter-baseline.json` zijn daarmee vervallen.

## 1.28.2

Het script van het artikelenscherm is opgesplitst in kleinere bestanden (Excel-export, nieuw artikel en overnames, mediabibliotheek), zonder wijziging in gedrag.

## 1.28.1

De controle *Webshopsynchronisatie* (`monitoring-checks.js`) gebruikte vaste drempels (waarschuwing na 3 uur, fout na 24 uur) en negeerde `shopSource.syncSchedule`. Bij het standaardrooster `night` leverde dat dagelijks een onterechte waarschuwing op. De drempels volgen nu het rooster: `night` 30 uur (waarschuwing) en 54 uur (fout), `hourly` en `tenmin` ongewijzigd 3 en 24 uur. Test uitgebreid.

## 1.28.0

- De gegevenslaag (store.js) is opgesplitst in kleinere bestanden (wachtwoorden, planoverzicht, voorkeuren, historie en plannen), zonder gedragswijziging.

## 1.27.9

- `mail-graph.js`: een onthouden token bevat de machtigingen van het moment van opvragen. Bij 401/403 op `sendMail` met een onthouden token wordt één keer een vers token opgehaald en opnieuw verstuurd (geen herhaling bij een vers token). `EGRAPH_DENIED` en `EGRAPH_MAILBOX` dragen het afzenderadres (geen geheim) mee.
- `mailer.js` (`mailFailure`): melding noemt de afzender, de wachttijd van een nieuwe machtiging en dat een alias niet werkt als afzender.

## 1.27.8

stock.js is opgesplitst in stock-helpers.js (saneren en hulpfuncties) en stock-routes.js (API-routes), zonder gedragswijziging.

## 1.27.7

- Intern: profiel, wachtwoord, instellingen, AI-kosten en kleurthema-routes uit server.js naar eigen bestanden (geen gedragswijziging).

## 1.27.6

Intern: de routes van Beheer > Back-ups > Google Drive (`/api/admin/backups/drive*`) staan nu in `platform/drive-backup-routes.js` in plaats van in `server.js`. Alle Drive-routes krijgen nu een ruime limiet per gebruiker (120 verzoeken per 15 minuten), zoals de codecontrole eist; verder geen gedragswijziging.

## 1.27.5

Intern: de routes van Beheer > Rollen (`/api/admin/roles`) staan nu in `platform/roles-routes.js` in plaats van in `server.js`. Geen gedragswijziging.

## 1.27.4

- Artikelen > Leveranciers per artikel: prioriteit met ▲/▼ in plaats van de voorkeursknop, kolom voorraadstatus (`stockStatus`), nieuwe regels komen onderaan.
- Bestelvoorstel en inkooporderregels tonen de backup-melding en het meerprijsverschil (`backup`).
- Testdata: elk zesde artikel heeft een niet-leverbare voorkeur met een backup.

## 1.27.3

- Migratie 88: `item_suppliers.rank` (prioriteit) en `stock_status` (`''` onbekend, `in_stock`, `out`); bestaande koppelingen behouden hun volgorde (voorkeur eerst).
- `suppliers.preferredByItem` kiest de voorkeur of de eerste leverbare backup; `reorderProposal` geeft `backup` {preferredSupplierName, extraPerUnit, extraAmount} en `allSuppliersUnavailable`.
- Inkooporderregels van een backupleverancier tonen `backup` (meerprijs); een ontvangst bij een backup wijzigt de inkoop- en verkoopprijs van het artikel niet (de FIFO-laag houdt de echte prijs).

## 1.27.2

- Voorraadtelling: `GET /api/stock-counts/:id/telstaat.pdf` (optioneel `?alleen=verschillen`) en `telformulier.pdf` (optioneel `?locatie=`), recht `voorraad`, met de documentopmaak van de organisatie; knoppen in Artikelen > Telling.

## 1.27.1

- `mail-graph-setup.js`: standaard inlog-client is nu Microsoft Graph Command Line Tools (`14d82eec-…`, device code flow) in plaats van de Azure CLI-client, die Microsoft met AADSTS65002 weigert voor Graph-tokens van app-registraties. Nog steeds te vervangen met `GRAPH_SETUP_CLIENT_ID`.
- `loginProblem`: AADSTS-codes uit de Microsoft-inlog (65002, 65001, 90094/90095, 700016, 50105, 53003, 50076) worden Nederlandse meldingen met verwijzing naar de handleiding; ook een mislukte start geeft nu de oorzaak.
- Test uitgebreid in `test/mail-graph-setup.test.js`.

## 1.27.0

Alleen frontend (`frontend/artikelen/index.html` en `artikelen.css`): het formulier `#edit-form` blijft één formulier met dezelfde veldnamen, maar is verdeeld in `fieldset.item-group`-groepen in een raster (`.item-groups`); `#move-form` is een compacte rij (`.move-card`). Verkoopprijs blijft alleen-lezen bij prijsbepaling factor. Geen API- of databasewijziging.
Daarnaast: een niet-gesloten `@media (max-width: 640px) {` in `artikelen.css` weggehaald, waardoor de stijl van de bulkbalk alleen op mobiel gold.

## 1.26.9

- Orderpick: modus Tellen (counting-core.js en counting.js) op de bestaande blinde telroutes; ingaven idempotent via clientId.

## 1.26.8

Tabblad Telling in `frontend/artikelen/counts.js` (lijst, starten, voortgang per locatie, regels met filter en paginering, hertellen boven de drempel, annuleren, afsluiten met wachtwoord, Excel met samenvatting, regels en ingaven) op de bestaande routes `/api/stock-counts`.

## 1.26.7

- Migratie 87: `stock_counts` (nummer `VT<jaar>-NN`, soort jaar of tussentijds, status tellen, afgesloten of geannuleerd; één lopende telling per organisatie, één afgesloten jaartelling per kalenderjaar), `stock_count_lines` (bevroren tellijst met verwachte aantallen, prijs per eenheid en bron: FIFO-gemiddelde, inkoopprijs of onbekend) en `stock_count_entries` (logboek van elke ingave, idempotent op `client_id`).
- `artikelen/stock-counts.js`: starten, blind tellen, hertellen boven een drempel (bedrag of percentage), afsluiten in één transactie met `stock.book` (soort telling, bron `telling:<nummer>`) en verslag. Het verschil wordt gerekend ten opzichte van de stand op het telmoment, dus een pick of ontvangst tijdens het tellen geeft geen vals verschil. Niet-getelde regels vragen een expliciete keuze (als 0 of ongewijzigd).
- Routes: beheer onder `/api/stock-counts` (recht `voorraad`, afsluiten met wachtwoord en limiet), tellen onder `/api/orderpick/counts` (recht `orderpick`, zonder verwachte aantallen of prijzen). Audit `voorraadtelling_*`. Routes staan in `configuration.routes` van de module voorraad.
- Een artikel met telregels wordt gearchiveerd in plaats van verwijderd; testdata bevat een afgesloten en een lopende telling.

## 1.26.6

- Prijsvoorstellen en de goedkeuringsstap (routes `apply`, `reject`, `reopen`, `price-proposals`, melding in het artikelscherm, taak op het dashboard) zijn verwijderd.
- `stock.repriceItem`/`applyAutoPrices`/`receiptCost`: een nieuwe inkoopprijs (formulier, inkoopprijs toevoegen, ontvangst, inkooporder) of factorwijziging zet de verkoopprijs direct goed; opslaan van de instelling en het uurlijkse onderhoud (`pricesRefreshAll`) rekenen alle artikelen opnieuw (ook oude open voorstellen).
- Auditlog `verkoopprijs_automatisch` met artikel, oud, nieuw en bron. Geen migratie; de tabel `price_proposal_rejections` blijft ongebruikt.
- Bulkwijziging: één UPDATE en één auditschrijfactie per blok van 200 (`store.auditMany`). Een handmatig gewijzigde verkoopprijs bij modus factor (met inkoopprijs) wordt genegeerd en het veld is dan alleen-lezen; het onderhoud slaat de onderhoudsmodus over.
- Webshopsync neemt de prijs van een artikel in de modus factor niet meer over; de audit logt alleen artikelen die de UPDATE echt raakte (RETURNING); een fout in de prijshistorie bij een ontvangst komt in het log.

## 1.26.5

- Wachtwoord vergeten: limiet van 5 aanvragen per uur per ontvangend adres, naast de limiet per bezoeker en de captcha; boven de limiet krijgt de bezoeker hetzelfde neutrale antwoord zonder mail.
- Opnieuw een bevestigingsmail aanvragen (`POST /account/bevestigen`): limiet van 5 per uur per account en bezoeker.

## 1.26.4

Alleen `webshop/storefront.css`: één kaartontwerp voor home en categorieën (de aparte `.browse`-kaartregels zijn samengevoegd). Foto met vaste verhouding die meegroeit, naam op twee regels, prijs en voorraad onder elkaar, aantal en knop onderaan op één lijn; container query op de kaart (`max-width: 200px`) maakt van de knop een icoon. Het artikelnummer en het aantal varianten staan niet meer op de kaart (zijn nog wel in de HTML voor het script).

## 1.26.3

`POST /api/quotes-bulk/send` ({ ids (max. 10), url }, recht `offertes`, 10 verzoeken per uur per gebruiker, mailserver vereist): per offerte dezelfde stappen als `POST /api/quotes/:id/send` (link maken, mail via `mailBody`, `markSent`, audit `offerte_verstuurd` met `via: 'bulk'`) met het standaardbericht in de documenttaal van de offerte, gericht aan `customer.email`. Bij een mailfout wordt een concept weer teruggezet (link ingetrokken). Beantwoorde, omgezette en afgesloten offertes, onbekende id's en offertes zonder geldig adres worden overgeslagen en met reden teruggemeld. Knop in de bulkbalk van de offertelijst met één bevestiging. Test: `test/quotes-bulk-send.test.js`. Bouwt voort op de bulkbalk uit de selectie-PR.

## 1.26.2

Factuurlijst (`frontend/facturen/`): selectiekolom, bulkbalk en knop *Exporteer naar Excel* (selectie, of alle zichtbare facturen zonder selectie). *Versturen per e-mail* loopt per definitieve factuur over de bestaande routes `GET /api/invoices/:id/mail` (voorstel) en `POST /api/invoices/:id/send`, met één bevestiging vooraf; facturen zonder e-mailadres en fouten worden per factuur gemeld en overgeslagen, zonder mailserver stopt de ronde. Geen nieuwe API of migratie.

## 1.26.1

Doorlichtingspunt 22. Instelling `invoicing.draftOnDone` (standaard aan, `InvoiceCore.sanitizeSettings`): bij de overgang van een werkorder naar `gereed` via `PUT /api/workorders/:id` maakt `draftOnDone` (verkoop/invoices.js, hergebruikt `createDraftFromWorkOrder`, de opbouw van `POST /api/invoices`) een conceptfactuur, alleen als de werkorder nog geen factuur heeft en er regels zijn; nooit definitief of verstuurd. Een tweede keer opslaan als Gereed maakt niets bij. Een fout houdt het opslaan van de werkorder niet tegen. Audit `factuur_concept_bij_gereed`. Test: `test/invoice-draft-on-done.test.js`.

## 1.26.0

- Nieuw: `verkoop/person-data.js` met `GET /api/customers/:id/privacy-export` (Excel) en `POST /api/customers/:id/anonymize` (bevestiging met de naam, geweigerd bij openstaande bestellingen of werkorders), recht `beheer`, audit `klant_inzage_export` en `klant_geanonimiseerd`.
- Anonimiseren: account (lege huls zonder inlog), offertes, werkorders, conceptfacturen, bestellingen, retouren, meldingen met foto's, plannen, debiteuren, voorraadmeldingen en IP-adressen. Bewaard blijven definitieve facturen met de offerte, werkorder, bestelling en debiteur waarop ze rusten.

## 1.25.9

SQLite is volledig verwijderd; PostgreSQL is de enige database.

- `database/db.js`: geen `node:sqlite`, geen SQLite-migraties (`MIGRATIONS`), geen `openSqlite`/`isPg`-takken. Zonder `DATABASE_URL`/`DATABASE_URL_FILE` start de app niet en meldt dat duidelijk. Nieuwe migraties alleen nog in `PG_MIGRATIONS`.
- Back-ups (`backup.js`, formaatversie 2): alle rijen als gzip-regels JSON uit één leestransactie, versleuteld zoals voorheen (zelfde bestandsnaam en bewaring). Een back-up in het oude SQLite-formaat (versie 1) wordt met een duidelijke melding geweigerd. Terugzetten uit back-up leest het bestand in een tijdelijk schema naast de database (`openScratch`/`dropScratch`) en ruimt dat altijd op. `db-copy.js` is `table-rows.js` geworden; `migrate-to-postgres.js` en `switch-to-supabase.sh` zijn verwijderd.
- De werkthread van pgdb vergeet na een ROLLBACK ook het onthouden schema (search_path wordt door de rollback teruggedraaid).
- `update.sh`: geen SQLite-databasekopie meer; altijd eerst een app-back-up.
- Docker/CI: `docker-compose.yml` heeft een PostgreSQL-container, de smoketests in `ci.yml` en `release.yml` starten er een; de job `test` in CI doet alleen `npm audit` (de tests draaien in `test-postgres`). Tests vereisen `TEST_DATABASE_URL`.
- De ruis `role "root" does not exist` in de PostgreSQL-log van CI kwam van de healthcheck `pg_isready` zonder gebruiker; die gebruikt nu `-U postgres`.
- Docs (README, DOCS, CLAUDE, AGENTS, deploy-README) bijgewerkt.

## 1.25.8

- `platform/mail-graph-setup.js`: automatische inrichting met de device code flow (inlog-client standaard de openbare Azure CLI-client, te vervangen met `GRAPH_SETUP_CLIENT_ID`; scopes Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All, Organization.Read.All). Maakt (of hergebruikt) de app *AquaTech Hub mail*, de service principal, de app-roltoewijzing Mail.Send en een clientgeheim van 12 maanden. Het token van de beheerder wordt niet bewaard; het device-code blijft server-side; sessie gebonden aan omgeving en gebruiker; routes `/api/admin/mail/graph-setup` (start, poll, annuleren) met limieten en audit `mail_graph_ingericht`. Beperken tot één mailbox (Application Access Policy) kan niet via Graph en blijft een handmatige stap.
- `mailServer.graphSecretExpires` (JJJJ-MM-DD) en bewakingscontrole `mail-secret` (waarschuwing vanaf 30 dagen, fout bij verlopen, hint zonder datum).

## 1.25.7

- Nieuwe catalogus `platform/kpi-catalog.js` (vaste KPI's met module, recht, periode en berekening); instelling `dashboardKpis` {items [{key, enabled}], period} per omgeving; `GET /api/admin/kpi-catalog` voor het keuzescherm (`beheer/dashboard-kpis.js`, bewaart bij elke wijziging). `GET /api/kpis` toont alleen aan staande KPI's waarvan de module aan staat en waarvoor de gebruiker het recht heeft, in de gekozen volgorde. Nieuwe KPI's komen automatisch achteraan met hun standaardstand. Standaard aan: openstaand, vervallen, gefactureerd, open offertes; bezetting staat uit. Geen migratie.

## 1.25.6

Instelling `quoteTemplates` (per organisatie, `internal` + `notInView`, alleen via `GET|PUT /api/quote-templates` en `DELETE /api/quote-templates/:id`; kiezen met recht `offertes`, bewaren en verwijderen met `beheer`, audit `offertesjabloon_bewaard`/`_verwijderd`). `verkoop/quote-templates.js`: hoogstens 30 sjablonen met een unieke naam (hoofdletters tellen niet), per sjabloon inleiding, voorwaarden en hoogstens 60 regels (zonder interne notitie en klantkeuze). Een bestaande naam wordt vervangen. In de offerte-editor: kaart *Sjabloon* (Toepassen vervangt inleiding en voorwaarden, met vraag als er al andere tekst staat, en voegt de regels onderaan toe; geen migratie). Test: `test/quote-templates.test.js`.

## 1.25.5

`server.js` opgesplitst (doorlichtingspunt 12, eerste stap): alle routes onder `/api/platform` (tenants, testomgevingen, multitenancy, testdata, gebruikers per organisatie) staan nu in `platform/platform-routes.js` (`registerPlatformRoutes`). Geen wijziging in gedrag; `server.js` is ruim 220 regels korter.

## 1.25.4

Artikelenlijst (`frontend/artikelen/bulk.js`): selectiekolom met *alles selecteren* voor de zichtbare rijen en een balk met *Archiveren* (één bevestiging, per artikel de bestaande `PUT /api/stock/items/:id` met `archived`; een artikel op een open bestelling of werkorder blijft staan en wordt gemeld) en *Etiketten printen* (hoofdartikelen en gearchiveerde artikelen worden overgeslagen; `ItemLabels.print`, hoogstens 500 etiketten per keer). Geen nieuwe API of migratie; rechten (`voorraad`) en tenantfilter blijven die van de bestaande routes.

## 1.25.3

Beheer > Systeem > Updates: het blok Servertaken (kaart met uitleg en commando) is verborgen zonder open taken, afgeronde taken staan in een inklapbare lijst `Afgeronde servertaken`. Vinkje en titel gebruiken een eigen rijklasse (`.ht-check`) in plaats van `.field.chk`, dat buiten een `.form-grid` gecentreerd stond. Geen backendwijziging.

## 1.25.2

Offerte-opvolging (`verkoop/quote-follow-up.js`, migratie 86 `quotes.followup_count|followup_at`): instelling `quoteFollowUp` {enabled, afterDays 2-60, maxReminders 1-2} (`liveOnly`, per omgeving). Elk uur (`app.locals.quoteFollowUpAll`) krijgt een verzonden offerte zonder antwoord, gemaild naar een geldig adres (`sent_to`) met een actieve link en niet verlopen een herinnering in de documenttaal van de offerte (`mail.followUp*` in `doc-text.js`). De herinnering wordt eerst vastgelegd (voorwaardelijke update, nooit dubbel) en teruggedraaid als de mail mislukt; audit `offerte_opvolging`. Beheer: formulier *Offerte-opvolging*. Test: `test/quote-follow-up.test.js`.

## 1.25.1

Offertelijst (`frontend/offertes/`): selectiekolom met *alles selecteren* voor de zichtbare rijen, balk met bulkacties (*Afsluiten als afgewezen* voor concept en verzonden offertes die niet zijn omgezet, één bevestiging, per offerte `PUT /api/quotes/:id` met status; fouten per offerte worden gemeld en overgeslagen) en Excel-export van alleen de selectie. Geen nieuwe API of migratie; rechten en de vergrendeling bij een klantreactie blijven die van de bestaande route.

## 1.25.0

Doorlichtingspunt 34 (eerste stap): `frontend/beheer/beheer.js` (1729 regels) is verkleind door het e-mailformulier (`mail.js`, `window.BeheerMail`) en het verzendformulier (`verzending.js`, `window.BeheerVerzending`) in eigen bestanden te zetten, volgens het patroon van de andere Beheer-onderdelen. Geen gedragswijziging.

## 1.24.9

Doorlichtingspunt 35 (eerste stap): `mcp/mcp-tools.js` (1231 regels) is verkleind door de hulpfuncties en grenzen naar `mcp-tool-helpers.js`, de plantools (`plan_maken`, `plan_details`, `plan_omzetten`) naar `mcp-tools-plan.js` en `maak_rapport_excel` naar `mcp-tools-report.js` te verplaatsen. De volgorde van de tools en het gedrag zijn gelijk; de overige grote bestanden uit punt 35 volgen apart.

## 1.24.8

Navigatiebalk van de webshop verdeeld over de volle containerbreedte (Over ons links, Planner rechts, in lijn met de bovenste rij) en Planner gelijk aan Over ons qua lettergrootte en hoofdletters. Alleen `storefront.css`.

## 1.24.7

Globaal zoeken (`platform/global-search.js`, geen migratie): `GET /api/search?q=` (ingelogd, limiet 120 per minuut per gebruiker, `no-store`) zoekt per soort met hetzelfde recht als de module (`klanten`, `offertes` (eigen, of alle met `offertes.alle`), `werkorders`, `facturen`, `voorraad`), filtert altijd op de omgeving van de gebruiker, begrenst elke groep op 5 en geeft alleen titel, omschrijving en een `?id=`-link. Woorden (max. 5) zoeken zonder hoofdletters, `%`/`_` uit de invoer zijn onschadelijk, een exact gelijk nummer staat bovenaan. Frontend: zoekveld met resultatenpaneel in `shared/sidebar.js|.css` (pijltjestoetsen, Enter, Escape, Ctrl+K). Test: `test/global-search.test.js`.

## 1.24.6

Doorlichtingspunt 13 (synchrone databasebrug afbouwen), eerste stap: `store.listCustomerPageAsync` voert de totaal- en paginaquery van het klantenoverzicht tegelijk uit via `db.async` (pool bij PostgreSQL). `GET /api/customers`, `GET /api/quote-customers` en `GET /api/workorder-customers` gebruiken die; de hoofdthread staat tijdens de zoekopdracht (LIKE over zes kolommen) niet meer stil. De synchrone `listCustomerPage` blijft voor de AI-koppeling (MCP). Beide delen één querybouwer (`customerPageQueries`).

## 1.24.5

- Nieuw: `verkoop/payment-reminders.js` (instelling `paymentReminders`, `liveOnly`; store, uurlijkse runner `app.locals.paymentRemindersAll`). Stappen herinnering (7 dgn), aanmaning (21), laatste aanmaning (35, standaard uit); alleen de laatst passende stap, nooit dubbel (unieke rij per factuur+stap), niet bij betaald, gecrediteerd, klant uit, ouder dan `stopAfterDays` (90). Factuur-PDF als bijlage; Engelse facturen krijgen Engelse tekst (`DocText`).
- Migratie: tabel `invoice_reminders` en kolom `users.reminders_off` (SQLite en PostgreSQL). Mailtypes `factuur_herinnering`, `factuur_aanmaning`, `factuur_laatste_aanmaning` in Mail-opmaak. `GET /api/invoices/:id` geeft `reminders`, de lijst `reminder`; `PATCH /api/customers/:id` accepteert `remindersOff`. Testdata en tests (`payment-reminders.test.js`).

## 1.24.4

Nieuwe sectie *Draaiboek VPS-verhuizing* (`beheer/index.html` formulier `s-vps`, `beheer/vps-draaiboek.js`, sectie `vps` in
`beheer/indeling.js`, alleen zichtbaar voor wie Systeem > Updates mag zien): vaste tekst met zes fasen (tunnel, adres en
hoofdsleutel blijven gelijk; database via back-up; proefrun met `local-db.sh restore`; oude server 14 dagen als terugval;
mailconnector-IP, Drive, Visma en Mollie controleren; image alleen `amd64`). De vinkjes staan per browser in localStorage.
Geen migratie, geen backend. `deploy/apps01/README.md` verwijst ernaar.

## 1.24.3

Blok *Kengetallen* op het dashboard (`dashboard/kpis.js`, `GET /api/kpis`, `platform/kpis.js`, geen migratie): alleen met recht
`beheer`; elke tegel hoort bij een recht (`facturen`: openstaand bedrag incl. btw van definitieve facturen en credits, vervallen
facturen; `offertes`: verzonden offertes zonder antwoord; `planning`: werkorders met een geplande datum in de huidige week
(maandag-zondag, geannuleerde niet) en het aantal uitvoerders). Een aggregatiequery per tegel op `tenant_id`; de tegels linken
naar de module. Test: `test/kpis.test.js`.

## 1.24.2

Betaallink in de factuurmail (geen migratie). `invoicePayments.linkFor` maakt een ondertekende link `/app/api/public/invoice-pay/<factuur>/<handtekening>` (HMAC met `vault.derive('factuur-betaallink')`, niets opgeslagen); `invoice-pay-routes.js` controleert de handtekening, de verloopdatum (`linkExpired`) en de status, start een Mollie-betaling en stuurt door; bij terugkeer (`?teruggekeerd=1`) volgt een opvraging bij Mollie. Alleen als online betalen aan staat; veld `{betaallink}` en een regel onder `{betaling}` in de standaardmail (`mail.payOnline`, nl en en). Limiet per bezoeker.

## 1.24.1

- `platform/mail-graph.js`: Graph-verzender (client credentials, `Mail.Send` als toepassingsmachtiging, `sendMail` met `saveToSentItems`, bericht met bijlagen tot ongeveer 3,5 MB (base64), inline afbeeldingen via `contentId`); vaste hosts `login.microsoftonline.com` en `graph.microsoft.com`, tenant- en client-ID gevalideerd, token per (tenant, app, geheim) kort onthouden.
- `mailServer.mode` kent nu `graph` met `graphTenantId` en `graphClientId`; het clientgeheim is de versleutelde, `liveOnly` instelling `mailGraphSecret` (alleen via `/api/admin/mail`, veld `graphSecret`; `graphSecretSet` in het antwoord). Geen migratie.
- `mailFailure` kent EGRAPH_AUTH/DENIED/MAILBOX/THROTTLED/SIZE/ERROR met advies; de bewaking controleert het token (`verify`). Tests: `createApp({ graphFetch })`.

## 1.24.0

Het eindimage bevat alleen nog `backend/src` en `tools/release-info.js` (dat `update.sh` uit het image haalt); de tests en
overige tools (codestijl, bench, minify, release-notes) blijven buiten het image (`hub/Dockerfile`, `hub/.dockerignore`,
bewaakt door `test/dockerfile.test.js`). Verouderde verwijzingen naar Supabase als productiedatabase gecorrigeerd in
`release.yml`, `ci.yml`, `compose.yml`, `deploy/apps01/README.md` en `DOCS.md` (Supabase is terugvaloptie; app-updates gaan
via de updatetimer, Drive-back-ups zitten in de app).

## 1.23.9

Servertaken (`platform/host-tasks.js`, `host-tasks-routes.js`, `GET|PUT /api/admin/host-tasks`, alleen `canUpdate`): lijst `HOST_TASKS`, afvinken door de server via `update/status/host-tasks.json` of met de hand (instelling `hostTasks`). `servertaken.sh openstaand` voert open taken uit op een vaste commit (`TASKS_REF`) en legt ze vast; `setup-app-update.sh` accepteert `SETUP_REF`. Eerste taak: updaten vanuit de app opnieuw inrichten. Geen migratie.

## 1.23.8

- `mailFailure` onderscheidt time-out, geweigerd (ECONNREFUSED), DNS-fout en geen route; `createMailer` legt host en poort vast op de fout (`mailHost`, `mailPort`; nooit het wachtwoord).
- `netguard.publicAddress` geeft bij meerdere adressen het IPv4-adres voorrang, zodat een container zonder IPv6 niet vastloopt op een IPv6-adres.
- `deploy/apps01/pve/diagnose-mail.sh`: alleen-lezen test van poort 25/465/587 vanaf de Proxmox-host, apps01 en de app-container.

## 1.23.7

Beheer > Systeem: `beheer/collapse-list.js` (`BeheerCollapse.render`) klapt lange lijsten in tot de eerste vijf regels met een knop *Toon alle (n)* / *Toon minder*. Gebruikt voor de back-uplijst, de Drive-bestanden en het Drive-logboek. Alleen frontend, geen migratie.

## 1.23.6

- Nieuw: `verkoop/invoice-payments.js` (tabel `invoice_payments`, migratie 84): per poging één Mollie-betaling. Hergebruikt de Mollie-sleutel en het webadres van de webshop (`configOf`), dus alleen in de hoofdtenant. De uitkomst komt altijd uit een opvraging bij Mollie (metadata `invoiceId` en bedrag moeten kloppen); de overgang naar betaald gebeurt één keer (voorwaardelijke update) en roept `invoices.setPaid` en de auditregel `factuur_betaald_online` aan.
- Nieuw: portaalroutes `GET /api/portal/invoices/:id/pdf`, `POST …/pay` en `POST …/check` (recht `portaal`, alleen eigen facturen, geen concepten of creditfacturen), `api/portal` geeft `invoices`; openbare webhook `POST /api/public/invoice-payment/:id/webhook` (limiet per bezoeker). `invoices.list` kreeg de filters `customerId`, `kinds` en `statuses`. Testdata vult `invoice_payments`.

## 1.23.5

- Nieuw: belletje in `dashboard/account.js` (`setupBell`, op elke pagina met kopbalk) op basis van `GET /api/tasks`; ververst bij openen en elke 3 minuten. Het dashboardblok deelt hetzelfde verzoek via `getJson`. Alleen met recht `beheer` of `voorraad`.

## 1.23.4

- `tableColumns` gebruikt op PostgreSQL `pg_catalog` i.p.v. `information_schema` (±150 ms → ±1 ms per tabel); tenant verwijderen, leegmaken en terugzetten uit back-up wordt daardoor niet trager bij meer tabellen.
- Testrun gebruikt goedkope scrypt-kosten (`AQUATECH_TEST_SCRYPT_N`, via `node --import test/helpers/fast-scrypt.js`); `scryptParams` negeert die variabele in productie en bij niet-machten van twee onder 1024. Productie blijft 2^17.
- Test goods-receipt controleert veldnamen i.p.v. losse tekst ("1.5" kwam toevallig in een tijdstempel voor en maakte de test af en toe rood).

## 1.23.3

- Migratie 83: `app_logs.first_at`. Herhalingen van de bronnen taak, stilstand en traag werken ook na het wegschrijven de bestaande regel bij (`created_at` = laatste keer, `first_at` = eerste keer, `repeat_count`, langste duur) zolang er binnen een uur een nieuwe komt en de regel jonger is dan 24 uur. Fouten blijven los (eigen foutcode en verzoek-id).
- De stilstandmelding heeft een vaste tekst ("Hoofdthread stond stil"); de duur staat in het veld Duur.
- Excel-export: kolommen *Tijdstip (laatste)* en *Eerste keer*.

## 1.23.2

- Nieuw: `GET /api/tasks` (`platform/open-tasks.js`, ingelogd; taken volgen de rechten `beheer` en `voorraad`, per omgeving) en het dashboardblok `dashboard/tasks.js`. Nieuw: `webOrders.listUnprocessed` (status Nieuw; online alleen na betaling).

## 1.23.1

In de release-image wordt de frontend in een aparte bouwstap verkleind (`backend/tools/minify-frontend.js`, esbuild als
devDependency, alleen in de bouwstap). Alle eigen `.js` en `.css` worden verkleind (witruimte, commentaar, syntaxis; geen
hernoemen van globale namen); `vendor/` en `.min.`-bestanden blijven ongewijzigd. De broncode in de repo blijft leesbaar,
de bestandsnamen en `?v=<versie>`-adressen blijven gelijk (de inhoud verandert alleen mee met een nieuwe versie, dus
Cloudflare-cache en cache-busting werken zoals voorheen). De backend wordt niet verkleind (draait op de server, niet in de
browser).

## 1.23.0

- Knop *Nu controleren op updates* (`POST /api/admin/system-update/check`, 6 per 10 minuten, audit `update_controle`): de app zet `request.json` met `{"check":true}` klaar; `deploy/apps01/update.sh` haalt dan alleen `:latest` op en werkt `status.json`/`releases.json` bij, zonder te installeren. Het scherm toont `checking` tot de host een nieuwe `checkedAt` heeft. Het hostscript moet hiervoor opnieuw worden ingericht (`setup-app-update.sh`); met het oude script wordt de aanvraag wel gecontroleerd maar als onleesbaar gemeld.
- Testlog: een mislukte of afgeremde login (POST `/api/auth/login`, 400/401/403/429) telt niet meer als `[traag]`; onder `node --test` (of `SLOW_LOG_QUIET=1`) schrijft het trage-verzoekenlog niets naar de console, het logboek in het geheugen blijft.

## 1.22.9

Webshopkop rustiger: de knop *Product zoeken* (dubbel met de productgroepen) is weg, de navigatiebalk is licht met kleine hoofdletter-items en een dun pijltje, *Over ons* is groen, de zoekbalk is zachter (afgerond) en Account/Winkelwagen tonen alleen een icoon (met aria-label), op mobiel ook de beheerknop. Alleen `storefront-pages.js`, `storefront.css` en `storefront-menu.js`.

## 1.22.8

`shopSource.syncSchedule` (`night` standaard | `hourly` | `tenmin`, geen migratie). `runAll` slaat een omgeving over tot `fullSyncDue` (webshop/shop-sync.js) aan de beurt is: dagwisseling 04:00 Nederlandse tijd (na de back-up), na een mislukte poging hoogstens elk uur opnieuw. Gewijzigde artikelen gaan nog steeds meteen via `schedule()`. Aanleiding: het logboek van 2026-11-19 toonde elke 10 minuten een "trage taak" van ~165 s met ruim 5300 queries en 2 s stilstand van de hoofdthread.

## 1.22.7

- De webshoppagina's bevatten de `google-site-verification`-meta (Search Console), in de `<head>`.

## 1.22.6

Winkelwagenpagina (`cartPage`) in het nieuwe webshopontwerp: de sectie krijgt de klasse `cart-page` en de stijl hangt in `storefront.css` onder `.cart-page`, zodat bestellingen, retouren en groothandel (die `.cart` en `.cart-table` delen) ongewijzigd blijven. Gedrag ongewijzigd. Huisstijl blijft aangehouden via de bestaande `--at-*`-variabelen.

## 1.22.5

Orderpick: `showList` in `orderpick.js` verborg de ontvangstschermen (`#rc-*`) niet, waardoor na Ontvangen → Picken beide lijsten zichtbaar bleven. Nu verbergt het alle andere schermen. Nieuwe test `orderpick-modes.test.js` wisselt meerdere keren heen en weer.

## 1.22.4

Productpagina (`productPage`) in het nieuwe webshopontwerp: alleen CSS onder `.product-detail` en `.product-details` in `storefront.css`; markup en gedrag ongewijzigd. Huisstijl blijft aangehouden via de bestaande `--at-*`-variabelen.

## 1.22.3

- `beheer/index.html`: het stappenplan (inklapbaar, boven de velden) vervangt de handleiding onderaan; de Google-stappen zijn bijgewerkt (Google Drive API, Google Auth Platform, publicatiestatus In productie, Webtoepassing met het redirect-adres, de scope drive.file).
- Label "Aantal back-ups op Drive bewaren" korter gemaakt ("Aantal back-ups bewaren"), zodat beide velden op dezelfde hoogte staan.

## 1.22.2

Categoriepagina (`browsePage`) in het nieuwe webshopontwerp: alleen CSS onder `.browse` in `storefront.css`, markup en gedrag ongewijzigd. De kruimelbalk bovenaan wordt ook op de productpagina rustiger; de startpagina blijft ongewijzigd. Huisstijl blijft aangehouden via de bestaande `--at-*`-variabelen.

## 1.22.1

- `GET /api/stock/price-proposals` (recht `voorraad`) geeft de open prijsvoorstellen (`openProposals` in price-factor.js). Het artikelscherm toont een melding met Goedkeuren/Negeren (beheerders, via bestaande `apply`/`reject`) en de lijst een label. Geen migratie, prijslogica ongewijzigd.

## 1.22.0

Gedeelde oplossing in `shared/brand.css` (onder 700 px): in elke `.tablewrap`-tabel is de identificerende kolom sticky (de eerste, of de tweede als de eerste een selectievakje heeft), compact (max. 46vw/190 px, omschrijvingen wrappen) en met opake achtergrond en schaduw. `AquatechCommon.wrapWideTables` (`shared/common.js`) zet tabellen die buiten een `.tablewrap` te breed worden (planner, klantdossier, back-up terugzetten, enz.) in een scrollbare wikkel. Desktop ongewijzigd; geen migratie. De begrenzing van de vaste kolom (`max-width` op de cel) is gemeten in Chromium op 375 px met een lange artikelnaam. De selectors gebruiken `:has()`; in een browser zonder `:has` (Firefox vóór 121, Safari vóór 15.4) valt de regel weg en schuift de tabel zoals voorheen.

## 1.21.9

Levertijd tonen (fase 3 van de levermethode-spec): `delivery-times.js` (`etaPhrase`, `etaSentence`) en `delivery-rules.js` (`describeRules`); nieuw invulveld `{levertijd}` in de mailtypes *Orderbevestiging* (online betaald en op rekening; leeg bij afhalen of zonder levertijd), aanvulling in de melding aan het bedrijf; blok *Verwachte levertijd* op de bestelpagina (alleen bij status nieuw, zonder volgcode); beperking per artikel op de productpagina (`leadInfoOf` geeft ook de regels van artikel en hoofdartikel); `GET /api/stock/items/:id/delivery-preview` (recht `voorraad`, `webshop/delivery-preview.js`) en overzicht in het artikelformulier; levermethode en levertijd bij een bestelling in Beheer en kolom *Levertijd bij bestellen* in de Excel. Geen migratie.

## 1.21.8

- `artikelen/item-images.js` (server): `setThumb` accepteert naast WebP ook JPEG (zelfde grenzen: 480 px, 100 kB, controle op inhoud); `thumbFile` herkent het formaat aan de bytes en levert het juiste `Content-Type`.
- Browser (`makeThumb`): probeert WebP en valt terug op JPEG als de browser WebP niet kan coderen.

## 1.21.7

Centraal applicatielogboek, deel 2: `GET /api/admin/logs` (`platform/app-log-routes.js`: filters niveau/bron/periode, zoeken op tekst, request-id of foutcode, cursor-paginering; platformregels en een andere omgeving alleen met canPlatform), `appLog.list/sources`, Beheer-sectie Logboek (`beheer/logboek.js`, Excel-export tot 5000 regels) en de instellingen `logRetentionDays`/`logErrorRetentionDays` in het formulier Sessies en bewaartermijnen.

## 1.21.6

Centraal applicatielogboek, deel 1 (`platform/app-log.js`, migratie 82 `app_logs`): gebufferd schrijven (2 s of 50 regels), herhalingen samengevoegd, max. 600 regels per bron per minuut, harde grens van 100.000 regels per omgeving, redactie van geheimen, e-mailadressen en IBAN. Request-id per verzoek (kop `X-Request-Id`, ook in de 500-melding). Bronnen: 500-fouten (met foutcode), trage verzoeken, stilstand, trage en mislukte taken, bewakingsincidenten. Bewaartermijn via instellingen `logRetentionDays` (14) en `logErrorRetentionDays` (30), uurlijks opgeruimd in het onderhoud.

## 1.21.5

- `artikelen/item-images.js`: `storeImage` herkent AVIF/HEIC (ftyp-merk) en geeft `unsupported_format` (415) in plaats van de misleidende melding over 8000 pixels; het overnemen meldt zulke artikelen met `convert: true` en `itemId`.
- Nieuwe route `GET /api/stock/items/:id/shop-image` (recht `voorraad`, tenant-gebonden, importlimiet): bytes van de afbeelding van het gekoppelde webshopproduct van dat artikel, via `download` (netguard, geen adres uit het verzoek). Antwoord `application/octet-stream` met sandbox-CSP, `no-store`.
- Browser (`artikelen/item-images.js`): `convertFailed` haalt de bytes op, zet ze met `createImageBitmap` en canvas om naar JPEG (max 1200 px) plus WebP-miniatuur en bewaart ze per artikel; een browser die AVIF niet kan lezen krijgt een duidelijke melding per artikel.

## 1.21.4

- `webshop/assets/`: WebP-varianten van `hero-tuin`, `banner-druppelslang`, `banner-pomp` en `zakelijk-achtergrond` (met `-klein` voor smalle schermen), gemaakt met `tools/shop-webp.py`; de JPEG's blijven staan (terugval en bestaande verwijzingen in Beheer).
- `storefront-pages.js` `imageHtml`: een standaardafbeelding met WebP-variant wordt een `picture` met `srcset`/`sizes` en de JPEG als `img`; geüploade afbeeldingen (`media:`) en bestanden zonder WebP blijven een gewone `img`. De standaard hero krijgt `fetchpriority="high"` (bovenaan de pagina, al met afmetingen); de rest laadt lazy. CSS: `picture { display: contents; }` zodat de opmaak gelijk blijft.
- Gewicht van de afbeeldingen op de startpagina: ongeveer 443 kB JPEG naar ongeveer 126 kB (breed scherm) of 63 kB (smal scherm) WebP.

## 1.21.3

- Migratie 81 (`item_images.thumb`, ook in `PG_MIGRATIONS`): versleutelde WebP-miniatuur (hoogstens 480 px en 100 kB, AAD `<tenant>:artikel-afbeelding-klein:<id>`).
- `artikelen/item-images.js`: `setThumb` (controle op inhoud: alleen WebP binnen de grenzen), `thumbFile` (valt terug op de gewone afbeelding), `thumbsPending` en `thumbCandidates`; routes `PUT /api/stock/images/:id/thumb` en `GET /api/stock/images-thumbs` (recht `voorraad`, tenant-gebonden); een upload kan `thumb` meesturen (een ongeldige miniatuur laat de upload wel slagen).
- Shop: `artikelfoto/<id>/klein` (zelfde limiet en `immutable` cache als de foto); kaartjes (productlijst, assortimentstegels) gebruiken `productImageSrc(root, image, { small: true })`, de productpagina blijft de grote foto tonen.
- Browser (`artikelen/item-images.js`): maakt de miniatuur met een canvas (geen native npm-module); de knop *Afbeeldingen en miniaturen* neemt eerst de afbeeldingen uit de oude webshop over en maakt daarna de ontbrekende miniaturen in porties van 25.
- `deploy/apps01/README.md`: stappen voor de Cloudflare-cacheregel voor `/artikelfoto/` en `/media/` (dashboardinstelling).

## 1.21.2

- `webshop/warm-up.js`: twee seconden na het starten haalt de server één voor één de startpagina, de winkelwagen en een paar groepen, categorieën en producten op via 127.0.0.1 (User-Agent met "bot": geen koopfunneltelling, geen medewerkersweergave). Dat vult de catalogus en de omschrijvingen in het geheugen. Een fout of een uitgeschakelde shop stopt niets; uitzetten kan met `WARM_UP=0`. Er wordt niets bewaard behalve wat de pagina's al cachen (geen klantgegevens, geen gerenderde pagina's).

## 1.21.1

- Catalogus (`storefront-data.js`): stale-while-revalidate. Een verlopen catalogus (tot 2 minuten oud) wordt voor pagina's van het assortiment (alleen GET/HEAD, niet winkelwagen, afrekenen, bestellingen, account, groothandel) meteen getoond terwijl `warm` hem op de achtergrond ververst. Alle andere aanroepen van `catalogOf` en elke POST rekenen met een verse catalogus (prijzen, voorraad, klantprijzen); de cache blijft per omgeving en bevat niets klantspecifieks. Zonder `db.async` (SQLite) verandert er niets.
- Databasepool: verbindingen blijven 5 minuten open (`IDLE_MS`, was 10 s), zodat de eerste aanvraag na rust geen nieuwe verbinding hoeft op te bouwen.

## 1.21.0

- Nieuwe instelling `mailLayout` (per organisatie, `internal`, alleen via `GET|PUT /api/admin/mail-layout`, `POST …/preview` en `POST …/test`; geen migratie): logo (documentopmaak, eigen of geen), positie, kop (balk of wit met lijn), kop-, knop- en accentkleur (terugval: eigen → documentopmaak → thema → huisstijl), bedrijfsgegevens in de voet, eigen voettekst en per mailtype een afwijkend onderwerp en eigen tekst met invulvelden (`platform/mail-layout.js`).
- `renderMail` vervangt de vaste HTML van `mailBody` (die nu een dunne laag is): e-mailveilige tabellen met inline styles, knop met `bgcolor`, logo als ingebed data-adres dat `mailer.send` omzet in een `cid:`-bijlage (`inlineImages`, hoogstens twee afbeeldingen). Alle ±25 aanroepen geven `mailStyleOf(settings)` mee.
- `composeFor(settings, type, values)` stelt onderwerp en alinea's samen uit de eigen of standaardtekst (precies de teksten van vóór deze wijziging). Een alinea waarvan alle velden leeg zijn vervalt; onbekende velden of een ontbrekend verplicht veld (de link) worden bij opslaan geweigerd; de tekst over het herroepingsrecht blijft altijd automatisch onderaan de orderbevestiging.
- Mailtypes met instelbare tekst: orderbevestiging (betaald/op rekening), verzonden (met/zonder volgcode, ophalen, ook als deellevering), betalingsherinnering (open/mislukt), artikel weer op voorraad, retour (ontvangen/goedgekeurd/afgewezen/afgehandeld), account (uitnodiging/wachtwoord/bevestigen) en inkooporder. Interne meldingen, nieuws en door de medewerker nagekeken mails (offerte, afspraak, factuur) krijgen de opmaak maar houden hun tekst.
- `settings.tenantId` toegevoegd aan het instellingenobject (voor de thema-terugval).

## 1.20.2

- Betalingsherinnering (#262) geldt nu ook voor gastbestellingen: `webOrders.unpaidOnline` filtert niet meer op `user_id` en `reminderAllowed` eist alleen voor een account een bevestigd, gelijk adres. Limieten ongewijzigd: één per bestelling (`pay.reminderAt`), één per adres per 24 uur (ook over gasten en accounts heen), alleen zolang de reservering loopt, alleen met mailserver en webadres, naam opgeschoond. De mail bevat de persoonlijke gastlink (`?k=`).
- Inkooporder per e-mail naar de leverancier (migratie 80: `purchase_orders.mail_sent_at|mail_sent_to|mail_sent_by|mail_error`): `artikelen/purchase-order-mail.js` (`draft`, `send`), `artikelen/purchase-order-pdf.js` (PDF met de documentopmaak van de organisatie), routes `GET /api/purchase-orders/:id/pdf`, `GET …/mail-draft` en `POST …/send` (recht `voorraad`, 30 per 10 minuten per gebruiker, audit `inkooporder_naar_leverancier_gemaild`). Alleen orders met status besteld of deels ontvangen; één adres tot drie, geen stuurtekens in onderwerp of adres, een lopende verzending blokkeert een tweede klik (409 `busy`) en een al verstuurde order vraagt `resend: true` (409 `already_sent`; het scherm meldt dat hij al is verstuurd), een databasefout bij het vastleggen na een geslaagde verzending geeft geen fout, een mislukte poging komt als leesbare melding op de order en wordt bij een geslaagde poging gewist. Opmaak via de bestaande `mailBody`; instelbare mailopmaak volgt later.

## 1.20.1

- Gedeeld tabelpatroon (`beheer/beheer.css`): `.tablewrap` krijgt `max-width: 100%`, kaarten/panelen/rasterkinderen mogen krimpen (`min-width: 0`), en rasterkolommen met `minmax(Npx, 1fr)` (N ≥ 200) in alle CSS gebruiken `minmax(min(100%, Npx), 1fr)` zodat ze een telefoon niet verbreden. `test/mobile-tables.test.js` bewaakt dit.
- Producttekst-blok (`#tx-detail`) verhuisd naar het artikelscherm (`item-texts.js` `showItem`); `GET /api/stock/item-texts/:itemId` geeft nu ook `ai` (aan/sleutel/dagrest). Zelfde backend, feitencontrole, bevestiging bij waarschuwingen en goedkeuring. Varianten en gearchiveerde artikelen krijgen het blok niet. Het tabblad Teksten opent het artikel bij Beoordelen.

## 1.20.0

- Migratie 79: `work_orders.customer_id` (verwijzing naar users, index `(tenant_id, customer_id)`), gevuld uit `quotes.customer_id` en `service_requests.customer_id`. Werkorderdata (`customer.*`) blijft de momentopname voor werkbon en pdf.
- `workorders.create/createReceived/update` nemen `customerId`; `update` laat de koppeling staan bij `undefined`. API: `customerId` in `PUT /api/workorders/:id` (recht `klanten`, klant moet een actieve klant van de organisatie zijn), `GET /api/workorder-customers`, `POST /api/workorders/link-customers` (`workorders.autoLink`: alleen een eenduidige, exacte naam of bedrijfsnaam, alleen op de knop, nooit automatisch op de achtergrond zodat een bewuste ontkoppeling blijft). Werkorderantwoord heeft `customerId` en `customerAccount`.
- Klantkaart (`customers.overview`) toont ook werkorders met `customer_id`; verwijderen van een klant ontkoppelt zijn werkorders; MCP `maak_concept_werkorder` en `plan_omzetten` geven `customerId` door. Het klantportaal en de planning zijn ongewijzigd.

## 1.19.9

- Instelling `shopPayment` krijgt `quoteRequest` (standaard aan) en `quoteRequestMin` (1 tot 1.000.000 euro excl. btw, standaard 500, ongeldig = 500) in `sanitizePayment`; `quoteRequests.offered(tenantId, cart)` vervangt `qualifies(cart)` bij de knop en de route (`qualifies(cart, minimum)` blijft de zuivere controle). Geen migratie.

## 1.19.8

- Migratie 78 `shop_funnel_days` (omgeving, dag, stap, teller; geen persoonsgegevens; na 400 dagen gewist via het uurlijkse onderhoud). `webshop/funnel.js` (`createFunnel`: `count`, `flush`, `report`, `purgeOld`): tellers in het geheugen, elke minuut en bij elk overzicht in één transactie naar de database, dus een warme shoppagina kost nog steeds 0 queries. Stappen `product`, `cart_add`, `cart`, `checkout`, `order`, `paid` en daarnaast `checkout_login` en `signup`; medewerkers, voorbeelden (`?voorbeeld=1`) en robots (`looksLikeBot`) tellen niet mee. Dag in Nederlandse tijd.
- `GET /api/admin/shop-funnel?days=` (Beheer). Tabblad Funnel in `frontend/webshop-bestellingen/funnel.js`. `shop_funnel_days` staat met reden in `NO_TESTDATA` (alleen echte bezoekers).

## 1.19.7

- Dezelfde winkelwagen binnen tien minuten geeft geen tweede concept of mail (merkteken in de interne notitie) en elke aanvraag staat in het auditlog (`webshop_offerte_aangevraagd`).
- `webshop/quote-requests.js` (`qualifies`, `request`; drempel `QUOTE_REQUEST_MIN_EXCL` = 500 excl. btw, een constante, geen instelling): `POST /winkelwagen/offerte/` (alleen ingelogde zakelijke klant, 5 per uur per klant, prijzen en btw uit `priceCart`, nooit uit de browser) maakt via `quoteStore.create` een concept met `customer_id` = de klant, een interne notitie met de herkomst en de bedrijfsgegevens, en mailt `quoteProfile.email` (mislukt de mail, dan staat het concept er toch). Geen migratie.
- `POST /bestelling/:id/opnieuw/` (via `orderAccessOf`: eigenaar of gast met toegang; `addCartLines` telt op bij de wagen, onbekende codes in `?niet=`). Een afronding op groothandelsvoorwaarden gebeurt zoals altijd in de winkelwagen zelf.

## 1.19.6

- `plannerPromoMark`/`isIrrigationGroup` in storefront-pages.js (merkteken `<!--planner-promo:…-->` op de startpagina en boven de producten van een hoofdcategorie met "beregening" in naam of adres); `storefront.js` vervangt het door het blok als `shopPlanner` aan staat (zoals het kopje Planner) en haalt het anders weg. De knop leidt naar `planner/` (ingelogd direct door naar de planner). Stijl `.planner-promo` in storefront.css via de `--at-shop-*`-variabelen. Geen migratie; de meting `planner_to_cart` bestond al.

## 1.19.5

- Instelling `shopPayment.paymentReminder` (standaard aan). Uurlijkse taak `betalingsherinneringen` (`app.locals.webPaymentsRemind`, `webPayments.remindUnpaid`): bestellingen met status `nieuw`, online betaling open of mislukt, ouder dan een uur en met een lopende reservering; eerst een opvraging bij Mollie, betaald = geen mail. Eén mail per bestelling (`data.pay.reminderAt`, pas gezet na een gelukte verzending, dus een mislukte mail wordt volgende ronde herhaald); hoogstens 50 per ronde. Geen migratie.
- Misbruikbeperking: een herinnering gaat alleen bij een account-bestelling (nooit bij een gastbestelling) naar een bevestigd adres dat gelijk is aan dat van de bestelling, hoogstens één per e-mailadres per 24 uur (`orders.reminderAllowed`), en de naam in de aanhef wordt opgeschoond (geen links, regeleinden, max. 60 tekens). Zonder mailserver gaan er geen Mollie-opvragingen uit.

## 1.19.4

- Migratie 77 (`shop_search_misses`, SQLite en PostgreSQL): per omgeving en genormaliseerde term een teller; alleen de term, nooit wie zocht. Termen met een e-mailadres of een lang cijfer, kortere dan 2 of langere dan 40 tekens worden niet bewaard; hoogstens 500 termen per omgeving (de minst gezochte valt weg); na 90 dagen zonder nieuwe zoekopdracht gewist (uurlijkse taak). Alleen een zoekopdracht zonder enig resultaat telt (niet met het voorraadfilter, niet in het voorbeeld).
- `GET /zoeken/suggesties/?q=` (max. 6 producten, `no-store`, eigen limiet 120 per minuut) en het script `zoeksuggesties.js` (toetsenbord, ARIA-combobox, tekst via `textContent`); zonder script werkt zoeken zoals voorheen.
- `GET /api/admin/shop-search-misses` (beheerders) en het tabblad Zoektermen in `webshop-bestellingen/`.

## 1.19.3

- Nieuw `webshop/search.js` (zuivere functies): normaliseren zonder accenten en leestekens, relevantiescore (exacte code, beginnende code, begin van de naam, alle woorden in de naam, voorraad als tiebreak), en een ruimere tweede ronde met stam, verwante woorden (`SYNONYM_GROUPS`) en tikfouten (Damerau-Levenshtein, 1 fout vanaf 5 tekens, 2 vanaf 8). Varianten blijven één eenheid met het hoofdartikel. De zoekpagina meldt het bij ruimer zoeken.

## 1.19.2

- Voorraadmelding (migratie 76, `stock_alerts`, `webshop/stock-alerts.js`): formulier op de productpagina (alleen met bestellen aan en een mailserver), captcha-actie `stock_alert`, limiet per bezoeker en per adres (10 open), honeypot; elk uur mailt `stockAlertsRun` de meldingen waarvan het artikel weer te bestellen is en wist ze, na 180 dagen of bij een gearchiveerd artikel vervalt een melding.
- Product en variant geven `stockQty`; `stockText` toont "Nog N op voorraad" bij 1 tot en met 5.

## 1.19.1

Winkelwagen: `shippingHint`/`shippingBlock` (kosten, levertijd, drempelbalk met `<progress>`), betaalnotitie naar de echte betaalwijzen, cookie `aquatech_laatste_lijst` (`rememberList`/`lastListPath`, alleen categorie of groep, nooit een zoekterm, alleen als bestellen aan staat) voor Verder winkelen, aantalformulier dat zichzelf verstuurt (`winkelwagen.js`) en een kaartweergave op smalle schermen. Afrekenen: verzendmethode als keuzekaarten (radio, `chosenShipping` in afrekenen.js), kop *Bezorg- en factuuradres* zolang het afleveradres gelijk is, dropshipping alleen in het formulier van zakelijke klanten. `trustStrip` op productpagina, winkelwagen en afrekenen (alleen punten met gegevens). Zoeken zonder resultaat: `noResults`. `shipping.optionsFor` geeft `freeFrom` mee.

## 1.19.0

- Migratie 75: tabel `item_text_drafts` (één concept per artikel: omschrijving, zoekmachinetitel en -omschrijving, waarschuwingen, vingerafdruk van de live tekst bij het schrijven). Wordt gewist met het artikel (`removeRow`, samenvoegen).
- `artikelen/item-text-writer.js`: AI-schrijver met de sleutel en het model van de organisatie (`aiTenantOf`), gestructureerde uitvoer, opdracht die alleen de bronvelden toestaat; webadressen en tags worden uit het antwoord gehaald. Verbruik komt als functie `product_tekst` in Beheer > AI-kosten.
- `artikelen/item-text-check.js`: bronvelden uit het artikel (`buildFacts`) en feitencontrole (`checkText`): losse getallen, getal + eenheid (schrijfwijzen als 2,5/2.5, meter/m), codes (PN10, DN25) en beweringen (keuren, garantie, waterdicht, …) moeten in de bron staan, anders een waarschuwing; ook een melding als er weinig gegevens zijn.
- `artikelen/item-text-drafts.js`: opslag en routes onder `/api/stock/item-texts` (recht `voorraad`): lijst met filters, detail, `generate` (hoogstens 5 per verzoek, 3 tegelijk, deels mislukken kan, een fatale fout als geen tegoed stopt de portie, dagelijks maximum telt per artikel), aanpassen, afwijzen, goedkeuren. Goedkeuren bepaalt de waarschuwingen opnieuw, eist `acknowledgeWarnings` bij waarschuwingen en `overwrite` als de live tekst sinds het schrijven is gewijzigd. Varianten en gearchiveerde artikelen krijgen geen concept. De routes vallen onder `configuration.routes` van de module voorraad.
- Frontend: tabblad Teksten (`artikelen/item-texts.js`).

## 1.18.1

- Pagina's in `shop_content` bewaren hun inhoud als `blocks` (nieuw bestand `webshop/page-blocks.js`: `text`, `image`, `products` (codes of categorie), `faq`, `cta`; maximaal 40 blokken, 40 vragen per FAQ-blok, 12 artikelen). Een pagina met alleen `body` krijgt die tekst als één tekstblok (`blocksOf`, `normalizePage`).
- `contentPage` tekent de blokken (`renderPageBlocks`) en zet FAQPage-gegevens uit alle FAQ-blokken (voor `veelgestelde-vragen` zonder FAQ-blok nog steeds uit de koppen). Wat in de gegevens staat, staat ook zichtbaar op de pagina.
- `llms.txt` toont de omschrijving van een pagina. Sitemap en `llms.txt` bestaan nog steeds alleen als de shop is vrijgegeven; een concept komt er nooit in.
- Editor in `beheer/webshop-inhoud.js` met blokken toevoegen, verplaatsen en verwijderen. Geen migratie.

## 1.18.0

- Migratie 74: `stock_items.delivery_rules` (JSON), `lead_days_min`/`lead_days_max` en `item_suppliers.lead_days`.
- `webshop/delivery-rules.js`: regels `{ method, minQty, maxQty }` per artikel (variant erft van het hoofdartikel) en per categorie (instelling `deliveryRules`, Beheer > Webshop > Levermethodes, `/api/admin/delivery-rules`); rangorde artikel > hoofdartikel > diepste categorie. `blockedMethods` laat de zwaarste methode een gemengde wagen meenemen; ophalen valt buiten de regels.
- `webshop/delivery-times.js`: levertijd per methode (`leadDays` + `dayType` in `shopShipping`, standaard DPD 1-2 kalenderdagen, pallet 3-5 werkdagen, eigen transport 5-10 werkdagen, ophalen direct), eigen levertijd per artikel, afleiding uit de verwachte datum van een inkooporder of de leverancierstijd; onbekend = "Levertijd op aanvraag". Indicatief; `data.shipping.eta` is een momentopname op de bestelling.
- `shipping.js`: `qtyTiers` per land bij pallet en eigen transport (gaat voor de weegklassen), `quantityOf`, geblokkeerde methodes met reden in `optionsFor`.
- `priceCart` geeft `delivery` (geblokkeerde methodes, levertijd per regel); `shippingQuote` voegt per optie `lead`/`leadText` toe. Productpagina toont de levertijd (`leadInfoOf` in storefront-data.js).
- Tests: `test/delivery.test.js`.

## 1.17.3

- Migratie 73: `stock_items.seo_title`, `seo_description` (70 en 160 tekens, opgeschoond via `item-details.js`) en `brand`; de variant erft per veld van het hoofdartikel (`shownDetails`), de EAN is altijd die van het artikel zelf.
- Categorieknopen in de menuboom (`seoTitle`, `seoDescription`, `normalizeTree`, editor `webshop-menu.js`) en pagina's (`seoTitle`, `normalizePage`) krijgen eigen zoekmachineteksten; de pagina's gebruiken `Seo.pageTitleOf` en de eigen omschrijving, anders de automatische tekst.
- Product-JSON-LD krijgt `brand` en `gtin13`/`gtin8` (alleen bij een enkel artikel of variant, nooit bij een prijsbereik, en alleen een geldige EAN); de prijs blijft de consumentenprijs incl. btw.
- Nieuwe instelling `shopSeo` {indexing} (standaard uit, `liveOnly`, alleen hoofdtenant, Beheer > Webshop > Zoekmachines): zolang uit krijgt elke shoppagina `noindex` (meta en `X-Robots-Tag`), zonder canonical, OpenGraph of JSON-LD; `robots.txt` is `Disallow: /`; sitemap, llms.txt en productfeed geven 404. Open vraagt ook een ingevuld webadres (`Seo.indexingOn`).
- Let op: zolang `shopSeo.indexing` uit staat laat `seoHead` ook OpenGraph en Twitter-kaart weg (gedeelde links krijgen dan geen voorbeeld); dat geldt ook voor een omgeving die al een webadres had ingevuld.

## 1.17.2

- Nieuw `platform/slow-log.js` + `database/query-stats.js`: elk verzoek of elke achtergrondtaak vanaf `SLOW_REQUEST_MS` (standaard 1000) komt als `[traag]` in het log en in een geheugenlogboek (laatste 500 regels, `app.locals.slowLog`). Per regel: duur, methode, genormaliseerd pad (id's, tokens, e-mailadressen en querystring weg), status, omgeving, aantal databasequeries en -tijd (synchrone brug en `db.async`-pool, ook wachten op een pool-verbinding) en externe aanroepen (`fetch`). Geen koppen, lichamen of gebruikersgegevens.
- Stilstandsbewaking van de hoofdthread (`SLOW_STALL_MS`, standaard 1000): een regel `[stilstand]` met de verzoeken en taken die toen liepen.
- Achtergrondtaken (onderhoud, back-up, Drive, bewaking, webshopsynchronisatie, Visma, bestelvoorstellen, herinneringen) worden gemeten.
- Back-up in een eigen proces (`backup.js` `createBackupInChild`, lagere prioriteit): bij PostgreSQL kopieerde `copyDatabase` alle tabellen synchroon in de hoofdthread, waardoor alle verzoeken tot een halve minuut wachtten. Zelfde bestandsformaat en sleutel; tests en `createApp` zonder `backupInChild` blijven in-process.

## 1.17.1

Bestellen als gast (webshop):
- Loginmuur op `afrekenen/` krijgt de keuze *Bestellen zonder account* (`?gast=1`) als online betalen werkt en `shopPayment.guestCheckout` (standaard aan) niet is uitgezet. Een gast is altijd een particulier (geen zakelijke prijzen, btw-verlegging, groothandel of dropshipping), betaalt altijd online en bestelt met dezelfde voorraadcontrole als een account.
- Gastbestelling: `web_orders.user_id` leeg, `data.guest` met de SHA-256 van het toegangstoken en het versleutelde token (geen migratie). Toegang via cookie `aquatech_gastbestelling` of de link `bestelling/<id>/?k=<token>` uit de bevestigings- en verzendmail, die tegen het cookie wordt ingewisseld en doorstuurt naar het adres zonder token. Verloopt na 180 dagen (of 90 na de laatste wijziging).
- Bestelpagina, betalen, factuur-PDF en retour (aanvragen en intrekken) werken ook voor een gast; zonder toegang toont een gastbestelling een neutrale pagina zonder gegevens.
- Limieten: 3 gastbestellingen per e-mailadres en 10 per bezoeker per uur.
- Na de bestelling optioneel een account maken (`POST bestelling/<id>/account`): koppelt alleen die bestelling, nooit op e-mailadres aan een bestaand account.
- GA4: `checkout_guest` bij het gastformulier en `checkout_type` op `purchase`.
- Tests: `guest-orders.test.js` (SQLite en PostgreSQL).

## 1.17.0

- Nieuw `beveiliging/captcha.js` (`createCaptcha`): instelling `captcha` {enabled, siteKey, minScore, onUnreachable} en geheim `captchaSecret` (versleuteld, `liveOnly`, nooit naar de browser), controle van het token bij Google (`siteverify`, 4 s, de actie en de minimumscore moeten kloppen), `captchaFetch` in `createApp` voor tests.
- Formulieren: `POST /api/auth/login` (hoofdtenant), `POST /api/public/drawing` (per organisatie) en in de shop inloggen, registreren, planner, wachtwoord vergeten, zakelijk aanvragen en afrekenen (alleen bij plaatsen, niet bij *Totaal bijwerken*). Een weigering geeft 400 `captcha_failed` (of 503 `captcha_unavailable`) en komt als `captcha_geweigerd` in het auditlog (zonder token). De controle staat vóór de wachtwoordcontrole, zodat een geweigerde robot niet meetelt voor de blokkering van een account.
- Google onbereikbaar of een geheim dat Google weigert: standaard doorlaten (`onUnreachable: allow`, de limieten en de inlogblokkering blijven gelden) of blokkeren; altijd een waarschuwing in Bewaking (`captcha`) die bij herstel sluit. Noodschakelaar: omgeving `CAPTCHA_DISABLED=1`.
- De CSP wordt alleen uitgebreid (script-src, connect-src, frame-src van reCAPTCHA) op de inlogpagina, de openbare planner (`?tekenen`) en de shop als de captcha aan staat. Het script van Google laadt pas als een bezoeker een formulier gaat gebruiken (`shared/captcha.js`); het kenmerk van Google is verborgen en vervangen door de vermelding onder het formulier. Staat los van de toestemming voor Google Analytics.
- Beheer: formulier *Onzichtbare captcha* met controle van de geheime sleutel (`POST /api/admin/captcha/check`). Geen migratie.

## 1.16.9

- Nieuwe instelling `shopAnalytics` (aan/uit en GA4-meet-ID, alleen live en hoofdtenant) met formulier in Beheer > Webshop.
- Cookiemelding en Consent Mode v2 in `analytiek.js`: standaard alles geweigerd, Google pas geladen na Accepteren, alleen `analytics_storage`, link *Cookie-instellingen* in de voet.
- Koopfunnel-gebeurtenissen: view_item_list, select_item, view_search_results, search_no_results, view_item, add_to_cart, remove_from_cart, view_cart, planner_to_cart, begin_checkout, checkout_login_wall, add_shipping_info, add_payment_info, checkout_error en purchase (zonder persoonsgegevens; purchase één keer per bestelnummer).
- De Content-Security-Policy van de shop krijgt alleen met een actief meet-ID de Google-adressen in `script-src` en `connect-src`; geen inline scripts. Zonder meet-ID verandert er niets in de pagina's of de policy.
- Medewerkers meten mee als intern verkeer (`traffic_type`); een voorbeeld meet niet. Robots, webadres en indexering zijn niet aangeraakt.

## 1.16.8

- `shared/doc-layout.js|.css`: wikkel (`AquatechDocLayout.wrap`) met CSS-variabelen `--doc-primary`, `--doc-accent`, `--doc-font`, `--doc-logo-height` en klassen `doc-plain`, `doc-logo-right`, `doc-no-company`; `logoHtml` en `footerHtml` voor kop en voet. De afdruk-CSS van `quote-view.css` en `klantdossier.css` gebruikt de variabelen met de oude waarden als terugval.
- `GET /api/quote-profile` en `GET /api/public/quote` geven `documentLayout` mee (geen extra verzoek); `quote-view.js` (`options.layout`), `werkorders.js` en `klantdossier.js` gebruiken hem. De twee nieuwe bestanden staan in `PUBLIC_FILES` voor de openbare offertepagina.
- `werkorders/index.html` laadt nu `offertes/quote-view.css`, zodat de werkbon dezelfde afdrukstijl heeft als de offerte. Geen migratie.

## 1.16.7

- Nieuwe instelling `documentLayout` per organisatie (`verkoop/document-layout.js`, alleen via `GET|PUT /api/admin/document-layout`, niet in de algemene instellingenlijst): logo (PNG als data-adres, ≤ 300 kB en 2400 px, opgeschoond en gecontroleerd), logopositie en -hoogte, kopstijl (balk of wit met lijn), kop- en accentkleur (anders het thema; kopkleur moet contrast 4,5 met wit houden), lettertype (Helvetica of Times), bedrijfsgegevens in de kop, bedrijfsregel en eigen tekst in de voet, paginanummers. Geen migratie.
- `drawHeader` en `drawFooter` vervangen de dubbel aanwezige kop- en voetcode in `invoice-pdf.js` en `packing-slips.js`; de standaardopmaak levert dezelfde PDF's als voorheen (behalve de voet, die nu regels van 9,5 pt tussenruimte krijgt).
- `pdf.js`: lettertype `serif` (Times-Roman en Times-Bold met eigen breedtetabellen); `createPdf({ font })` geeft `pdf.wrap` en `pdf.textWidth` die in dat lettertype meten.
- `POST /api/admin/document-layout/preview` maakt een voorbeeld-PDF (factuur of pakbon) met de opmaak uit het formulier zonder iets op te slaan; Beheer tekent de eerste pagina met pdf.js (lokaal, pas geladen bij gebruik).
- Instellingen kennen de vlag `notInView`: een waarde die alleen zijn eigen scherm nodig heeft komt niet in `GET /api/admin/settings`.

## 1.16.6

- Nieuw `artikelen/goods-receipt.js`: `GET /api/orderpick/receipts`, `/receipts/lookup?code=`, `/receipts/:id` en `POST /receipts/:id/receive` (recht `orderpick`, geen prijzen). Boeken via `purchaseOrders.receive` (voorraad + FIFO-laag), daarna backorders vrijgeven via `markBackorderReady`. Per regel `seen` tegen dubbel boeken (409 `changed`), meer dan besteld alleen met `allowOver` (409 `over_received`).
- Frontend: tabblad Ontvangen op `orderpick/` (`receiving-core.js`, `receiving.js`), module `ontvangst` in het moduleregister, route in `configuration.routes` van de module voorraad.
- Tests: `goods-receipt.test.js`, `receiving-core.test.js`.

## 1.16.5

- MCP-tool `plan_omzetten` (scope `plannen.concept`, plus `offertes.concept` of `werkorders.concept`): `quoteLinesFromPlan` in `beregening/plan-builder.js` (werkthread) levert de offerteregels uit `QuoteCore.fromPlan`; de offerte is een concept en hangt alleen aan een goedgekeurd plan, de werkorder krijgt stappen uit de arbeidsregels en materiaal met een bestaande artikelcode. Vraagt terug zonder klant (`ookMetOpenPunten`). Audit `offerte_concept_via_ai`/`werkorder_concept_via_ai`.
- Tests voor `plan_omzetten`, `quoteLinesFromPlan` en de limiet van `plan_details`; DOCS.md noemt nu alle MCP-tools.

## 1.16.4

- MCP-tools `plan_maken` en `plan_details` met nieuwe scope `plannen.concept` (recht `plannen`). Nieuwe `beregening/plan-builder.js` laat de plannerkern in een sandbox draaien met assortiment, prijzen en eigen sproeiers van de omgeving; vlakken in meters in, plan als concept uit. Terugvragen bij ontbrekende druk en debiet, bijsturen via `planId`, alleen eigen plannen. Limiet 10 plannen per uur, audit `plan_via_ai`. `registerShopRoutes` geeft `catalogOf` terug.

## 1.16.3

- MCP-tool `maak_rapport_excel` met nieuwe scope `rapporten.excel`: soorten `urenstaat` (periode hooguit 400 dagen; met recht `planning` iedereen, anders alleen eigen regels; bladen Uren en Materiaal), `openstaande_facturen` (recht `facturen`) en `voorraadlijst` (recht `voorraad`). Eigen kleine xlsx-schrijver zonder bibliotheek (`mcp/xlsx-writer.js`, cellen die op een formule lijken worden tekst). Het bestand wacht 15 minuten in het geheugen (`mcp/mcp-downloads.js`, maximaal 10 per gebruiker en 50 MB totaal) en wordt opgehaald via `GET /app/api/mcp-download/<token>` voor dezelfde gebruiker en omgeving (anders 404, niet ingelogd 401). Limiet 20 rapporten per uur, audit `rapport_via_ai` en `rapport_gedownload`.

## 1.16.2

- MCP-tools `boek_uren` en `boek_materiaal` met nieuwe scope `werkregistratie.boeken` (recht `werkorders`): boeken via `workLogStore.addHours/addMaterial` op naam van de gebruiker zelf, werkorder op nummer (`mcpLookups.workOrderByNumber`, per omgeving). Afgeronde of geannuleerde werkorder alleen met recht `planning`; een gelijke boeking binnen 10 minuten geeft `terugvragen`; onbekend artikel of variant geeft `terugvragen`; datum niet verder dan morgen (zoals in de app). Limiet 60 boekingen per uur per gebruiker, audit met `via: 'ai-koppeling'`.

## 1.16.1

- MCP-tool `maak_concept_werkorder` met nieuwe scope `werkorders.concept` (recht `werkorders`): werkorder zonder offerte via `workorders.createReceived`, status `open`, klant en adres uit de klantkaart, stappen met uren en materiaal (reserveert voorraad via `onWorkOrderChange`). Onbekend artikel, variant of ontbrekende klant geeft status `terugvragen` zonder iets aan te maken (`ookMetOpenPunten` gaat bewust door; de open punten komen in de interne notitie). Limieten 20 per uur en 100 per dag per gebruiker, audit `werkorder_concept_via_ai`.
- Bestaande koppelingen moeten opnieuw worden gekoppeld om de nieuwe scope te krijgen.

## 1.16.0

Bewaking: tabel `monitor_incidents` (migratie 72), `platform/monitoring.js` (incidenten, meldingen, heartbeat), `monitoring-checks.js` (controles), `monitoring-routes.js` (`/api/admin/monitoring`) en het scherm `beheer/bewaking.js`. Instelling `monitoring` per omgeving (ontvangers, webhook, herinneringen, drempels, dempen); platformcontroles alleen voor wie ook mag updaten. `errorCounter` in `error-report.js` telt 500-antwoorden; `mailer.verify` en `mollie.checkKey` zijn nieuw. Testdata: twee voorbeeldincidenten.

## 1.15.7

`purchase_orders.origin` (`handmatig`|`voorstel`) en tabel `purchase_proposal_dismissals` (migratie in `MIGRATIONS` en `PG_MIGRATIONS`). `purchaseOrders.autoPropose` houdt per voorkeursleverancier één concept met origin `voorstel` bij (één transactie, idempotent, geen nummerverspilling); een aangepast voorstel wordt `handmatig` en telt als onderweg (`incomingByItem` met `excludeProposals`). Routes `/api/purchase-orders/proposals[/refresh|approve|dismiss|restore]`. Instelling `purchaseProposals` {enabled} (standaard aan, per omgeving, geen liveOnly), uurlijkse taak `app.locals.purchaseProposalsAll` in `runMaintenance` en kort na het opstarten; de voorstel-routes horen bij `configuration` van de module Artikelen. Tests: `purchase-proposals*.test.js`, `proposals-core.test.js`, `module-settings.test.js`.

## 1.15.6

`localrecog.js`: kleur met tint vanaf 194,5° (lichtblauw) is water in plaats van haag; `paintEnclosedWhite` scheidt het witte huis van het papier via de donkere omtrek (`INK_LUMA`) en eist dat minstens 30% van de omtrek aan gekleurde vlakken grenst. Meting met de plangenerator: 10 bekende plannen functie 86% → 91%; 12 onbekende plannen (seed 101+) functie 90% → 91% (de eerste reeks is dus gedeeltelijk afgesteld, de tweede is de eerlijke maat). Tests in `localrecog.test.js`.

## 1.15.5

`localrecog.js`: `paintEnclosedWhite` zet een compact, rondom door kleur omsloten wit vak (≥ 1,5% van het beeld, niet aan de rand) op verharding; in `classMap` wordt een warme beplantingskleur zonder textuur (`TEX_FLAT`) verharding. Gemeten met de plangenerator op 10 verzonnen plannen (`npm run recog-bench`): functionele nauwkeurigheid 76% → 86%, juist benoemd 40% → 50%, gazon-overlap gelijk (87%). Test in `localrecog.test.js`. Geen wijziging van de leerbak (`FEATURE_VERSION` blijft).

## 1.15.4

`hub/backend/tools/plan-generator.js` (`node tools/plan-generator.js <map> [aantal] [eerste-seed]`) tekent verzonnen tuinontwerpen (gazon, borders, bomen, terras, woning, vijver, labels, titelblok; afwisselend digitaal en scan) met de bekende waarheid in `naam.json`, voor `npm run recog-bench`. De meetlat (`recog-metrics.js`) kent een eigen `layer` per vlak en toont de functionele nauwkeurigheid (gazon = sproeiers, beplanting = druppel, verharding/water = geen beregening). Geen effect op de app zelf.

## 1.15.3

- Migratie 70 (`MIGRATIONS` en `PG_MIGRATIONS`): kolommen `corpus_image`, `corpus_width`, `corpus_height`, `corpus_final` op `plan_recognitions`. Geen nieuwe tabel; een bestaande regel van een goedgekeurd plan (`source = 'plan'`) krijgt de tekening en het eindplan.
- Instelling `planCorpus` (bool, standaard uit, per omgeving); `GET /api/config` geeft `planCorpus`. `POST /api/plan/corpus` (recht `plannen.goedkeuren`, alleen een goedgekeurd plan van de eigen omgeving, limiet 20 per uur): de afbeelding wordt op inhoud gecontroleerd (`inspectImage`, metadata eruit, max. 8 MB, 8000 px) en met `vault.sealBytes` (AAD `<tenant>:plan-corpus:<plan>`) bewaard, het eindplan wordt gesaneerd (`sanitizeFinalPlan`). Audit `plan_corpus_bewaard`. Wissen via `store.purgePlan` ruimt de regel mee op.
- De planner stuurt na het goedkeuren (naast de kleurtellingen) de analyse-afbeelding als PNG en het eindplan in pixels (`app.js` `_learnFromPlan`, `Concept.saveCorpus`).
- `tools/corpus-export.js`: ontsleutelt het corpus van een omgeving naar `naam.png` + `naam.json`, de invoer van `tools/recog-bench.js` (PR #226).

## 1.15.2

- `backend/src/beregening/recog-metrics.js`: zuivere meetfuncties (rasteroverlap per vlaksoort, nauwkeurigheid, gazonverhouding, schaalfout, elementafstand) om de lokale herkenning met een referentie (AI-uitkomst of goedgekeurd plan) te vergelijken.
- `backend/tools/recog-bench.js` (`npm run recog-bench [map] [--json]`): draait de lokale vlakherkenning over `naam.png` + `naam.json` in een map en toont per tekening de afwijking. Geen netwerk, geen AI. Eerste referentie: het voorbeeldplan in `test/fixtures`.
- Eerste stap van het plan om de planner zonder AI te laten werken; de volgende stappen verbeteren de herkenning steeds aan de hand van deze meetlat.

## 1.15.1

Oorzaak van de lege ruimte: de klasse `.cart` van de winkelwagenpagina (marge 24px, max-breedte) viel ook op de winkelwagenknop in de kop; nu `.shop-main .cart`. Mobiele webshopkop (`storefront.css`, ≤ 800 px): kleiner logo en iconen, knoppen met minder opvulling, winkelwagenteller over het icoon, kleinere mededelingenbalk, zodat de kop niet meer over twee rijen met een lege ruimte valt.

## 1.15.0

- Nieuw `platform/backup-restore-lines.js`: regelweergave (gelijk, gewijzigd, ontbreekt, nieuw sinds de back-up) en `applyLines` in één transactie; offerteregels op `id` (totalen via `QuoteCore.totals`), bestelregels op `code` (totalen via `totalsOf` inclusief verzendregel, reservering opnieuw gelegd, tekort aan voorraad of totalen die niet bij de regels passen = geweigerd, regel in de geschiedenis).
- Routes `POST /api/admin/backups/restore/lines/preview` en `.../lines/apply` (zelfde bewaking als het terugzetten van records: wachtwoord, 2FA, limiet, veiligheidsback-up, audit `backup_regels_teruggezet`); de bevestiging staat in één hulpfunctie.
- Beheer: knop *Regels afzonderlijk terugzetten* in het voorbeeld van een offerte of bestelling.

## 1.14.9

- Nieuw `platform/backup-restore.js`: back-up ontsleuteld alleen-lezen openen (tijdelijk bestand, daarna gewist), records zoeken met status ontbreekt/gewijzigd/gelijk, voorbeeld met verschillen per veld (ook per JSON-sleutel, bijv. `data.lines`), terugzetten in één transactie; ontbrekende records komen terug met hun onderliggende regels (uren, materiaal, foto's, orderpakbonnen, inkoopregels, verpakkingen, leveranciers).
- Veiligheid: alleen binnen de eigen organisatie, nooit `tenant_id`, wachtwoordhashes, 2FA, deellinks, voorraadstand of webshopsynchronisatie; definitieve facturen, bestellingen, inkooporders en geaccepteerde offertes worden niet overschreven; ontbrekende ouder of dubbel nummer = geblokkeerd.
- Routes `/api/admin/backups/restore/{kinds,records,preview,apply}` (hoofdbeheerders, limieten, wachtwoord, veiligheidsback-up, audit `backup_teruggezet`).
- Beheer: sectie *Terugzetten uit back-up*. Tests op SQLite en PostgreSQL (`test/backup-restore.test.js`).

## 1.14.8

- Nieuw `platform/drive-backup.js`: OAuth2 met Google (scope `drive.file`, offline), hervatbare upload als stroom, opruimen boven het bewaaraantal (op bestandsnaam), logboek en stand in de instelling `backupDriveState`; geheimen versleuteld (`backupDriveClientSecret`, `backupDriveRefreshToken`).
- Routes `GET|PUT /api/admin/backups/drive`, `POST .../connect|disconnect|sync|test`, `GET .../callback` (hoofdbeheerders, audit); `runBackup` en het uurlijkse onderhoud starten de kopie op de achtergrond, na een fout pas na 15 minuten opnieuw.
- Beheer: sectie *Back-ups naar Google Drive* met handleiding, de lijst lokale back-ups toont *op Drive*.
- Tests met een nagebootste Google (`test/helpers/google-fake.js`).

## 1.14.7

- Nieuw: `deploy/apps01/compose.localdb.yml` (PostgreSQL 17-container met volume `pgdata/`, healthcheck, geen gepubliceerde poort; de app
  krijgt `secrets/database-url-local`, de Supabase-URL blijft ongemoeid als terugvaloptie), `localdb/local-db.sh` (op de server: `migrate`,
  `rollback`, `backup`, `restore`, `status`) en `pve/db-local.sh` (vanaf de Proxmox-host: zoekt de gast, LXC via `pct exec` of VM via ssh,
  kopieert de bestanden en voert ze uit, via `systemd-run` zodat een verbroken verbinding de migratie niet afbreekt).
- Migratie Supabase → lokaal: app in onderhoudsmodus en gestopt, `pg_dump`/`pg_restore` van schema `aquatech` in één transactie, controle per
  tabel (aantal rijen + controlegetal over de inhoud) plus policies, indexen en RLS-tabellen, versleutelde laatste momentopname van Supabase, daarna
  omzetten via `COMPOSE_FILE` in `.env`. Bij elke fout gaat alles terug naar Supabase (er is dan niets naar Supabase geschreven).
- Dagelijkse versleutelde back-up (`pg-backup.sh`, `aquatech-pg-backup.timer`, 02:30): AES-256 met de hoofdsleutel, direct gecontroleerd,
  bewaartermijn 14 dagen (zondag 8 weken, nieuwste 3 altijd). Terugzetten met `db-local.sh restore`.
- Terugdraaien naar Supabase met de nieuwe gegevens (`rollback`) of alleen de instelling (`rollback --no-copy`).
- Documentatie in `deploy/apps01/README.md`, `hub/DOCS.md`, `CLAUDE.md` en `README.md`; test `deploy-localdb.test.js` bewaakt de scripts.

## 1.14.6

Productnaam AquaTech Hub: de map `beregeningsplanner/` is `hub/` geworden (Dockerfile-context, `docker-compose.yml`, CI, `release.yml`, `version.yml`, `claude-review.yml`, releasetool, tests, docs). Paginatitels, PWA-manifest en de Excel-maker in de stuklijst gebruiken de nieuwe naam; `package.json` heet `aquatech-hub-backend`. De schilcache van de service worker heet `aquatech-hub-shell-<versie>` en de oude `aquatech-shell-*` wordt opgeruimd. Bewust niet hernoemd: de IndexedDB-wachtrij en de datacache (onverzonden werk gaat niet verloren), de opslagsleutel `aquatech-beregeningsplanner-v1` van de planner, het GHCR-image `ghcr.io/danieldh00/aquatech`, de bedrijfsnaam AquaTech Service in documenten en de webshopnaam.

## 1.14.5

Orderpick deel 3: offline werken (geen migratie).

- Offline-regels (`shared/offline-core.js`): recht `orderpick` mag offline werken, de bestellijst en -regels worden bewaard, `POST …/pick` mag in de wachtrij; `orderpick/` wordt vooraf in de cache gezet.
- Scherm: opgeslagen-melding, wachtende bestellingen verborgen en genoemd, afhandeling bij verzenden of weggooien uit de wachtrij.
- Tests in `test/offline.test.js`.

## 1.14.4

Orderpick deel 2: het scherm (geen migratie).

- `frontend/orderpick/`: lijst, scannen (toetsenbordscanner of camera met `BarcodeDetector`), aantal met OK en +/−, *Niet aanwezig*, afmelden met pakbon en label, voortgang en *Net gepickt* op het toestel.
- Rekenkern `orderpick-core.js` met unittests (`test/orderpick-core.test.js`).
- Module Orderpick in de groep Magazijn van de zijbalk en het dashboard (recht `orderpick`).

## 1.14.3

- **Updaten vanuit de app** (Beheer > Systeem > Updates, `beheer/updates.js`): `platform/system-update.js` en `system-update-routes.js` (`GET|POST /api/admin/system-update`, `DELETE .../request`, `PUT .../auto`). Alleen een eigen account in de live hoofdtenant met recht `beheer` (bij multitenancy alleen een hoofdbeheerder), wachtwoord opnieuw invullen, 5 pogingen per kwartier, auditlog `update_aangevraagd|ingetrokken|automatisch|wachtwoord_fout|geslaagd|mislukt|geweigerd`. `/api/me` geeft `systemUpdate`.
- Koppeling met de host via twee mappen: `UPDATE_STATUS_DIR` (alleen-lezen: `status.json`, `run.json`, `releases.json`, `maintenance.json`) en `UPDATE_REQUEST_DIR` (`request.json`, `policy.json`). Geen Docker-socket of root in de container. `tools/release-info.js` geeft de releasenotes van een image als JSON.
- **Onderhoudsmodus**: zolang `maintenance.json` bestaat (hoogstens 30 minuten) 503 `maintenance` met `Retry-After` op schrijfverzoeken (in- en uitloggen en de Mollie-webhook blijven werken), kop `X-Aquatech-Maintenance` met een balk in elke pagina (`shared/common.js`, `.maintenance-bar`), achtergrondtaken slaan een ronde over, `/api/health` geeft `maintenance`.
- `deploy/apps01/update.sh`: pakt een aanvraag meteen op (`aquatech-update.path`), installeert alleen de versie van `:latest` (geen symlinks, max. 4 kB), onderhoudsmodus tijdens het wisselen, controle op healthy én de nieuwe versie op `/api/health`, rollback met status; automatisch bijwerken uit = alleen controleren. Nieuw: `setup-app-update.sh`, `systemd/aquatech-update.{path,service,timer}`, volumes in `compose.yml`.

## 1.14.2

Orderpick deel 1: rol en API (geen migratie).

- Recht `orderpick` en standaardrol `picker` (`frontend/shared/roles.js`); de beheerder heeft het recht ook. Testdata krijgt een pickeraccount.
- `webshop/orderpick.js`: `GET /api/orderpick/orders` en `/orders/:id` (regels op magazijnlocatie met `scanCodes` van artikel of verpakking), `POST …/pick` (via `webOrders.ship`, nieuw `expectedShipments` tegen dubbel afmelden), `POST …/shipments/:id/packing-slip` en `…/label`.
- Pakbon per zending: `packingSlips.pdfFor(…, { shipmentId })` met `orderForShipment` (besteld, eerder, nu en backorder van die zending).
- `webshop/shipping-labels.js`: haak voor het DPD-label (`createApp({ shippingLabelProviders })`); zonder koppeling een nette melding.
- Tests: `test/orderpick.test.js`.

## 1.14.1

- Webshop: `productCard` (storefront-pages.js) is voor elk artikel een `<article>` met foto- en naamlink, bij een hoofdartikel met varianten een keuzelijst (`data-variant-row`, gedeeld script `varianten.js`, ook op de startpagina) en een prijs-/voorraadregel met `orderForm` (`card-order`). De paginabrede `variant-row` en `listItem` zijn vervallen; `winkel.css` heeft kaartstijlen (op ≤ 520 px staan aantal en knop onder elkaar).
- Productpagina: verpakkingskeuze (`?p=`, met behoud van `?v=`) uit `data.packagingsOf` (nieuw, gecachet per productpagina, `item_packagings`); zichtbaarheid per klantgroep via `visibleFor`, prijs en beschikbaarheid uit `priceCart` (`CODE@VERPAKKING`). Keuzelijsten op de productpagina versturen zelf (`data-autosubmit`), de knop Kies is de terugval zonder script.
- Tests: `test/product-cards.test.js`.

## 1.14.0

Backorders en deelleveringen voor webshopbestellingen (geen migratie, alles in `web_orders.data`).

- `webshop/fulfilment.js`: berekende leverstatus per regel (besteld, geleverd, leverbaar, backorder, verwachte datum uit inkoop); de voorraad gaat eerst-besteld-eerst-geleverd over open bestellingen.
- `webOrders.ship` en `POST /api/admin/web-orders/:id/ship`: (deels) verzenden met aantallen per regel (ook bedoeld voor de orderpick-app), `POST .../allow-partial`, `GET .../backorders`.
- `stock.issueOrderPart`: afboeken van een deel en de reservering laten krimpen. Factuur en verzendmail volgen bij de laatste zending; annuleren kan niet meer na een deellevering.
- Te picken toont alleen wat nu kan (`waitingForStock` voor de rest); de pakbon heeft kolommen besteld, eerder geleverd, nu en backorder.
- Na een ontvangst op een inkooporder markeert `markBackorderReady` bestellingen die weer kunnen (`backorderReadyAt`).
- Tests: `test/backorders.test.js`.

## 1.13.3

- `webshop/shop-content.js`: de standaardkolom *Uitverkoop* is verwijderd uit `DEFAULT_SITE`; een opgeslagen kolom met die kop wordt bij het saneren overgeslagen (`RETIRED_COLUMN_TITLE`), zodat ook bestaande live inhoud geen uitverkoop-sectie meer toont. Geen migratie nodig.
- `frontend/beheer/webshop-inhoud.js`: de legenda van het kolommenblok noemt geen uitverkoop meer.
- De filter op de kop is hoofdlettergevoelig: een kolom die exact `Uitverkoop` heet wordt overgeslagen.
- Tests (`shop-home.test.js`): sanering van een opgeslagen uitverkoop-kolom en controle dat de startpagina er geen toont.

## 1.13.2

- `profiel/index.html` en `profiel.css`: gedeelde klassen uit `shared/layout.css` (`.form-grid`, `.field`, `.form-actions`) i.p.v. eigen marges; kaarten zijn flexkolommen met één tussenruimte, rijen even hoog (`align-items: stretch`), AI-koppeling over de volle breedte; het losse `.form-foot` en de `grid-row: span 2` van de persoonlijke gegevens zijn vervallen.

## 1.13.1

Geen migratie. `shopShipping` (shipping.js) kent nu `dpd`, `pallet` en `eigen` (elk `enabled`, `label`, `zones`), `pickup` (standaardnaam *Afhalen in Nunspeet*) en `defaultWeightGrams` op het hoogste niveau (valt terug op de oude plek bij `dpd`). `optionsFor` geeft de bezorgmethodes die aan staan en afhalen als laatste; `countriesOf` voegt de landen van alle methodes samen; `defaultMethod` kiest vooraf de gevraagde methode, anders de eerste bezorgmethode die kan, en afhalen alleen als er niets anders is. Afrekenen: keuzelijst met de toelichting en reden per methode (`storefront-order-pages.js`, `storefront-checkout.js` (het script `afrekenen.js`) leest de keuzelijst). Bezorgcontroles (adres via PDOK, land van het factuuradres, btw verleggen naar een EU-land) gelden nu voor elke methode behalve afhalen; de volgcode blijft alleen voor DPD. Beheer: een blok per bezorgmethode.

## 1.13.0

- Moduleregister (`dashboard/modules.js`): veld `configuration { sections, settings, routes }` en hulpfuncties `isOn`, `hiddenSections`, `lockedSettings`, `lockedRoutes`; `visible` gebruikt `isOn`.
- Beheer verbergt de secties van uitgezette modules en bouwt het menu opnieuw op na het opslaan van Modules aan/uit.
- Server: `moduleFlagsOf(tenantId)` (ook voor `/api/config` en de startpagina), `PUT /api/admin/settings` weigert instellingen van een uitgezette module (409 `module_off`, ook `reset`; een patch die de module tegelijk aanzet telt mee) en een middleware weigert schrijfacties op `configuration.routes` (etiketten, prijsfactor, sproeierbibliotheek, uitbesteden).
- Seizoensherinneringen worden niet verstuurd zolang het klantportaal uit staat.
- Tests: `test/module-settings.test.js`.

## 1.12.9

Migratie 69: tabel `web_order_slips` (`tenant_id`, `order_id`, `file_name`, `pages`, `size`, `data`; sleutel `(tenant_id, order_id)`, ook in `PG_MIGRATIONS`). Nieuw `webshop/order-slips.js`: `inspectSlip` (alleen een echte, niet beveiligde PDF van hoogstens 2 MB en 10 pagina's, paginagrootte begrensd; de PDF wordt met `pdf-lib` opnieuw opgebouwd uit de pagina's zodat annotaties, paginaacties en metadata van de klant eruit zijn; de controle draait in een werkthread met geheugen- en tijdslimiet, `order-slips-worker.js`), `createOrderSlips` (`save`/`read`/`readMany`, versleuteld met `vault.sealBytes`, AAD `<tenant>:pakbon:<bestelling>`) en `assemblePdf` (zet eigen pagina's en pakbonnen van klanten in de volgorde van de bestellingen, met een etiket met het bestelnummer op de eerste pagina van de klantpakbon). Nieuwe afhankelijkheid `pdf-lib` (pure JavaScript). Afrekenen: velden `dropshipping=ja` en `dropshipProofEmail` (`dropshippingOf` in web-orders.js; niet bij ophalen), bewaard in `data.dropshipping` {proofEmail, slip}. Klantroutes: `POST /bestelling/:id/pakbon` (PDF als inhoud, `application/pdf`, alleen de eigenaar, alleen zolang de bestelling nieuw is, 30 per uur per bezoeker, `Sec-Fetch-Site`-controle, audit `webshop_pakbon_geupload`) en `GET /bestelling/:id/pakbon.pdf`; script `pakbon.js`. `pickable` eist bij dropshipping de geüploade pakbon; `to-pick` geeft `waitingForSlip` en `dropshipping` per bestelling; `pdfFor` is async en voegt de pakbonnen samen. Verzendmail: `proofEmail` krijgt een eigen, vast bericht (alleen bestelnummer en volgcode, nooit tekst van de klant). Vervangen van de pakbon kan niet meer zodra de pakbon is afgedrukt of de bestelling niet meer nieuw is. De streams van de PDF worden begrensd uitgepakt (40 MB per stream, 80 MB totaal) tegen decompressiebommen. Het afleverbewijs zelf (DPD) volgt met de DPD-koppeling.

## 1.12.8

- `sanitizeBusinessProfile(input, { kvkRequired })`: de klantenmodule (`POST|PATCH /api/customers`) vraagt geen KvK-nummer meer; een ingevuld nummer moet nog steeds uit 8 cijfers bestaan. De webshopregistratie en Beheer > Gebruikers houden het KvK-nummer verplicht.
- Klantadres vrij te typen als het btw-nummer (uit het verzoek, anders van de klant) een geldig nummer van een ander land is en VIES het geldig noemt (`checkForeignVat`, max. 20 nieuwe vragen per minuut per gebruiker). Onbereikbaar, ongeldig of een Nederlandse postcode: de PDOK-controle blijft gelden.
- Klantenscherm zet het adresveld op vrij typen bij een buitenlands btw-nummer.

## 1.12.7

- `store.updateAccount`: het adres wordt getrimd en in kleine letters bewaard; een contact-e-mailadres dat al bij een ander actief account hoort geeft 409 (`field: email`, hoofdletters en spaties genegeerd); `disabled: false` wordt geweigerd als het adres van het account intussen bij een ander actief account staat.
- `store.createCustomer`: de controle op een dubbel adres staat nu ook binnen de transactie (vangnet).
- Bestaande controles blijven: Mijn profiel, registratie in de webshop (blijft de duidelijke melding geven, begrensd door de registratielimiet), nieuwe klant en klantkaart. Tests: `duplicate-email.test.js`.

## 1.12.6

- Migratie 68: tabel `price_proposal_rejections` (één afwijzing per artikel: inkoopprijs + voorgestelde prijs), in SQLite en PostgreSQL.
- `artikelen/price-factor.js`: het voorbeeld is nu de lijst met prijsvoorstellen (`rejected`, `changedCount` = open, `rejectedCount`); `POST /api/stock/price-factors/reject` en `/reopen` (recht `beheer`, audit `prijsvoorstel_afgewezen`/`prijsvoorstel_heropend`); afwijzen en goedkeuren controleren de voorgestelde prijs opnieuw (verouderd = overgeslagen); doorvoeren wist de afwijzing.
- `stock.update`: een gewijzigde inkoopprijs rekent de verkoopprijs niet meer meteen; alleen een wijziging van modus of eigen factor doet dat. Artikelen met een vaste prijs krijgen geen voorstel.
- Tabblad Prijsfactor: knoppen Goedkeuren en Afwijzen per regel en voor de selectie, Heropenen bij afgewezen voorstellen.

## 1.12.5

Nieuw `webshop/packing-slips.js`: `packingSlipsPdf` (eigen PDF-schrijver, één pakbon per bestelling, regels gesorteerd op `stock_items.location`, verpakkingsregels met omrekening naar basiseenheden, opmerking van de klant, Nederlands of Engels volgens `data.language` via `DocText` `packing.*`), `createPackingSlips` (`toPick`, `pdfFor`) en `registerPackingSlipRoutes`: `GET /api/admin/web-orders/to-pick`, `POST /api/admin/web-orders/:id/packing-slip`, `POST /api/admin/web-orders/packing-slips { ids }` (hoogstens 50, geannuleerde bestellingen overgeslagen). Het afdrukken wordt in één transactie vastgelegd (`markPackingSlipsPrinted`) en staat in `data.packingSlip` {printedAt, count}. `web-orders.js`: `listToPick` (status nieuw, online alleen betaald), `getMany` (één query) en `pickable`. Het afleveradres is `data.address` (nooit het factuuradres). Frontend: tabblad *Te picken* (`te-picken.js`) en knop *Pakbon* in `bestellingen.js`. Migratie 67: index `web_orders_status` (tenant_id, status, created_at); `to-pick` geeft `truncated` bij meer dan 200 klare bestellingen.

## 1.12.4

- MCP: de serverinstructies bevatten een terugvraagregel. `zoek_klant` en `zoek_artikelen` geven `keuzeNodig` + `vraag` bij meer dan één of geen treffer (een exacte artikelcode of één volledige treffer niet; een gedeeltelijke treffer wel).
- `maak_concept_offerte` maakt niets aan zolang er open punten zijn (klant ontbreekt, onbekende artikelcode, variant niet gekozen, geen prijs, afwijkende genoemde prijs) en geeft `status: 'terugvragen'` met `vragen`; met `ookMetOpenPunten: true` gaat hij toch door (de notities blijven zoals voorheen). Geen extra gegevens en geen nieuwe query: alleen de bestaande, per omgeving gefilterde zoekresultaten.
- Elicitation is niet gebruikt: de server is stateless (geen stroom naar de app), dus terugvragen loopt via het toolresultaat.

## 1.12.3

Webshop `storefront.css`: `.nav-bar` wikkelt niet meer (`flex-wrap: nowrap`, items `white-space: nowrap`), en onder 1180 px en 980 px worden padding, lettergrootte en de minimumbreedte van *Product zoeken* kleiner. Onder 800 px blijft het mobiele menu.

## 1.12.2

- Nieuw `verkoop/quote-orders.js`: `POST /api/quotes/:id/convert` (recht `offertes` én `beheer`) maakt in één transactie een `web_orders`-bestelling (`createFromQuote` in web-orders.js) en koppelt hem aan de offerte met `quotes.order_id`/`converted_at` (migratie 66, unieke index per organisatie); twee gelijktijdige verzoeken geven één bestelling (409 `already_converted`).
- Prijzen en voorwaarden komen uit de offerte, niet uit de webshop. Regels met een bekende artikelcode (ook `CODE@VERPAKKING`) reserveren voorraad, ook bij een tekort (het antwoord geeft `shortages`); vrije regels (arbeid, tekst) niet. De korting wordt een negatieve regel per btw-tarief, `order.totals` is exact het offertetotaal. Btw verlegd, klantgroep, `paymentDays` en `language` staan op de bestelling.
- Afleveradres: `data.delivery` van de offerte wordt `address` (aflevering) met `billingAddress` = het adres van de klant en `deliverySame` (zoals bij de webshop sinds #199). De interne notitie van de offerte en de notities per regel gaan nooit mee.
- Een omgezette offerte is vergrendeld (PUT geeft 409 `locked`); `quote.order` ({ id, number, convertedAt }) staat alleen in de medewerkersweergave, nooit in de klantweergave. De status in de database blijft `akkoord` (weergave *Omgezet*), dus werkorders en het portaal blijven werken.
- `fromWebOrder` neemt van een bestelling uit een offerte de betaaltermijn en documenttaal over en verwijst in de referentie naar de offerte. Webshopbestellingen zijn ongewijzigd.
- Bestellingen in Beheer tonen de offerte, `?id=` opent direct een bestelling.

## 1.12.1

- Migratie 65: `stock_items.price_mode` (`vast`|`factor`) en `price_factor` (eigen factor, leeg = erven), index `(tenant_id, price_mode)`; in `MIGRATIONS` en `PG_MIGRATIONS`.
- Instelling `priceFactors` (`internal`, `{ defaultFactor, rounding: { mode, direction }, categories, suppliers }`), alleen via `GET|PUT /api/stock/price-factors` (lezen recht `voorraad`, opslaan recht `beheer`; categorieën gecontroleerd tegen het webshopmenu, leveranciers tegen de eigen omgeving).
- `artikelen/price-factor.js`: `roundPrice` (rekent in hele centen), `resolveFactor` (artikel > voorkeursleverancier > diepste categorie met factor > standaard), `marginPct`, `createPriceFactorStore` (voorbeeld in één query per omgeving, geen N+1) en de routes.
- `POST /api/stock/price-factors/apply` (recht `beheer`): rekent opnieuw en voert alleen de artikelen door waarvan de nieuwe prijs nog gelijk is aan het voorbeeld; de rest wordt overgeslagen. `stock.setSalePrices` zet `shop_dirty` voor gekoppelde webshopproducten en start de sync. Audit `prijsfactor_gewijzigd` en `prijsfactor_doorgevoerd`.
- Opslaan van een artikel in de modus factor rekent de prijs meteen als modus, eigen factor of inkoopprijs veranderen; een andere naam of locatie laat de prijs staan. Een nieuwe inkoopprijs via een ontvangst wijzigt de verkoopprijs niet vanzelf: het artikel staat dan als afwijkend in het voorbeeld.
- Artikel-API: `priceMode`, `priceFactor` en `margin` (% van de verkoopprijs). Testdata: standaardfactor en vijf artikelen in de modus factor.

## 1.12.0

Afleveradres naast factuuradres, zonder migratie (JSON in `web_orders.data` en `quotes.data`).
- Webshop: `data.address` blijft het afleveradres, nieuw `data.billingAddress` (factuuradres, met `country`) en `data.deliverySame`. Formuliervelden `deliveryStreet|Postcode|City|AddressManual`, `billingCountry`; `deliveryForm=1` maakt een niet-aangevinkt vakje (`deliverySame`) herkenbaar, zonder dat veld geldt "gelijk" (oudere aanroepen). `deliverySameOf` in web-orders.js. Beide Nederlandse adressen lopen via PDOK (`resolveParts`), afwijkend adres kan met "zelf invullen" (`deliveryUnverified`).
- `fromWebOrder`: factuuradres op de factuur, afwijkend afleveradres in de opmerkingen. Bevestigingsmail, bestelpagina en Beheer > Webshopbestellingen (ook Excel) tonen beide adressen.
- Offerte: `data.delivery` {same, address} (`QuoteCore.sanitize`), editor, document (NL/EN, `quote.deliveryTo`), Excel, en PDOK-controle op het afleveradres (`deliveryToVerify`). Werkorders/bestellingen uit een offerte gebruiken het veld later (volgende stap).

## 1.11.9

Kortingen per productcategorie voor zakelijke klanten en twee restpunten van de verpakkingen. Geen migratie.

- **Instelling** `categoryDiscounts` { rules: [{ categorySlug, discountPct }] } (`webshop/category-discounts.js`, `internal`: alleen via de beheerroute), één regel per categorie van het webshopmenu, 0,01 tot 90%. `GET|PUT /api/admin/category-discounts` (recht `beheer`, audit `categoriekortingen_gewijzigd`); de server controleert elke categorie tegen het gepubliceerde menu. Scherm: Beheer > Webshop > Zakelijke kortingen (`beheer/kortingen.js`).
- **Rangorde**: de diepste categorie met een korting wint (`resolverFor`). Een artikel met een eigen zakelijke prijs en een verpakking met een eigen prijs houden die prijs; een verpakking zonder prijs (factor × stukprijs) krijgt de korting (bij een groothandelsklant de hoogste van klant- en categoriekorting, zonder staffel). Bij een groothandelsklant telt de hoogste van staffel-, klant- en categoriekorting (`wholesalePrice(…, categoryDiscount)`, bron `categorie`), nooit opgeteld. Particulieren krijgen nooit een categoriekorting.
- **Catalogus** (`buildCatalog`): `priceBusiness` is de prijs na korting, `priceBusinessList` die ervoor, `categoryDiscountPct` de korting en `discountByCode` de kortingen per artikelcode; de catalogus onthoudt de kortingen bij zijn cache. Varianten volgen de categorie van hun hoofdartikel.
- **Winkelwagen en bestelling** (`priceCart`): krijgt de kortingen per artikelcode uit de catalogus (alleen als de organisatie kortingen heeft); de regel meldt `listExcl`, `discountPct` en `discountSource: 'categorie'`. Bestelling, factuur en rapportage gebruiken de kortingsprijs. Offertes gebruiken geen zakelijke prijzen en blijven ongewijzigd.
- **Testdata**: de testomgeving krijgt twee categoriekortingen.
- **Verpakkingen, restpunten**: de rapportageregel van een artikel dat als verpakking is verkocht noemt het artikel zelf (`itemName` op de orderregel); extra test voor factuur en marge met pallet en stuks.
- Tests: `category-discounts.test.js`.

## 1.11.8

Versienummer, changelog en releasenotes worden niet meer per PR aangepast, zodat PR's elkaar daar niet meer in de weg zitten. Geen migratie.

- **Fragment per PR**: `changes/<naam>.md` met titel, punten voor Nieuws (met rechten) en een changelogtekst (zie `changes/README.md`).
- **Na de merge** (`release.yml`, job *Versie en notes*): `tools/release-notes.js` geeft elk fragment het volgende versienummer (patch + 1, na x.y.9 de volgende minor; `bump: minor` kan), werkt `package.json`, `CHANGELOG.md` en `releases.js` bij, verwijdert de fragmenten en commit naar master met `[skip ci]`. Daarna testen en bouwen van het image zoals voorheen. Gelijktijdige merges: de runs wachten op elkaar (`concurrency`) en een mislukte push wordt opnieuw geprobeerd op de nieuwste master.
- **Controle in PR's** (`version.yml`, check `version-must-increase`): faalt als een PR het versienummer, `CHANGELOG.md` of `releases.js` zelf wijzigt of als een fragment ontbreekt (uitzondering: label `geen-releasenotes`).
- Tests: `release-notes.test.js`.

## 1.11.7

Fix: Beheer > Webshop > Webshop-inhoud gaf *Kan de webshop-inhoud niet laden: Cannot read properties of undefined (reading 'items')*. Een opgeslagen versie van de startpagina zonder een van de blokken (banners, kolommen, voordelen of merken) werd ongewijzigd naar het scherm gestuurd, dat `site.<blok>.items` verwacht. `view()` in `webshop/shop-content.js` loopt concept en gepubliceerde versie nu door `normalizeSite` (ontbrekende blokken = de standaard, zoals de shop zelf al deed). Regressietest in `shop-content.test.js`. Geen migratie.

## 1.11.6

Inkoop als eigen kopje in de zijbalk. Geen migratie.

- **Zijbalk**: nieuwe groep *Inkoop* (`navGroup: 'inkoop'`) met Bestelvoorstel, Inkooporders, Leveranciers en Mutaties. Het zijn tabbladen van Artikelen: de modules wijzen met een #-adres (`artikelen/#orders`) naar het tabblad; `currentId` in `shared/sidebar.js` markeert het open tabblad (de module zonder #-adres is de terugval) en tekent opnieuw bij `hashchange` en `AquatechNav.refresh()` (aangeroepen door `showTab`).
- `partOf: 'voorraad'` in `modules.js`: de vier regels volgen de module Artikelen (uit = ook weg) en staan niet apart in Beheer > Modules. Voor rollen zonder zijbalk zijn het extra tegels.
- **Bestelvoorstel** is nu een tabblad op het scherm (per leverancier, met onderweg en bedrag) met knoppen *Concept-orders maken* (stond bij Inkooporders) en *Excel-export* (stond in het Voorraad-overzicht).
- Met de zijbalk zijn de tabbladen Mutaties, Bestelvoorstel, Leveranciers en Inkooporders in Artikelen verborgen (`data-purchasing`); zonder zijbalk blijven ze.
- Test: de href-controle in `server.test.js` staat een #-adres toe; nieuwe tests voor de groep en de markering.

## 1.11.5

Verpakkingseenheden per artikel, deel B: winkelwagen en bestelling (punt 1). Geen migratie.

- **Winkelwagen**: een verpakking staat in de wagen als `CODE@PAL` (cookie en formulieren ongewijzigd). `priceCart` zoekt de verpakking op (één query voor de hele wagen), rekent de eigen prijs (zakelijk: zakelijke prijs; leeg = factor × stukprijs), toont de regel als "Klinker – Pallet (144 st)" met eenheid *Pallet* en laat een verpakking die uit staat of voor deze klantcategorie verborgen is (`visibleFor`) als "niet meer te koop" zien. Groothandelsvoorwaarden gelden alleen voor de basiseenheid.
- **Beschikbaarheid** = hele verpakkingen (`floor(voorraad / factor)`); staan stuks en een pallet van hetzelfde artikel samen in de wagen, dan moet de voorraad voor alles samen genoeg zijn.
- **Bestelling**: de orderregel houdt aantal verpakkingen en prijs per verpakking (`stockPer` = factor, `baseCode`); reserveren, controleren en afboeken gaan in de basiseenheid, per artikel samengevoegd (`stockLinesOf`). Retour: terugboeken in de basiseenheid; margerapportage telt de basiseenheid; de rapportage voegt regels van hetzelfde artikel samen (één afboeking, kosten één keer); de factuurregel krijgt aantal en prijs per verpakking en de omzetgroep van het artikel. Nog niet: keuze van een verpakking op de productpagina (volgt met de kaartenaanpassing van punt 33).

## 1.11.4

Leveranciersdocument inlezen en direct inboeken (punt 17 van bundel F, deel 4). Migratie 64.

- **Inlezen** (`POST /api/purchase-orders/read`, `artikelen/order-read-route.js`, `order-reader.js`, recht `voorraad`): een PDF of foto (JPEG, PNG, WebP, max. 8 MB) van een offerte, orderbevestiging, pakbon of factuur gaat naar de AI van de omgeving (eigen sleutel, `aiEnabled`, dagmaximum `aiDailyLimit`, uurlimiet per bezoeker) en komt terug als leverancier, documentnummer, datum en regels. De route schrijft niets. Verbruik staat in Beheer > AI-kosten onder `inkoop_inlezen`.
- **Koppelen** (`order-matching.js`, zuivere functies): leverancier op naam; regels op artikelnummer van de leverancier, artikelcode, exacte omschrijving en daarna gelijkenis (alleen een voorstel).
- **Inboeken**: `POST /api/purchase-orders` met `receiveNow: true` maakt de order en boekt alles meteen in (alles of niets, via `receiveRows`). Veld `supplierReference` (migratie 64, referentie van de leverancier) en per regel `supplierSku`; met `rememberSkus: true` worden de artikelnummers bij de artikelen onthouden (`suppliers.rememberSku`).
- `translateApiError` uit `plan-analyzer.js` wordt hergebruikt voor de foutmeldingen van de AI-dienst.
- Scherm: knop Inlezen uit document in Inkooporders; gekoppelde regels staan op de order, de rest is te koppelen of weg te laten; knoppen Bewaren (concept) en Bewaren en inboeken.
- Tests: `order-reading.test.js` en `purchase-orders.test.js`.

## 1.11.3

Fix: het formulier *AI-koppeling (Claude en ChatGPT)* stond in Beheer onder *Artikelen: etiketten*. Het formulier stond niet in de lijst `SETTINGS_FORMS` van `beheer/indeling.js`, dus het werd bij elke sectie van Instellingen getoond. Het heeft nu een eigen sectie *AI-koppeling (MCP)* onder Koppelingen; bij Etiketten staan alleen nog de etiketsjablonen. Geen migratie.

## 1.11.2

Verpakkingseenheden per artikel (punt 1, deel A: opslag en artikelscherm; de winkel volgt in deel B). Migratie 63: tabel `item_packagings`.

- **Verpakkingen** (`artikelen/packagings.js`, recht `voorraad`): naast de basiseenheid kan een artikel in een doos of pallet worden verkocht. Een verpakking heeft een korte code (bijvoorbeeld `PAL`, uniek per artikel), een naam, het aantal basiseenheden (`factor`, heel getal vanaf 2), een eigen prijs en zakelijke prijs (excl. btw; leeg = aantal × de prijs van het artikel), een eigen EAN en een doelgroep (*iedereen*, *zakelijk*, *groothandel*; `visibleFor`). De voorraad blijft in de basiseenheid. Hoogstens tien per artikel.
- `GET|PUT /api/stock/items/:id/packagings` (de lijst wordt in zijn geheel vervangen, alles of niets). De EAN is uniek binnen de organisatie over artikelen én verpakkingen heen (409 met de artikelcode); een hoofdartikel heeft geen verpakkingen (ze verdwijnen zodra een artikel een hoofdartikel wordt of wordt verwijderd). Audit `artikel_verpakkingen_gewijzigd`.
- Artikel openen → blok *Verpakkingen*.
- Testdata: Straatzand heeft een pallet (zakelijk) en een duo-pak.

## 1.11.1

Etiketten met streepjescode (item 20). Migratie 62: kolom `stock_items.ean` met unieke index `(tenant_id, ean)` (alleen gevuld).

- **EAN per artikel**: veld *EAN* in het artikelformulier (nieuw en bewerken). De server maakt de invoer schoon (spaties en streepjes eruit, UPC-A met 12 cijfers wordt EAN-13), accepteert alleen 8 of 13 cijfers met een kloppend controlecijfer en weigert een EAN die al bij een ander artikel van de organisatie hoort (409, met de artikelcode). Niet op een hoofdartikel met varianten (die hebben elk een eigen EAN).
- **Streepjescodes** in `frontend/shared/barcode.js` (UMD, zonder afhankelijkheden): EAN-13, EAN-8 en Code 128 (set B, en set C voor reeksen cijfers). De uitkomsten zijn nagekeken met een scanner-decoder en staan als vaste waarden in de test.
- **Etiketten-PDF** (`artikelen/labels.js`): `POST /api/stock/labels` {template, items:[{id, qty}]} maakt een PDF met één etiket per pagina op precies het formaat van het sjabloon, zodat een labelprinter (Zebra) via het gewone afdrukvenster print (geen ZPL). Op het etiket: omschrijving, artikelcode, prijs (incl. of excl. btw) en de streepjescode: de EAN, zonder EAN de artikelcode als Code 128 (of per sjabloon *alleen EAN* / *altijd de artikelcode*). Strepen nooit smaller dan 0,19 mm; past de code niet, dan een duidelijke melding. Recht `voorraad`, hoogstens 500 etiketten en 200 artikelen per keer, 120 PDF's per uur per gebruiker, audit `etiketten_afgedrukt`.
- **Sjablonen** in Beheer → Instellingen → *Artikelen: etiketten* (instelling `labelTemplates`, per omgeving, hoogstens tien): naam, breedte en hoogte (15-150 mm), soort streepjescode, welke gegevens erop staan en het standaardsjabloon. Standaard: Zebra 57 × 32 mm en 102 × 51 mm. `GET /api/stock/label-templates` (recht `voorraad`).
- Artikel openen → blok *Etiketten*: sjabloon en aantal kiezen, met een voorbeeld van de streepjescode; de PDF opent in een nieuw tabblad.
- `createPdf` (verkoop/pdf.js) kent nu een eigen paginaformaat (`pageSize`).
- Testdata: het artikel Straatzand heeft een EAN.

## 1.11.0

Inkooporders (punt 17 van bundel F, deel 3). Migratie 61.

- **Inkooporders** (tabellen `purchase_orders` en `purchase_order_lines`, `artikelen/purchase-orders.js`, recht `voorraad`): een bestelling bij één leverancier met regels (momentopname van code, naam, eenheid, artikelnummer van de leverancier, aantal, inkoopprijs). Nummer `IO<jaar>-0001` per omgeving. Status concept, besteld, deels ontvangen, ontvangen, geannuleerd; alleen een concept is te wijzigen of weg te gooien, een bestelde order zonder ontvangst is te annuleren, een deels ontvangen order is af te sluiten (wat nog niet is geleverd vervalt). De prijs komt uit de koppeling van de leverancier, anders uit het artikel; een eigen prijs gaat voor.
- **Ontvangen** boekt per regel de voorraad bij via `stock.book` (soort ontvangst, bron `inkoop:<nummer>`) met de inkoopprijs van de regel, dus de FIFO-lagen volgen. Alles of niets: eerst wordt alles gecontroleerd, dan geboekt. Meer ontvangen dan besteld mag.
- **Onderweg** (`incomingByItem`): wat nog niet is ontvangen van orders in concept, besteld of deels ontvangen telt mee in het bestelvoorstel (`incoming` per regel), zodat niets dubbel wordt besteld. `POST /api/purchase-orders/from-proposal` maakt per voorkeursleverancier een concept-order uit het bestelvoorstel; een tweede klik maakt niets dubbel.
- Routes: `GET|POST /api/purchase-orders`, `GET|PUT|DELETE /api/purchase-orders/:id`, `POST .../place|receive|close|cancel`, `GET /api/purchase-orders/incoming`. Een leverancier of artikel op een order wordt bij verwijderen gearchiveerd.
- Scherm: tabblad Inkooporders in Artikelen (lijst met statusfilter, order maken en wijzigen, bestellen, ontvangst boeken, Excel voor de leverancier, Excel van de lijst met een overzicht per leverancier, order uit het bestelvoorstel).
- Testdata: drie orders (concept, besteld, deels ontvangen). Tests: `purchase-orders.test.js` en queries (vast aantal queries voor leveranciers en orders).

## 1.10.9

Bestelvoorstel per leverancier (punt 17 van bundel F, deel 2). Geen migratie.

- `stock.reorderProposal` gebruikt de voorkeursleverancier van het artikel: de te bestellen hoeveelheid wordt naar boven afgerond op de bestelhoeveelheid, de eigen inkoopprijs van de leverancier gaat voor die van het artikel, en elke regel krijgt leverancier en artikelnummer. Het antwoord heeft ook `suppliers` (aantal regels en bedrag per leverancier, zonder leverancier onderaan). Een gearchiveerde leverancier telt niet mee.
- Excel van het bestelvoorstel: kolommen Leverancier en Art.nr. leverancier, regels gegroepeerd per leverancier en een tabblad Per leverancier.
- Tests: `suppliers.test.js` (bestelvoorstel met bestelhoeveelheid, eigen prijs, archiveren) en `stock.test.js`.

## 1.10.8

Leveranciers (punt 17 van bundel F, deel 1). Migratie 59.

- **Leveranciers** (tabel `suppliers`, naam uniek per organisatie zonder hoofdletters, contactgegevens, archiveren) in Artikelen > Leveranciers (`/api/suppliers`, recht `voorraad`). Een leverancier die artikelen levert wordt bij verwijderen gearchiveerd, anders echt verwijderd.
- **Leveranciers per artikel** (tabel `item_suppliers`): artikelnummer van de leverancier, eigen inkoopprijs (leeg = die van het artikel), bestelhoeveelheid (bestellen in veelvouden) en één voorkeursleverancier (`GET|PUT /api/stock/items/:id/suppliers`). Een hoofdartikel heeft geen eigen leverancier; de koppelingen verdwijnen met het artikel.
- Testdata: twee leveranciers met koppelingen aan de testartikelen.
- Tests: `suppliers.test.js` (invoer, routes, archiveren, hoofdartikel, rechten, andere organisatie).
- Vervolg: bestelvoorstel per leverancier, inkooporders met PDF-inlezen en inboeken.

## 1.10.7

AI-koppeling: leesfuncties voor de medewerker (item 31). Geen migratie.

- Nieuwe tools: `klant_details` (klantgroep, groothandelskorting, betaaltermijn met bron, documenttaal, contact; openstaand bedrag alleen met recht `facturen`, recente offertes en werkorders alleen met dat recht), `prijs_voor_klant` (offerteprijs en webshopprijs voor de klant via `priceCart`: zakelijke prijs, staffel- en groothandelskorting, plus beschikbare voorraad), `status_opvragen` (offerte, werkorder, factuur of webshopbestelling op nummer; per soort het recht van de module) en `openstaande_debiteuren` (definitieve, onbetaalde facturen per klant, met bedrag over de vervaldatum; max. 60× per uur per gebruiker).
- Limieten: `klant_details`, `prijs_voor_klant` en `status_opvragen` samen 300 per uur per gebruiker (over al zijn koppelingen), `openstaande_debiteuren` 60 per uur.
- Nieuwe toestemmingen `status.lezen` en `facturen.lezen`; een tool kan nu meer toestemmingen tegelijk vragen (`prijs_voor_klant`: artikelen én klanten lezen). Bestaande koppelingen krijgen de nieuwe toestemmingen pas na opnieuw koppelen.
- Opvragingen in `mcp/mcp-lookups.js`: alleen de nodige kolommen, altijd met `tenant_id`, op de unieke index `(tenant_id, number)`. Openstaande debiteuren telt de database per debiteur op (`GROUP BY`, altijd alle facturen); alleen van de getoonde debiteuren komen de facturen mee. Het openstaande bedrag op de klantkaart telt de database ook volledig op. Werkorders bij een offertestatus alleen met recht `werkorders`. Per debiteur komen hoogstens tien facturen mee (`ROW_NUMBER`, `facturenGetoond`); totalen en aantallen gelden altijd voor alle debiteuren, ook met `alleenTeLaat`.
- Test: een medewerker die klant wordt terwijl het toestemmingsscherm openstaat, kan daarna niet meer toestaan (403).
- Handleiding in Beheer en Mijn profiel met voorbeeldvragen; DOCS.md noemt de nieuwe tools en de groene status *Markeer als gecontroleerd*.

## 1.10.6

Kortingsregel op offerte en factuur (punt 14 van bundel A). Geen migratie: de velden staan in de offerte- en factuurgegevens.

- **Korting op het geheel** kan nu een percentage of een vast bedrag (excl. btw) zijn, met een bijschrift (max. 120 tekens) dat op het document naast het kortingsbedrag staat (`discountType`, `discountPct`, `discountAmount`, `discountNote`). Een vast bedrag wordt nooit hoger dan het subtotaal en wordt naar rato over de btw-tarieven verdeeld, net als een percentage.
- Offerte-editor en factuurscherm: keuze *percentage* of *vast bedrag* met het bijbehorende veld en het bijschrift. Het bijschrift staat op de offerte (document, klantpagina, Excel), de factuur (scherm, pdf) en in de nacalculatie.
- De factuur uit een werkorder neemt de korting van de offerte over; een creditfactuur draait het bedrag mee (negatief). Visma krijgt de korting per regel als fractie van het subtotaal.
- Nacalculatie: een vast bedrag geldt in zijn geheel (begroot en werkelijk), een percentage schaalt met het werkelijke subtotaal.
- Tests: `discount-line.test.js` (kern, afkappen, opschonen, creditfactuur, overname, nacalculatie, Visma, API en klantpagina).

## 1.10.5

Concept-offerte: duidelijker controleren van regels waar de AI over twijfelt. Geen migratie.

- De knop bij een twijfelnotitie heet nu *✓ Markeer als gecontroleerd* en ziet eruit als een echte knop (groene rand). Na het klikken blijft de notitie staan met een groene status *✓ Gecontroleerd* en een knop *Ongedaan maken*; een melding bevestigt de actie. Voorheen verdween de notitie zonder spoor.
- Regel krijgt `noteChecked` (`QuoteCore.sanitizeLine`, alleen met een notitie). `forCustomer` laat `note` en `noteChecked` weg: de klant ziet geen van beide.
- Op een smal scherm staat de knop onder de notitie.

## 1.10.4

Interne notitie per offerte (punt 9 van bundel A). Geen migratie: de notitie staat in de offertegegevens (`data.internalNote`, maximaal 2000 tekens).

- **Offerte**: blok *Interne notitie* onder de voorwaarden. De notitie staat nooit op het document, de pdf/afdruk, de Excel, de mail of de openbare link en ontbreekt in alles wat de klant van de offerte ziet (`forCustomer` in quotes.js haalt hem weg, ook in het portaal).
- **Werkorder**: bij *Werkorder maken* wordt de notitie overgenomen in `data.internalNote` (blok *Interne notitie* in de werkorder, aanpasbaar, alleen voor medewerkers). De klant ziet hem niet in het portaal en hij gaat niet mee bij uitbesteden (`handoverOf` neemt alleen genoemde velden over).
- Een kopie van een offerte neemt de notitie mee; een factuur krijgt hem niet.
- Het akkoordbewijs (`acceptance.contentHash`) wordt berekend over de gegevens zonder interne notities (offerte en regels), zodat de interne notities er niet in doorwerken (`withoutInternalNotes` in quotes.js, gedeeld met `forCustomer`). De hash blijft een hash van de volledige offerte, ook van regelprijzen die de klant bij de opmaak *totaal per onderdeel* niet ziet.
- Tests: `internal-note.test.js` (kern, opslaan en lezen, portaal, openbare link, werkorder, klantportaal-werkorder).

## 1.10.3

AI-koppeling: handleiding en extra rechtentest (vervolg op punt 28). Geen migratie.

- **Handleiding** bij Beheer > Instellingen > AI-koppeling en in Mijn profiel: stap voor stap koppelen in Claude (Connectors) en ChatGPT (ontwikkelaarsmodus, connector met OAuth), met een voorbeeldzin. Knop *Kopiëren* bij het adres in Beheer; het adres komt van de server (het webadres uit Beheer als dat is ingevuld).
- **Alleen intern**: een klant (rol van het soort klant of gast) kan niet koppelen, ziet het blok in Mijn profiel niet (`/api/account/connections` geeft 403 `internal_only`) en een toestemming van een account dat klant wordt vervalt bij het eerste verzoek.
- Test: een rolwijziging beperkt een al gekoppelde app direct tot wat de gebruiker in de app mag (planner: alleen artikelen zoeken). Wordt het account klant, dan werkt geen enkele koppeling meer: een koppeling die dan wordt gebruikt, wordt direct ingetrokken, en oude koppelingen kan hij zelf intrekken. Na terugzetten naar installateur moet hij de ingetrokken koppelingen opnieuw maken.
- **Intrekken als klant**: een account dat klant is geworden kan een eigen oude koppeling nog intrekken (`DELETE /api/account/connections/:id`); de lijst blijft verborgen.
- Test: de controle op een vervalste CSRF-code in het toestemmingsscherm veranderde soms niets (als de code al met een x begon) en faalde daardoor af en toe; nu wijzigt hij altijd een teken.

## 1.10.2

Documenttaal per klant (punt 13 van bundel A): offertes, facturen en de mails daarover in het Nederlands of het Engels. Migratie 58 (`users.document_language`, standaard `nl`).

- **Klantkaart**: veld *Documenttaal* (Nederlands of English), ook bij `POST`/`PATCH /api/customers` (recht `klanten`, audit `documenttaal`). `GET /api/quote-customers` geeft `documentLanguage` mee.
- **Offerte**: `data.language` (`nl`|`en`, `QuoteCore.sanitize`), keuzelijst *Documenttaal* in de editor; een klantkeuze vult de taal van de klant in. Afdruk/PDF, klantweergave en de openbare offertepagina (statusbalk, akkoordformulier, datums en bedragen in de landnotatie) staan in die taal, evenals het conceptbericht bij het versturen en de bevestigingsmail na het akkoord. De mails aan het bedrijf zelf blijven Nederlands.
- **Factuur**: `data.language` komt van de offerte (en blijft bij een creditfactuur); de factuur-PDF (tabelkoppen, totalen, datums, bedragen, paginanummers, bestandsnaam) en het mailconcept staan in die taal. Bij een Engels document gebruikt de betaaltekst de Engelse standaardtekst en het mailconcept de Engelse standaardtekst (de ingestelde teksten in Facturen > Instellingen zijn Nederlands).
- Vertaalteksten staan in `shared/doc-text.js` (`DocText`, gedeeld door browser en server; test bewaakt dat beide talen dezelfde sleutels en invulvelden hebben).
- Bewust niet: webshopfacturen en facturen zonder offerte blijven Nederlands; het schermbeheer (editor, lijsten) blijft Nederlands.
- Tests: `document-language.test.js` (vertaaltabel, weergave, akkoord, klantkaart met rechten en organisaties, factuur-PDF en -mail).

## 1.10.1

AI-koppeling: een concept-offerte maken vanuit Claude of ChatGPT (punt 28). Migratie 57 (`oauth_grants`).

- **MCP-server** op `POST /app/mcp` (Model Context Protocol, Streamable HTTP zonder sessies, JSON-antwoorden; protocolversies 2024-11-05 t/m 2025-11-25). Tools: `zoek_klant`, `maak_klant` (particulier, adres via PDOK), `zoek_artikelen` (prijzen uit AquaTech) en `maak_concept_offerte`. De AI kan alleen een **concept** maken: versturen, accorderen of wijzigen kan niet. Twijfel bij een artikel of aantal, een onbekende code, een afwijkende genoemde prijs of een ontbrekende verkoopprijs geeft een **notitie per regel** (`line.note`, nooit naar de klant), die de medewerker in de offerte-editor ziet en met *Gecontroleerd* wegklikt.
- **OAuth 2.1 per gebruiker** (`mcp/oauth-server.js`, `mcp/oauth-grants.js`): metadata volgens RFC 8414 en RFC 9728, dynamische registratie (RFC 7591, ondertekende client-id zonder tabel), PKCE S256 verplicht, alleen redirects naar claude.ai, claude.com, chatgpt.com, chat.openai.com of loopback. Toestemmingsscherm met de gevraagde rechten (`klanten.lezen`, `klanten.aanmaken`, `artikelen.lezen`, `offertes.concept`), begrensd tot de rechten van de rol. Codes, toegangs- en vernieuwingstokens alleen als SHA-256; toegangstoken 1 uur, vernieuwingstoken 30 dagen met rotatie en hergebruikdetectie, toestemming hoogstens 90 dagen, gebonden aan het wachtwoord (wijzigen = ingetrokken). Intrekken via RFC 7009 en in Mijn profiel. Issuer, resource en de offertelink komen uit het webadres in Beheer > Webshop > Betalen zodra dat is ingevuld, anders uit de (gecontroleerde) Host-kop.
- **Per omgeving aan/uit**: instelling `aiConnector` (Beheer > Instellingen > AI-koppeling, standaard uit). Elk verzoek werkt als de gebruiker in de omgeving van de toestemming, met de rechten van zijn rol op dat moment en RLS op de eigen organisatie.
- **Mijn profiel**: blok *AI-koppeling* met het adres om toe te voegen en de gekoppelde apps (laatst gebruikt, intrekken).
- Limieten: registratie 30 per uur, token 120 per 15 minuten (per bezoeker), MCP 120 per minuut per toestemming, klanten aanmaken 30 per uur, concept-offertes 30 per uur en 150 per dag. Audit `ai_koppeling_*` en `offerte_concept_via_ai`.
- Tests: `mcp.test.js` (ontdekking, registratie, volledige stroom, PKCE/redirect/eenmalige code, gelijktijdig inwisselen, rotatie, CSRF op het toestemmingsscherm, rechten, tenant-isolatie, intrekken, Origin/versie/batch).

## 1.10.0

Betaaltermijn per klant (punt 11 van bundel A). Migratie 56 (`users.payment_days`, leeg = standaard).

- **Klantkaart**: veld *Betaaltermijn (dagen)* bij de gegevens (0 tot 365, leeg = de standaard uit Facturen > Instellingen, die als hulptekst staat). Ook bij `POST /api/customers` en `PATCH /api/customers/:id` (recht `klanten`; audit `betaaltermijn`). `GET /api/customers/:id` geeft `defaultPaymentDays` mee.
- **Offerte**: veld *Betaaltermijn (dagen)* naast datum en geldigheid; een klantkeuze vult de termijn van de klant in (of de standaard, via `GET /api/quote-customers`). De server vult de standaard in als het veld leeg is, zodat elke opgeslagen offerte een vaste termijn heeft. De termijn staat op de offerte (afdruk, klantweergave) en wordt bij het akkoord vastgelegd in het bewijs (`acceptance.paymentDays`, ook onderdeel van de inhoudshash); na het akkoord ligt hij vast.
- **Factuur**: een factuur uit een werkorder neemt de termijn van de offerte over (`data.paymentDays`) voor de vervaldatum en de tekst *binnen {dagen} dagen*; een gewijzigde factuurdatum rekent met dezelfde termijn door.
- Webshopfacturen en losse facturen houden de standaardtermijn.
- Tests: `payment-terms.test.js` (kern, klantkaart, klantkeuze en standaard, akkoord, factuur).

## 1.9.9

Offerte: nieuwe klant vanuit de offerte en btw verlegd naar een EU-klant (punt 12 van bundel A). Geen migratie.

- **Nieuwe klant** in de offerte-editor (knop onder het zoekveld, recht `klanten`): soort (Particulier/Zakelijk met KvK en btw), naam, e-mail, telefoon en adres via postcode en huisnummer. *Klant opslaan en kiezen* maakt de klant aan en koppelt hem meteen aan de offerte. Hergebruikt `POST /api/customers`; het adres staat als tekst, `AddressLookup.mirror` is nu gedeeld door de klantenpagina en de offerte.
- **Btw verlegd** (vinkje bij de klantgegevens): met een btw-nummer uit een ander EU-land gaat de hele offerte zonder btw (rijen, totaal, PDF/afdruk, Excel, klantweergave, lijst). De server controleert het nummer bij VIES en bewaart de uitkomst, het tijdstip, het consultatienummer en de naam als bewijs op de offerte; een nummer dat VIES ongeldig noemt wordt niet opgeslagen (409), een onbereikbaar VIES wordt als zodanig vastgelegd en dan blijft het gewone btw-tarief gelden: de btw wordt alleen verlegd (offerte, afdruk, Excel, factuur) zolang VIES het nummer geldig noemt. Bewijs uit de browser wordt altijd overschreven. Bij een volgende opslag met hetzelfde nummer wordt het bewaarde bewijs hergebruikt (geen nieuwe VIES-vraag per autosave; een onbereikbaar-uitkomst een minuut), een geaccordeerde of onbekende offerte vraagt niets aan VIES, en nieuwe VIES-vragen zijn beperkt tot 20 per minuut per gebruiker. Een adres met een Nederlandse postcode blijft altijd bij PDOK gecontroleerd.
- Het adres van de klant is vrij te typen (het ligt buiten PDOK) alleen als VIES het btw-nummer geldig noemt; bij een ongeldig, ontbrekend of onbereikbaar antwoord blijft de PDOK-controle gelden. Het btw-nummer van de gekozen klant wordt alvast ingevuld.
- Een factuur uit een werkorder met zo'n offerte krijgt 0% btw, het btw-nummer van de afnemer en de vermelding *BTW verlegd naar afnemer*.
- Beperking: een buitenlandse klant als klantrecord kan nog niet (KvK-nummer en PDOK-adres zijn verplicht); op de offerte zelf kan het wel.
- Tests: kern (totalen, opschonen), API met nagebootste VIES (geldig, ongeldig, NL, onbereikbaar, vals bewijs, adres), factuur uit offerte.

## 1.9.8

Offerte: klantkeuze bovenaan het klantblok met automatisch invullen (punt 4 van bundel A). Geen migratie.

- **Klantkeuze** in de offerte-editor: zoekveld *Klant uit de klantenlijst* (naam, bedrijf, e-mail, telefoon, adres) bovenaan het blok Klant. Een keuze koppelt de offerte aan het klantaccount én vult naam/bedrijf, T.a.v., adres, e-mail en telefoon in; *Ontkoppelen* haalt alleen de koppeling weg. Vervangt de keuzelijst *Klantaccount* onderaan.
- `GET /api/quote-customers?q=` zoekt nu op de server (hoogstens 20, alleen actieve klanten, met `companyName`, `email`, `phone`, `address`) in plaats van de hele klantenlijst mee te laden: werkt ook bij honderden klanten. `store.listCustomerPage` kreeg `activeOnly`. Toegang blijft recht `offertes`; de koppeling zelf wordt nog steeds tegen de lijst klanten van de organisatie gecontroleerd.
- Tests: zoeken, velden, begrenzing op 20 en uitgeschakelde klanten (`customers.test.js`, `quotes.test.js`).
- **Formulier Nieuwe klant en klantkaart opgeruimd**: het adres is nu gewone tekst (met een korte aanwijzing zolang er geen is) in plaats van een grijs invulveld; velden gegroepeerd (soort/naam/e-mail/telefoon, dan bedrijfsgegevens, dan postcode/huisnr./toev.), KvK en btw verdwijnen echt bij Particulier (`[hidden]` in `layout.css`), het postcodeblok loopt mee met het raster en de hulptekst is korter.

## 1.9.7

Klantenpagina (punt 5) en een opgeruimd formulier Gebruiker toevoegen (punt 25). Eerste PR van bundel A. Migratie 55: index op facturen per klant.

- **Module Klanten** (`frontend/klanten/`, recht `klanten`: standaard beheerder en installateur, daarmee ook aan eigen rollen te geven): lijst met zoeken (naam, bedrijf, e-mail, telefoon, adres, gebruikersnaam; meerdere woorden = en), filter (particulier, zakelijk, groothandel, open aanvraag), 50 per pagina en Excel-export. Een klant is een account met een rol van het soort klant (dezelfde accounts als webshop en portaal); `GET|POST /api/customers`, `GET|PATCH /api/customers/:id`, `POST /api/customers/:id/invite` in `verkoop/customers.js`.
- **Klant zonder inlog**: `store.createCustomer` maakt een account zonder wachtwoord (niemand kan erop inloggen); gebruikersnaam = het e-mailadres als dat past, anders `klant-<8 hex>`. Het adres (kolom `users.address`, migratie 54, in `MIGRATIONS` én `PG_MIGRATIONS`) wordt met `requireVerifiedAddress` tegen PDOK gecontroleerd, zoals bij offertes en facturen.
- **Uitnodigen**: de bestaande wachtwoordlink van de webshop, nu met zeven dagen geldigheid (`tokens.issue(…, { ttlMs })`, geen migratie) en een eigen mailtekst. Alleen voor klanten van de hoofdorganisatie met een ingestelde mailserver en webadres van de shop; anders een duidelijke melding (ook in de klantkaart) en de klant wordt wel aangemaakt.
- **Klantkaart**: gegevens, klantgroep/bedrijfsgegevens/groothandel (wijzigen van klantgroep en groothandel alleen door een beheerder, 403 voor anderen; open aanvraag goedkeuren/afwijzen), toegang, en de offertes, werkorders en facturen van de klant (alleen de soorten waar de aanvrager recht op heeft; elk hoogstens 100, nieuwste eerst), met directe links.
- **Beheer > Gebruikers**: kolom Klantgroep en de bijbehorende knoppen/prompts weg (verhuisd naar de klantkaart; knop *Klantkaart* bij klanten), formulier Gebruiker toevoegen in vier kolommen met de roluitleg ingeklapt.
- **Gedeelde indeling** `frontend/shared/layout.css` (`.form-grid`, `.card-grid`, `.card`): labels boven de velden, kaarten in een rij even hoog, knoppen onderaan; vastgelegd als UI-standaard in CLAUDE.md.
- Testdata: klanten hebben nu een adres en er is een klant zonder inlog.
- Prestaties: lijst = 2 queries (totaal + pagina, `tenant_id`-filter en bestaande indexen), klantkaart = 4 (klant + offertes + werkorders + facturen, `quotes_customer`/`invoices_wo`-indexen), nooit per klant een query; bewaakt in `queries.test.js`.
- Tests: `customers.test.js` (aanmaken, zoeken, paginering, rechten 403, andere organisatie 404, medewerker is geen klant, wijzigen, klantkaart, uitnodiging met en zonder mailserver), sidebar, queries; ook tegen PostgreSQL.

## 1.9.6

Opruiming na de CodeRabbit-inhaalreview van #149 t/m #158 (13 bevindingen: 2 major, 11 minor). Eén bevinding (kleurcontrole van knoptekst) is bewust niet overgenomen, zie onder.

- **Visma verbreken** (major): `disconnect` zet de omgeving eerst op *verbreken bezig* (geen nieuwe verzending, geen tokenvernieuwing), wacht op een lopende doorstuurronde en trekt dan pas het token in; de blokkade gaat er altijd af (ook bij een fout).
- **Visma pauze en onderdelen** (minor): `pushInvoice` controleert de actuele bediening opnieuw vlak vóór het aanmaken van de factuur (ook na `pushDebtor`); een pauze of uitgezet onderdeel is geen fout van de factuur (geen `visma_error`, geen logregel). `paused` in `PUT /api/visma/controls` verandert alleen bij een echte boolean.
- **Visma-logboek** (minor): `PUT /api/visma/app` schrijft een logregel met alleen de namen van de gewijzigde velden (nooit waarden of het secret), handmatig, met naam. **Migratie 53**: index `(tenant_id, last_at)` voor de bewaartermijn-opschoning (in `MIGRATIONS` en `PG_MIGRATIONS`).
- **Kleuren** (minor): een account dat alleen in een testomgeving woont, wijzigt het live-thema niet meer (403, `canEdit: false`); een livebeheerder kan het vanuit de testomgeving nog wel. De melding bij *Eigen thema verwijderen* noemt nu dat het eigen thema weg is, niet dat de standaardkleuren zijn teruggezet.
- **Frontend** (minor): wijzigingen van de Visma-bediening gaan één voor één naar de server (een ouder antwoord zet de vinkjes niet terug); nieuwe CSS in Beheer > Kleuren gebruikt `--at-*`-variabelen (`--at-ok`, `--at-warn`, `--at-preview-bg`, `--at-ink-strong` erbij in brand.css); de knop *Naar het beheer* in de shopkop heeft een donkerder groen (5,1:1 met wit) en wordt navy bij hover.
- **Mollie** (minor): bij een mislukte betaalstart komt ook de onderliggende oorzaak in het log (niet naar de klant).
- **README**: Visma staat onder Facturen → Visma, niet onder Beheer → Instellingen.
- **Niet overgenomen**: de opmerking over het minimale contrast van knoptekst (3:1 voor vette tekst) in de kleurcontrole. Het standaardgroen van de huisstijl haalt zelf maar 3,99:1; de grens verhogen zou de huisstijl afkeuren en bestaande thema's ongeldig maken. Dat is een keuze van Daniël.
- **CodeRabbit uitgeschakeld** (besluit Daniël): `.coderabbit.yaml`, de workflows voor aanvraag, inhaalreview en bevindingenissues en hun scripts en tests zijn verwijderd. Alleen de Claude-reviews zijn nog verplicht; vóór go-live volgt eenmalig een handmatige deep scan.
- Tests: pauze/onderdeel tijdens het aanmaken van de klant, niet-booleaanse `paused`, verbreken met vasthoudend intrekken, logregel bij app-wijziging, testaccount en thema; ook tegen PostgreSQL.

## 1.9.5

Visma-koppeling beheersbaar (Facturen → Visma). Deel 2 van 2 van punt 30; deel 1 (overzicht en logboek) was 1.9.4.

- **Pauzeren/hervatten** (`visma.paused`): niets gaat naar Visma, niet automatisch, niet met *Nu doorsturen* en niet met de knop op een factuur (409 `paused`).
- **Onderdelen aan/uit** (`visma.parts`: `invoices`, `credits`, `customers`, standaard aan): een uitgezet soort factuur blijft wachten (409 `part_off`, telt niet mee als wachtend); met *Klanten aanmaken* uit gaan alleen facturen van debiteuren die al aan een Visma-klant gekoppeld zijn nog mee; de rest wordt bij het doorsturen in bulk overgeslagen (geen herhaalde fouten, de batch blokkeert niet; de status telt ze apart als `held`) en geeft bij de factuurknop 409 `customers_off`. `PUT /api/visma/controls` (recht `facturen`), alleen echte booleans tellen; elke wijziging komt met naam in het logboek (soort *Bediening*) en het auditlog (`visma_bediening`), een ongewijzigde stand maakt geen regel.
- **Verbinding verbreken trekt het token in**: `POST /connect/revocation` bij Visma met het refresh token (best effort, `revoked` in het antwoord); lukt dat niet, dan wordt er toch lokaal verbroken en zegt het logboek en de melding dat je de toegang zelf bij Visma moet intrekken. Tokens en verbindingsgegevens worden altijd gewist.
- Geen migratie (instelling `visma` is een JSON-object). Geen extra queries op warme paden: de status telt wachtende facturen nog steeds in één query, nu met dezelfde filters als het doorsturen (`pendingFilter`).
- Tests: pauzeren (knop, factuurknop, vangnet), creditfacturen/facturen apart, klanten niet aanmaken, rechten 403, invoer, logboek, intrekken gelukt en mislukt; ook tegen PostgreSQL.

## 1.9.4

Visma-koppeling inzichtelijk: wat mag ze, wat doet ze, en een logboek (Facturen → Visma). Deel 1 van 2; de bediening (onderdelen aan/uit, pauzeren) volgt.

- **Overzicht in gewone taal**: kaart *Wat kan de koppeling?* met de toestemmingen die Visma gaf (uit het tokenantwoord, `visma.scopes`; terugval op de aangevraagde), per onderdeel (klanten, verkoop-/creditfacturen, artikelen en termijnen, administratienaam) de richting en wanneer het gebeurt, en wat de koppeling niet doet. Zuivere functie `describeConnection` in `verkoop/visma.js`, meegegeven in `GET /api/visma` (`overview`).
- **Logboek** (migratie 52, tabel `visma_log`, `verkoop/visma-log.js`): verbonden/verbroken/afgebroken aanmelding, klant aangemaakt of gekoppeld, factuur doorgestuurd of mislukt, artikelen opgehaald, mislukte vernieuwing van het token; met handmatig/automatisch en de naam van de gebruiker. `GET /api/visma/log?limit=&before=&errors=1` (recht `facturen`), keyset-paginering (nieuwste eerst, 100 per pagina), filter *Alleen fouten*.
- Een fout die zich herhaalt (zelfde onderdeel, verwijzing en melding) wordt één regel met een teller (bron, naam en tijdstip van de eerste keer blijven staan, `last_at` toont de laatste; sortering en cursor schuiven dus niet) in plaats van elke 10 minuten een nieuwe; een geslaagde leesactie binnen 30 minuten wordt niet opnieuw gelogd. Alleen korte meldingen, nooit tokens, secrets of volledige antwoorden (test bewaakt dat). Bewaartermijn = `auditRetentionDays` (onderhoud elk uur).
- Prestaties: één query per logpagina via index `(tenant_id, created_at, id)`; schrijven kost één opzoekquery op index `(tenant_id, kind, reference, created_at)` plus één insert/update, alleen bij een Visma-actie; niets op warme paden. Een fout bij het loggen stopt het doorsturen nooit.
- Tests: logopslag (samenvoegen, paginering, bewaartermijn, organisatiescheiding), API (verbinden, doorsturen, fouten, verbreken, rechten 403, andere organisatie leeg), overzicht, queriebudget; ook tegen PostgreSQL.

## 1.9.3

Kleuren en Visma-app verhuisd van Hoofdbeheer naar de organisatie zelf.

- Nieuwe sectie **Beheer > Kleuren** (groep *Organisatie & gebruikers*, `beheer/kleuren.js`): elke beheerder kiest de kleuren van de
  eigen organisatie, met contrastcontrole en voorbeeld. Het thema van de hoofdtenant blijft de standaard voor organisaties zonder
  eigen thema; een testomgeving volgt zijn live-tenant.
- API `GET|PUT /api/admin/theme` (recht `beheer`) vervangt `/api/platform/theme`. De organisatie komt uit de sessie (`homeOf(req.tenantId)`),
  een `tenantId` in de invoer wordt niet gebruikt, dus een beheerder raakt nooit een andere organisatie. Het thema van de hoofdtenant (de standaard voor alle organisaties) wijzigt bij meerdere organisaties alleen een hoofdbeheerder. Een hoofdbeheerder die het
  thema van een andere organisatie wil wijzigen, opent die organisatie via Hoofdbeheer > Openen. Audit `thema_gewijzigd` staat nu in de eigen organisatie.
- **Visma per organisatie**: de app-registratie (client ID, omgeving, secret, redirect URI) staat nu per omgeving in Facturen → Visma
  (`GET|PUT /api/visma/app`, recht `facturen`) in plaats van platformbreed in Hoofdbeheer. `vismaApp`/`vismaClientSecret` zijn `internal` + `liveOnly`;
  `createVisma` gebruikt `app(tenantId)` voor aanmelden, tokens, API-host en status. `/api/platform/visma` is weg. Bij een bestaande verbinding geeft `PUT /api/visma/app` 409 `disconnect_first` als client ID, omgeving of secret wijzigt (de tokens horen bij de oude app).
- Hoofdbeheer houdt alleen wat platformbreed is: tenants, hoofdbeheerders en Multitenancy. De knoppen *Kleuren* en *Visma* zijn weg.
- Geen databasewijziging (bestaande instellingen blijven in de tabel; in ontwikkeling, geen migratie van oude waarden), geen extra queries op warme paden.

## 1.9.2

Webshop: knop naar het beheer.

- In de kop van de shop staat voor een ingelogde medewerker of beheerder (een rol van het soort medewerker; een klant of onbekende rol niet) een groene knop *Beheer*
  naar `app/`; op de telefoon als pictogram in de kop en als regel *Naar het beheer* bovenaan het menu. Klanten en bezoekers zien
  hem niet: de server bepaalt het aan de hand van de rol (`viewer.isStaff` in shop-accounts.js), de pagina's krijgen dan
  `Cache-Control: private, no-store`.

## 1.9.1

Foutmeldingen nalopen, eindcontrole.

- Opslaan van instellingen in Offertes (mail), Facturen, Visma en Webshop: alleen een ongeldige instelling (`SettingsError`) geeft
  een 400 met de melding; een andere fout (bijvoorbeeld van de database) wordt een 500 met foutcode in plaats van een 400 met de
  interne tekst. `SettingsError` heeft een vaste `name`, omdat deze modules de klasse niet kunnen importeren (kringverwijzing met
  settings.js).

## 1.9.0

Foutmeldingen nalopen, deel 4: de webshop.

- Mollie (`MollieError` met `cause`): niet bereikbaar wordt *"Mollie is niet bereikbaar. Probeer het later opnieuw."* (bij een time-out
  *"Mollie antwoordt niet op tijd."*), zonder de technische tekst van fetch; een weigering zonder tekst noemt de status in plaats van
  `HTTP <status>`.
- Terugbetalen: een fout van Mollie staat in de melding, een andere fout (in de app) wordt *"interne fout, de oorzaak staat in het
  serverlog"* en gaat met aanroepketen naar het log. De route bewaart de oorzaak met `withCause` (debugmodus).
- Facturen en creditnota's bij webshopbestellingen en retouren: alleen een weigering van de factuuropslag (`InvoiceStepError`, zoals
  "De factuur heeft geen regels") komt letterlijk bij de bestelling of retour (`invoiceError`/`creditError`); een databasefout of
  programmeerfout niet meer (geen SQL-tekst in Beheer), wel volledig in het serverlog. De oorzaak hangt niet-opsombaar aan de
  uitkomst, zodat hij nooit mee gaat in de JSON van de retour.
- Betaling starten: een fout in de app komt met aanroepketen in het log.
- Tests: `test/webshop-errors.test.js`.

## 1.8.9

Foutmeldingen nalopen, deel 3: de frontend.

- `AquatechCommon.statusMessage(status)` in `shared/common.js`: een leesbare melding per HTTP-status (401 niet ingelogd,
  403 geen rechten, 404 niet gevonden, 409 intussen gewijzigd, 413 te groot, 429 te veel verzoeken, 502/503/504 even niet
  bereikbaar, overige 500+ fout op de server). Vervangt overal `HTTP <status>` als terugval wanneer de server geen `message` geeft.
- Een netwerkfout (`TypeError` van fetch) wordt in de gedeelde fetch-hulp *"Geen verbinding met de server. Controleer je
  internetverbinding en probeer het opnieuw."*, met de oorspronkelijke fout als `cause`. Afbreken (`AbortError`) blijft zoals hij was.
- Onbekende API-route: 404 met `message` *"Deze API-route bestaat niet."*.
- Tests: `statusMessage` en de netwerkmelding; een test bewaakt dat er geen `HTTP ${…}`-melding meer in de frontend staat.

## 1.8.8

Naloop van de review op 1.8.7 (de fixes kwamen net na de merge).

- `mailFailure`: de herkenning van TLS/certificaat op de tekst geldt alleen bij verbindingsfouten (ETIMEDOUT, ECONNECTION,
  ESOCKET, EDNS) en bij ETLS. Een weigering door de server (EAUTH, EENVELOPE, EMESSAGE) houdt zijn eigen melding, ook als
  "TLS" of "SSL" in het antwoord staat.
- Een fout zonder SMTP-code en zonder antwoord van de server is een fout in de app (bijv. bij het opbouwen van de mail) en heet
  nu *"Versturen mislukt door een interne fout; de oorzaak staat in het serverlog."* in plaats van een mailserverfout.
- `mailFailure` logt de oorzaak zelf (`[mail] Versturen mislukt: <code> <melding>`, nooit het wachtwoord), zodat elke aanroeper
  (offerte, afspraak, factuur, webshop- en retourmail) hem in het serverlog heeft. Een TLS-fout met een eigen code van Node
  (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` enz.) krijgt de TLS-melding. De vaste melding bij onleesbare
  mailinstellingen staat één keer in mailer.js (`MAIL_SETUP_FAILED`).
- Tests: mislukte retourmail geeft een leesbare melding bij de retour; extra gevallen voor `mailFailure`.

## 1.8.7

Foutmeldingen nalopen, deel 2: e-mail en verkoop.

- Nieuw `mailFailure(error)` in `platform/mailer.js`: zet een fout van de mailserver om in een melding met de oorzaak en wat te
  controleren (inloggegevens/app-wachtwoord, server en poort, TLS/certificaat, afzender of ontvanger geweigerd, bericht geweigerd),
  met het antwoord van de mailserver erachter (zonder regeleinden, hoogstens 200 tekens). Een onbekende fout geeft geen interne
  melding meer. Gebruikt bij het versturen van offertes, afspraken, facturen, de testmail en de webshopmails (bestelling,
  verzending, retour).
- De mailroutes bewaren de volledige fout met `withCause` (debugmodus: code, commando, antwoord). Een fout bij het lezen van de
  mailinstellingen in de webshopmails komt in het serverlog in plaats van als ruwe melding bij de bestelling.
- `VismaError` krijgt een optionele oorzaak: niet bereikbaar, mislukte aanmelding (`error`/`error_description` van Visma, nooit
  tokens) en een API-fout (methode, pad zonder query, status en het begin van het antwoord). Het foutantwoord van de Visma-routes
  bewaart de oorzaak.
- Webshopbestellingen ophalen (`POST /api/invoices/shop-orders/sync`) gebruikt `respondShopError`.
- De eigen `wrapAsync`-helpers in quotes.js, invoices.js en workorders.js zijn weg: `catchAsync` (1.8.5) dekt die routes al.
- Tests: `mailFailure` per soort fout en de testmail via de API, met en zonder debugmodus (`test/mail.test.js`).

## 1.8.6

Foutmeldingen nalopen, deel 1: artikelen en de webshopkoppeling.

- `webshop/woocommerce.js`: `SourceError` krijgt een optionele oorzaak (`cause`). Niet bereikbaar, time-out, DNS, te groot en
  geen JSON bewaren de onderliggende fout; een foutstatus van de webshop leest het begin van het antwoord (hoogstens 4 kB,
  `shopReply`) als oorzaak. Bij een weigering (4xx) staat de melding van WooCommerce (zonder HTML, hoogstens 200 tekens) in de
  melding, bijv. *"De webshop antwoordt met status 400: De SKU KRAAN bestaat al."*.
- Nieuw `respondShopError(res, error, next)`: een `SourceError` gaat terug met zijn eigen status en melding (oorzaak via
  `withCause` voor de debugmodus), elke andere fout naar de foutafhandeling (500 + foutcode). Gebruikt in
  `POST /api/stock/import-shop`, `POST /api/stock/items/:id/publish` en `POST /api/admin/shop/sync`. Voorheen kwam bij
  artikelen de interne foutmelding (bijv. een databasefout) als *"shop_error"* bij de gebruiker.
- `artikelen/item-images.js`: de fouten bij het ophalen van een afbeelding bewaren hun oorzaak.
- Nieuwe test `test/shop-errors.test.js`.

## 1.8.5

Debugmodus (Beheer > Instellingen > Foutopsporing) en foutcodes bij elke onverwachte fout. Eerste deel van het nalopen van de
foutmeldingen; de modules volgen in de volgende versies.

- Nieuw `platform/error-report.js`: `createErrorReport` (middleware `attach` + laatste `handler`), `catchAsync`, `withCause`,
  `describeError`, `redact`. Elke 500 krijgt een foutcode (`errorId`, 8 tekens) in het antwoord, de melding en het serverlog
  (`[fout <code>] METHODE pad gebruiker … omgeving …`).
- Nieuwe instelling `debugMode` (bool, per omgeving, standaard uit). Aan + gebruiker met recht `beheer`: elk foutantwoord (status
  400+) als JSON krijgt een blok `debug` (status, foutsoort, verzoek, foutcode, oorzaak met naam/melding/databasecode/detail/
  constraint/tabel, plek in de code en aanroepketen binnen `src/`) en de kop `X-Aquatech-Debug: 1`. Uit, of geen beheerder: nooit
  details. Wachtwoorden in URL's, Bearer-tokens, API-sleutels (Anthropic, Mollie, WooCommerce) en `password=`/`token=`-velden gaan
  er altijd uit.
- `catchAsync` op de app en de webshoprouter: een async route die een fout gooit gaat naar de foutafhandeling in plaats van te
  blijven hangen.
- `withCause(res, error)` bewaart de oorzaak bij een eigen foutantwoord (nu bij WAN-IP, adres opzoeken en afbeeldingen overnemen).
- Frontend: `shared/common.js` toont bij een antwoord met de debugkop het paneel `shared/debug-panel.js|.css` (pas dan geladen,
  tekst via textContent, knop Kopiëren). Formulier Foutopsporing in Beheer (groep Systeem).
- Kapotte JSON en te grote verzoeken hebben een duidelijkere melding.
- Snelheid: goede antwoorden kosten niets extra (alleen bij status 400+ wordt de instelling gelezen, uit het geheugen); het paneel
  laadt alleen bij een fout met details.
- Tests: `test/debug-mode.test.js`.

## 1.8.4

Reserveoptie voor CodeRabbit: een gemergde PR zonder voltooide CodeRabbit-review wordt alsnog gereviewd.

- `.github/workflows/coderabbit-catchup.yml` + `backend/tools/coderabbit-catchup.js`: elke 6 uur (en zodra CodeRabbit klaar is) wordt gekeken
  welke gemergde PR's na `coderabbit-baseline` geen CodeRabbit-review op hun laatste commit hebben. Die krijgen het label `coderabbit-pending`
  en samen één inhaal-PR van `coderabbit/catchup` naar de baseline (cumulatieve diff, nooit mergen; master is niet het doel, dus de
  versiecontrole draait er niet op en een subnummer is niet nodig). Het verzoek `@coderabbitai review` wordt na 6 uur herhaald; na 72 uur zonder
  review komt er één issue met de vraag de review handmatig te starten.
- Is de inhaalreview klaar, dan gaan de bevindingen de issueroute in (`coderabbit-findings.js`, nu ook voor een niet-gemergde PR via
  `allowUnmerged`), verdwijnen de labels, wordt de PR gesloten en schuift de baseline op. De baseline wordt bij de eerste run op de huidige master
  gezet: eerdere merges gelden als gereviewd.
- `.coderabbit.yaml`: `coderabbit-baseline` toegevoegd aan `base_branches`.
- Tests: `test/coderabbit-catchup.test.js`.

## 1.8.2

Claude-review als eerste, verplichte controle op elke PR; CodeRabbit adviserend, zijn onopgeloste bevindingen blijven als issue bestaan.

- `.github/workflows/claude-review.yml`: jobs `Claude code review` (claude-code-action) en `Claude security review` (claude-code-security-review) op
  elke PR naar master. Vereist repository-secret `ANTHROPIC_API_KEY` (zonder sleutel falen de jobs met een duidelijke melding); optionele
  repository-variabele `CLAUDE_REVIEW_MODEL`. Bevindingen komen als opmerkingen op de PR.
- `.github/workflows/coderabbit-findings.yml` + `backend/tools/coderabbit-findings.js`: na het mergen (en elk uur, en bij een review na het
  mergen) wordt elke onopgeloste CodeRabbit-reactiedraad een issue met label `coderabbit-bevinding`; opmerkingen buiten een draad (buiten de
  diff, nitpicks) komen samen in één issue per review. Een verborgen sleutel in het issue voorkomt dubbelen, ook als het issue is gesloten.
- Tests: `test/coderabbit-findings.test.js`. Geen wijziging in de app zelf.

## 1.8.0

Multitenancy-schakelaar (Hoofdbeheer > Multitenancy), standaard uit.

- Nieuwe platforminstelling `multitenancy` (settings.js, `platform: true`; startwaarde via `MULTITENANCY`). Uit = één organisatie: alles
  draait in de hoofdtenant. Datamodel, `tenant_id` en RLS blijven ongewijzigd, aanzetten werkt dus direct.
- Uit: de organisatiecode bij het inloggen wordt genegeerd (en op de inlogpagina verborgen), omgevingen buiten de hoofdtenant en zijn
  testomgevingen doen niet mee (`inScope` in server.js: `organizationActive`, `tenantActive`, `accessibleFor`, testaccount-login,
  seizoensherinneringen), tenant aanmaken en alles op een andere tenant geeft 409 `multitenancy_off`, `/api/outsourcing` is dicht en
  de module Uitbesteden staat uit in `/api/config`. Testomgevingen van de hoofdtenant werken zoals eerder.
- Hoofdbeheer: knop Multitenancy (`GET|PUT /api/platform/multitenancy`); het formulier voor nieuwe tenants is verborgen zolang het uit
  staat. Uitzetten terwijl er andere organisaties zijn vraagt `acknowledge: true`; hun gegevens blijven staan.
- Een tenant buiten de hoofdtenant verwijderen kan alleen als multitenancy aan staat (alles op zo'n tenant geeft 409 `multitenancy_off`).
- Tests: `test/multitenancy.test.js`; bestaande tests die meerdere organisaties gebruiken draaien met `MULTITENANCY=1`.

## 1.7.9

Testomgeving en tenant verwijderen of leegmaken werkt weer, met een duidelijke melding als het toch misgaat.

- Oorzaak: "Verwijderen" en "Leegmaken" van een testomgeving gebruikten een vaste lijst tabellen (`clearData`) die sinds de webshop,
  meldingen en artikelen niet meer volledig was (`roles`, `service_requests`, `service_request_photos`, `stock_merges`,
  `stock_units`, `web_orders`, `web_returns`). Een rij daarin blokkeerde het verwijderen van de omgeving door een foreign key en gaf
  alleen "Interne fout".
- Nu gaat het wissen van een testomgeving, leegmaken en verwijderen van een tenant allemaal door `wipeTenantData` (store.js): elke
  tabel met een `tenant_id` uit het schema, in één transactie met uitgestelde foreign keys, dus een nieuwe tabel gaat vanzelf mee. Bij
  leegmaken blijven instellingen, webshopkoppeling en rollen staan (`KEPT_ON_RESET`).
- Mislukt het toch, dan is er niets gewist en toont de melding de oorzaak (`guardedWipe`), bijvoorbeeld "Testomgeving verwijderen is
  mislukt; er is niets gewist. Oorzaak: …", en staat de fout in het serverlog.
- De omgeving waarin je nu werkt (of de tenant waaronder die hangt) kan niet worden verwijderd: 409 `current_tenant` met de uitleg om
  eerst te wisselen. De hoofdtenant blijft beschermd.
- Tests (`tenants-delete.test.js`, ook tegen PostgreSQL): rijen in de gemiste tabellen, leegmaken, huidige omgeving en een mislukte
  verwijdering. Snelheid: alleen bij beheeracties, geen invloed op gewone verzoeken.

## 1.7.8

Zijbalk overzichtelijker: genest, compacter en met vaste plekken voor wat nog komt.

- Indeling in `NAV_GROUPS` (dashboard/modules.js): Verkoop (Offertes, Bestellingen, Klantdossiers, Facturen), Magazijn, Inkoop,
  Artikelen, Planner & werk (planner, plannenoverzicht, planning, werkorders, meldingen, uitbesteden), Webshop, Rapportage en
  Beheer. Een module kiest zijn plek met `navGroup`; een groep met één module is een gewone link, een lege groep bestaat niet.
  Pagina's die nog moeten komen (klanten, inkoop, leveranciers, backorders, te picken) hoeven alleen één regel met de juiste
  `navGroup` en `status: 'actief'`. Nieuw: `navSections` (zuiver, `test/sidebar.test.js`) en `navTitle` (korte titel).
- Compactere rijen (32 px, kleinere iconen en tekst; 44 px op een telefoon), modules springen in langs een lijn onder de
  groepskop, de actieve pagina en de groep waarin je zit zijn duidelijk gemarkeerd. De groep met de huidige pagina staat open en is
  in te klappen; de keuze voor andere groepen wordt onthouden (localStorage `aquatech_nav_groups`).
- Voetregel: Naar de webshop, Hoofdbeheer en Mijn profiel. Aantallen (Nieuws) komen uit `BADGES` in sidebar.js en staan bij een
  ingeklapte groep op de groepskop.
- Beheer: het menu binnen Beheer heeft dezelfde stijl: compacte, inklapbare groepen (de groep met de gekozen sectie staat open, de
  rest wordt per browser onthouden, zoeken opent alle groepen met een treffer). Webshop-inhoud en Webshop en WooCommerce staan nu
  samen in een eigen groep *Webshop*; E-mail en AI-herkenning in *Koppelingen*. Sectie-id's en adressen (`beheer/#mail`) blijven gelijk.
- Snelheid: geen extra verzoeken of queries; de zijbalk tekent niet opnieuw als de stand uit de server gelijk is aan de cache.
## 1.7.7

Databasepool (tussenstap 1 uit *Functioneel beter* van de audit van 1.7.3): losse queries hoeven de server niet meer stil te
zetten.

- Nieuw `db.async` (`database/async-db.js`): `get/all/run(sql, ...params)` met dezelfde ?-SQL als `db.prepare`, als Promise.
  Met PostgreSQL via een pool (`database/pg-pool.js`, `pg.Pool` in de hoofdthread, `PG_POOL_SIZE`, standaard 5, 0 = uit);
  met SQLite (en zonder pool) de synchrone query in een Promise. Per verbinding houdt de pool `statement_timeout`,
  `search_path` en de tenantafscherming (`aquatech.tenants` + `SET ROLE`, `tenant-scope.js`) bij, in één rondgang als ze
  veranderen. Geen transacties via `db.async` (geweigerd): die blijven synchroon, anders kan een transactie in de pool
  vastlopen op de wachtende hoofdthread. Een verbroken verbinding wordt weggegooid en de query één keer opnieuw geprobeerd.
- De sessiecontrole van elk API-verzoek (`store.prefetchSession`, `auth.prefetch`) haalt de sessie vooraf via de pool op;
  de controle zelf blijft gelijk en valt bij een fout terug op de gewone query. Zelfde aantal queries per verzoek.
- Webshop: `storefrontData.warm` vult de catalogus via de pool (twee queries tegelijk, één opvraging per omgeving tegelijk)
  voordat een pagina met een koude cache getekend wordt; een wissen tijdens het ophalen laat geen oude catalogus achter.
- `test/queries.test.js` telt ook queries via `db.async`; nieuw `test/db-async.test.js` (tegelijk uitvoeren, timer loopt door,
  afscherming en schema per verzoek).

## 1.7.6

Nalopen van tweestapsverificatie en RLS uit 1.7.5 (review achteraf, PR #138).

- Inloggen: het codeveld heeft geen `inputmode="numeric"` meer, zodat een herstelcode (letters en streepje) ook op een telefoon
  in te typen is.
- Tweestapsverificatie: hooguit 10 mislukte codes per account voor alle bezoekers samen (`loginGuard.blocked` met `accountMax`);
  de grens per bezoeker en de accountgrens voor wachtwoorden blijven zoals ze waren.
  Na de wachttijd (`loginGuard.wait`) wordt de blokkering opnieuw gecontroleerd, zodat gelijktijdige pogingen de grens niet
  overschrijden.
- `test/tenant-rls.test.js`: de controle op een policy per tabel met `tenant_id` keek naar geen enkele tabel (vergeleek een
  tekst met kolomobjecten) en controleert nu echt elke tabel.

## 1.7.5

Vervolg op de audit van 1.7.3: de punten uit *Functioneel beter* die nog openstonden (8, 12, 5, 2 en de tussenstap van 1).

**Reservering per bestelling (8)**
- Instelling `shopPayment.accountHoldDays` (0-90, standaard 14; Beheer > Webshop > Betalen). Een nieuwe bestelling krijgt
  `data.reservedUntil`: online na `holdHours` uur, op rekening na `accountHoldDays` dagen (0 = tot verzenden of annuleren).
- `webOrders.releaseExpired` (elk uur, `app.locals.webOrdersRelease`): een bestelling op rekening waarvan de termijn voorbij is,
  geeft zijn reservering vrij (`data.reservationReleasedAt`, regel in het verloop); de bestelling blijft staan en verzenden boekt
  gewoon af. Online bestellingen vervallen zoals voorheen via `expireUnpaid`. Bestellingen in Beheer tonen de stand.

**Omschrijving en specificaties (12)**
- Migratie 50: `stock_items.description` (platte tekst, max. 5000), `stock_items.specifications` (JSON, max. 30) en
  `shop_products.description` (omschrijving uit de oude webshop, bij elke synchronisatie als platte tekst).
- `artikelen/item-details.js` (zuivere functies). De shop toont de eigen tekst, anders die van het webshopproduct (met de zichtbare
  kenmerken die niet voor variaties zijn als specificaties), anders die van het hoofdartikel.
- Productpagina: blok Omschrijving en Specificaties, meta-omschrijving en JSON-LD `description` uit de tekst; de productfeed
  gebruikt de omschrijving (tot 5000 tekens).
- Artikelen: velden Omschrijving en Specificaties (naam: waarde per regel) met de knop *Overnemen uit webshop*.

**Inloggen (5)**
- Oplopende vertraging per account en bezoeker (`loginGuard.wait`): na drie mislukte pogingen 1, 2, 4 en daarna 8 seconden voor
  elke volgende poging, ook in de webshop. Tests zetten hem uit met `createApp({ loginDelayMs: 0 })`.

**Tweestapsverificatie (5)**
- Migratie 51: `users.totp_secret` (versleuteld met de kluis, AAD `<tenant>:totp:<gebruiker>`), `totp_enabled_at`,
  `totp_last_step` (een code werkt maar één keer) en `totp_recovery` (alleen SHA-256 van tien herstelcodes).
- `beveiliging/totp.js`: TOTP volgens RFC 6238 (HMAC-SHA1, 30 s, 6 cijfers, één stap speling) zonder bibliotheek, getest
  tegen de testvectoren. `beveiliging/two-factor.js`: opslag en routes `GET /api/account/totp`, `POST …/setup`, `…/confirm`,
  `…/disable` (wachtwoord + code) en `DELETE /api/admin/users/:id/totp` (beheerder, telefoon kwijt).
- Inloggen: met 2FA aan geeft `/api/auth/login` zonder code 401 `totp_required` (pas na een goed wachtwoord) en bij een
  verkeerde code 401 `totp_wrong`; verkeerde codes tellen apart (`totp:<gebruiker>`) met dezelfde blokkering en vertraging.
  Het codeveld op de inlogpagina verschijnt pas als het account erom vraagt. Een account met 2FA logt niet via de winkel in.
- Mijn profiel: blok Tweestapsverificatie met QR-code (eigen encoder `shared/qr-code.js`, in de browser), sleutel om over te
  typen en de herstelcodes (één keer getoond). Beheer > Gebruikers: knop *2FA uitzetten*.

**Tenantafscherming in PostgreSQL (2)**
- Rol `aquatech_app` (zonder BYPASSRLS) met een policy `aquatech_tenant` op elke tabel met `tenant_id`:
  `tenant_id = ANY(string_to_array(current_setting('aquatech.tenants', true), ','))`; tabellen zonder `tenant_id` krijgen
  `USING (true)`, `work_order_offers` (tussen organisaties) blijft zonder beperking.
- Per verzoek een scope (`database/tenant-scope.js`, AsyncLocalStorage): `identify()` beperkt een gewone gebruiker tot de omgevingen
  van zijn organisatie (`store.familyIds`, 30 s cache). `pgdb.js` stuurt de scope mee; de werkthread zet `aquatech.tenants` en
  `SET ROLE aquatech_app` (zonder scope `RESET ROLE`). Hoofdbeheerder, achtergrondtaken en bewust organisatie-overstijgende code
  (audit, uitbesteden, supportweergave) via `asSystem`/`pinSystem`.
- Uit te zetten met `PG_TENANT_RLS=0`. Mag de databasegebruiker geen rol aanmaken, dan logt de server een waarschuwing en
  werkt hij zoals voorheen (alleen de filters in de code). SQLite: geen verandering.

**Snelheid webshop (1, tussenstap)**
- Omschrijvingen per productpagina en voor de feed in dezelfde geheugencache als de catalogus (30 s); een shop-pagina kost met een
  warme cache geen query (test in `queries.test.js`).

## 1.7.4

Alle bevindingen uit de veiligheids- en logica-audit van 1.7.3 opgelost of bewust vastgelegd (behalve W-02: op rekening voor
iedereen blijft zo zolang er getest wordt, besluit Daniël).

**Testomgeving (T-01)**
- `settings.js`: instellingen met `liveOnly` (`shopSource`, `shopConsumerKey`, `shopConsumerSecret`, `mollieApiKey`, `mailServer`,
  `mailPassword`, `seasonReminders`, `visma`, `vismaRefreshToken`) worden bij het aanmaken van een testomgeving niet overgenomen
  (`LIVE_ONLY_KEYS`). Ook de overige geheimen gaan niet meer mee; de AI-sleutel van live blijft in test bruikbaar via `aiTenantOf`.
- `invoicing` gaat wel mee, maar met `autoSend` en `shopOrders.enabled` uit (`valueForTest`).
- Hoofdbeheer: de toelichting bij *Testomgeving aanmaken* noemt dit.

**Inloggen (A-01, A-03, A-04, A-05)**
- Mislukte pogingen tellen per account én bezoeker (`loginGuard` in server.js): wie het wachtwoord van een ander raadt, blokkeert
  alleen zichzelf; een ruime grens per account (100) stopt raden vanaf veel adressen.
- Toegangscode minstens 12 tekens. Verplicht wachtwoord wijzigen geldt ook in de webshop.
- Via https heet de sessiecookie `__Host-aquatech_session` (`sessionCookieName` in auth.js); een cookie zonder voorvoegsel
  (bijvoorbeeld gezet door een ander subdomein) telt via https niet.

**Wachtwoord vergeten en e-mail bevestigen (A-02, W-08)**
- Migratie 48: tabel `account_tokens` (alleen SHA-256 van het token, verlooptijd, eenmalig) en `users.email_verified_at`.
- `platform/account-tokens.js`; shop: *Wachtwoord vergeten* (link 1 uur, één keer, sessies vervallen, neutraal antwoord, limiet per
  bezoeker en per account), bevestigingsmail bij registreren (7 dagen) en opnieuw sturen vanuit het account. Het token staat in
  `#t=` en gaat als kop naar de server. Een ander e-mailadres in het profiel maakt de bevestiging leeg.
- Afrekenen: de bevestiging gaat naar het e-mailadres van het account (veld alleen-lezen).

**Btw verleggen (W-01)**
- `webshop/vies.js`: controle bij VIES (EU) bij het plaatsen. Verleggen alleen met het btw-nummer dat een beheerder bij het
  zakelijke account heeft goedgekeurd én dat VIES niet ongeldig noemt; *onbereikbaar* verlegt wel, maar wordt vastgelegd.
  Uitkomst (met consultatienummer als het eigen btw-nummer in het bedrijfsprofiel staat) in `data.vat.vies`, zichtbaar in Beheer.

**Webshopbestellingen (W-03, W-04, W-09, W-11, W-12)**
- Een artikel op een open webshopbestelling kan niet worden verwijderd of gearchiveerd (409 `reserved_by_order`).
- Creditnota bij retour volgt de factuurregels (geen centverschil na een afrondingsregel).
- Bestelnummer via `MAX()` op de unieke index in plaats van alle bestellingen van het jaar.
- Adres niet gevonden bij PDOK (nieuwbouw) of PDOK onbereikbaar: de klant kan straat en woonplaats zelf invullen (vinkje);
  de bestelling krijgt `address.unverified` en Beheer toont *Adres niet gecontroleerd*.
- Bestellimiet: pogingen per bezoeker ruim (40/uur), geplaatste bestellingen per account 10/uur (geteld in de database).

**Retouren en terugbetalen (W-05)**
- Volledige retour door een consument (alle artikelen, ook over meerdere retouren): de verzendkosten gaan mee in de creditnota.
- `POST /api/admin/web-orders/:id/refund` (`{ returnId }` = bedrag van de definitieve creditnota; zonder = geannuleerde bestelling,
  het restbedrag) via de Mollie Refunds-API (`mollie.createRefund`, idempotentiesleutel per retour/annulering, nooit twee keer).
  Knoppen in Beheer bij de retour en de geannuleerde bestelling.
- De Mollie-webhook legt terugbetalingen (ook uit het Mollie-dashboard) en terugboekingen door de bank (`chargedBack`,
  `chargebackAt`) vast; Beheer toont ze.

**Planner naar winkelwagen (W-10)**
- Migratie 49: `stock_items.unit_content` (*Inhoud per eenheid* in Artikelen, bijv. 50 voor een rol van 50 m).
- De planner stuurt de eenheid mee (`u:<code>`); andere eenheid met inhoud → omrekenen en naar boven afronden, zonder inhoud →
  niet in de wagen en gemeld (`?eenheid=`).

**Tekening indienen en klantlinks (T-03, G-02)**
- `drawingRequests` staat standaard uit; per inzending hoogstens 2 MB (de browser verkleint de achtergrond), hoogstens 40 MB
  onbehandeld per organisatie; onbehandelde openbare inzendingen worden na 60 dagen gewist (AVG).
- Offerte- en afspraaklinks verlopen (`platform/public-links.js`): 180 dagen na delen of 90 dagen na de geldigheids-/afspraakdatum,
  wat het laatst is.

**Overig (T-02, W-07, G-01, A-06, W-06, T-04)**
- `tools/tenant-filter.js` + `test/tenant-filter.test.js`: elke nieuwe SQL-tekst op een tabel met `tenant_id` moet op de tenant
  filteren; bestaande uitzonderingen in `tools/tenant-filter-baseline.json` (alleen korter maken).
- Canonical, sitemap, feeds en links in mails gebruiken alleen het webadres uit Beheer (`shopPayment.publicUrl`), nooit de Host-kop.
- PostgreSQL: `statement_timeout` 30 s per verbinding (`PG_STATEMENT_TIMEOUT_MS`).
- Vastgelegd zonder codewijziging: limieten en idempotentie in het geheugen zijn goed zolang er één container is (A-06);
  WooCommerce-voorraadsync wordt uitgefaseerd met de eigen shop (W-06); klantweergave toont bewust ook live-klanten van de eigen
  organisatie, met alleen testgegevens (T-04, wens Daniël 1.3.6).

## 1.7.3

Terug naar de webshop vanuit de app, en het materiaal uit een plan in één klik in de winkelwagen.

- `GET /api/config` geeft `shop` mee (`{ ordering }`, anders `null`): alleen voor de hoofdtenant met `storefront` aan.
- Planner: knop *Webshop* in de kopbalk en *Naar de webshop* in het menu; in de zijbalk (beheerders) onderaan *Naar de webshop*.
- Stuklijst in de planner: knop *Alles in winkelwagen* (alleen als `shopOrdering` aan staat) die een gewoon formulier naar
  `POST /winkelwagen/planner` stuurt (velden `q:<code>`; kommagetallen naar boven afgerond). Prijzen (incl. of excl. btw voor
  zakelijke klanten), varianten, voorraad en groothandelsvoorwaarden komen uit de bestaande `priceCart`; een groothandelsklant
  krijgt aantallen volgens verpakkingseenheid en minimum. Het aantal uit het plan *vervangt* het aantal in de wagen (`setCartLines`),
  dus nogmaals klikken verdubbelt niets. Onbekende of niet te bestellen codes worden op de winkelwagenpagina gemeld (`?plan=&niet=`).
- Geen databasewijziging. Tests: `test/planner-cart.test.js`.

## 1.7.2

De webshop is beter vindbaar voor zoekmachines en AI-zoekers (ChatGPT, Perplexity, Google, Copilot).

- Nieuw `webshop/seo.js` (zuivere functies): Schema.org JSON-LD, `robots.txt`, sitemap, `llms.txt` en productfeed.
- Elke pagina krijgt een canonical-link, OpenGraph- en Twitter-regels. Pagina's die niet bedoeld zijn voor zoekresultaten
  (account, winkelwagen, afrekenen, zoeken, niet gevonden) krijgen `noindex, follow`. De pagina's waren al server-side opgebouwd.
- JSON-LD: startpagina `Store` (LocalBusiness: Nunspeet, KvK, contact) en `WebSite` met zoekfunctie; product `Product` met
  `Offer` (prijs incl. btw, voorraad, afbeelding; hoofdartikel `AggregateOffer`); categorie en product `BreadcrumbList`;
  de pagina met slug `veelgestelde-vragen` (Beheer > Webshop-inhoud) wordt `FAQPage`: elke kop (h2 tot en met h4) is een vraag,
  de tekst eronder het antwoord.
- `GET /robots.txt` (Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Claude-SearchBot,
  Google-Extended e.a. expliciet toegestaan; app, API en klantpagina's uitgesloten; verwijst naar de sitemap),
  `GET /sitemap.xml` (met `lastmod` uit `stock_items.updated_at`), `GET /llms.txt` en `GET /productfeed.xml`
  (Google Merchant Center, RSS 2.0 met `g:`-velden; artikelen zonder afbeelding en varianten apart). Alleen als de shop aan staat;
  anders blijft `robots.txt` bij `Disallow: /`.
- Het webadres in de adressen komt uit Beheer > Betalen (*Webadres van de webshop*), anders uit het verzoek.
- Geen databasewijziging; één extra kolom (`updated_at`) in de bestaande cataloguskwery. Tests: `test/seo.test.js`.

## 1.7.1

De webshop is de startpagina; de app staat onder `/app/`.

- Alles van de app (dashboard, modules, API, inloggen, openbare offerte- en afspraaklinks, `sw.js`, `manifest.json`)
  staat onder `/app/`. In `server.js` haalt een middleware het voorvoegsel eraf (`req.inApp`), zodat de rest van
  de app ongewijzigd werkt; de hoofdmap is de webshop-router (voorheen `/winkel`).
- Oude adressen worden relatief doorgestuurd (`legacyAppRedirect`): `/beregening/…`, `/login`, `/openbaar/…`
  e.d. naar `app/…`, `/admin` naar `app/beheer/`, `/winkel/…` naar `/…` (301). `/api/…` buiten `/app` geeft 404,
  alleen `/api/health` blijft ook op de oude plek. De oude Mollie-webhook `/winkel/mollie/webhook/…` werkt nog.
- `/sw.js` buiten `/app` is een opruim-worker (schrijft zich uit en wist `aquatech-shell-*`), voor installaties
  met de oude scope `/`. De worker van de app heeft scope `/app/`.
- Webshop uit (standaard): `/` stuurt door naar `app/`; `?voorbeeld=1` blijft werken voor beheerders.
- `robots.txt` sluit `/app/`, `/api/` en klantpagina's van de shop uit.
- Inlog-, setup- en wachtwoordpagina rekenen de API-basis vanaf `/app/`; shop-knoppen naar planner, portaal en profiel
  wijzen naar `../app/…`. Beheer-teksten en voorbeeldlinks aangepast. Tests uitgebreid (`test/app-prefix.test.js`).
- `/planner` blijft de aanmeldpagina van de shop (geen alias naar de app); gebruik `/admin` of `/app/`.

## 1.7.0

De menuboom van de webshop is aanpasbaar in Beheer.

- **Tabblad Menu** in Beheer > Webshop-inhoud (`beheer/webshop-menu.js`): categorieën hernoemen, verplaatsen
  (omhoog, omlaag, een niveau in of uit), toevoegen, verbergen en verwijderen, met per categorie uitleg,
  afbeelding en de webshopcategorieën waarop producten worden ingedeeld (`match`). De vier koppen blijven
  vast (alleen hernoemen). Concept, voorbeeld (`?voorbeeld=1`), publiceren, weggooien en vorige versie
  terugzetten zoals bij de andere onderdelen; opslag als content-sleutel `menu` in `shop_content`
  (geen migratie), `normalizeTree` saneert de boom (max. 600 categorieën, 6 niveaus, unieke adressen).
- Hernoemen breekt de indeling niet: een bestaande categorie houdt haar webshopnaam als `match`.
- Webshopcategorieën die nog in geen enkele categorie staan, staan onder *Nog niet ingedeeld* met een knop
  om ze toe te voegen.
- Submenu's in de shop klappen naar rechts open en alleen naar links als er rechts geen ruimte meer is
  (`webshop/storefront-menu.js`, klassen `fly-left`/`drop-left`; vervangt `nav-flip`).
- Een voorbeeld (`?voorbeeld=1`) houdt de menu- en categorielinks in het concept.
- `createStorefrontData` krijgt de boom per organisatie (`treeOf`); categorieafbeeldingen in de standaardboom
  zijn nu `asset:`-verwijzingen.

## 1.6.9

Categoriepagina's en menu van de eigen webshop in de opzet van aquatechshop.nl.

- **Categorieboom** (`webshop/category-tree.js` + `category-tree.json`): de indeling van aquatechshop.nl
  (4 hoofdcategorieën, tot vijf niveaus diep) met intro en afbeelding per categorie; de afbeeldingen staan
  lokaal in `webshop/assets/cat-*.webp`. De webshop levert alleen platte categorienamen: een product komt
  in de diepste categorie waarvan de naam bij zijn categorieën past (`placeIn`); wat niet in de boom staat
  blijft een losse categorie, een product met alleen een hoofdcategorie komt in *Overig*. *Beregening oud*
  is een verborgen categorie (alleen via het adres bereikbaar).
- **Catalogus** (`buildCatalog(rows, soldByCode, tree)`): categorieën hebben nu `children`, `parentSlug`,
  `depth`, `intro`, `image`, `hidden` en een telling inclusief subcategorieën (`count`; `ownCount` = alleen
  rechtstreeks); lege takken vallen weg. Hoofdcategorieën krijgen `intro` en `image`.
- **Menu**: de koppen van de hoofdcategorieën zijn geen link meer, ze klappen open (CSS, ook met focus).
  Elk niveau krijgt een flyout (`nav-fly`; de rechterhelft van de balk klapt naar links); op een smal scherm
  klappen de niveaus in elkaar open (`details`). De tussenpagina met alle suboptions is uit het menu.
- **Categoriepagina** (`browsePage` in `storefront-pages.js`): kruimelbalk, zijbalk *Categorie* (uitgeklapt
  langs het pad) en *Prijs* (min/max), intro, blokken van de subcategorieën met afbeelding en aantal en,
  bij producten die rechtstreeks in de categorie zitten, resultaatregel, filter *Alleen op voorraad*,
  sorteren (naam, prijs) en paginering (24 per pagina). Dezelfde opzet voor de pagina van een hoofdcategorie
  (`groep/<slug>/`, bereikbaar vanaf de startpagina en het kruimelpad).
- Tests: `test/shop-categories.test.js`.

## 1.6.8

Startpagina van de eigen webshop (`/winkel/`) gelijk aan die van aquatechshop.nl.

- **Hero** zonder tekst (alleen de afbeelding), zoals het origineel; kop, tekst en knop blijven optioneel
  (de automatische knop komt alleen nog bij een kop).
- **Tabbladen** *Meest verkocht* en *Populaire producten* (alleen CSS, keuzerondjes, geen script).
  *Meest verkocht* = afboekingen van webshopverkopen (bron `webshop` en `bestelling:*`) van de laatste
  180 dagen per artikelcode (`storefront-data.js`, `buildCatalog(rows, soldByCode)`, `catalog.bestsellers`);
  zonder verkopen blijft alleen *Populaire producten*.
- **Twee bannerblokken** (druppelslang en beregeningspomp) en **drie kolommen** (Beregening, Speciale
  producten, Uitverkoop) met drie producten uit een productgroep of uit eigen artikelcodes; een lege
  kolom toont "Binnenkort meer producten". Het **citaat** "Duurzaamheid door kwaliteit!".
- **Aanvraagformulier voor een zakelijk account** in het zakelijke blok (bedrijfsnaam, e-mail, telefoon,
  bericht): `POST /winkel/zakelijk-aanvraag/` mailt het bedrijfsprofiel-adres (`sendBusinessRequest` in
  `web-orders-mail.js`), niets wordt in de database bewaard; limiet 5 per uur per bezoeker
  (`clientKey`), verborgen valstrikveld, `Sec-Fetch-Site`-controle. Het formulier verschijnt alleen als
  er een mailserver en een e-mailadres in het bedrijfsprofiel zijn (`businessRequestReady`), anders blijft
  de knop *Account aanmaken*.
- **Voet**: kolom *Klantenservice* (contact, retourbeleid, voorwaarden) in plaats van de lijst met productgroepen.
- **Eigen opslag**: de afbeeldingen van de banners staan in `webshop/assets/` (zonder EXIF/GPS, 1400 px);
  hero, pictogrammen, merklogo's en achtergrond stonden er al. De startpagina verwijst nergens naar
  aquatechshop.nl; productfoto's volgen de eigen afbeeldingen (*Afbeeldingen uit webshop* in Artikelen).
- **Beheer → Webshop-inhoud**: nieuwe blokken *Banners*, *Kolommen met producten*, *Citaat* en het
  vinkje voor het formulier (`banners`, `columns`, `quote`, `business.form` in `shop-content.js`).
- Tests: `shop-home.test.js`; `shop-content.test.js` aangepast aan de hero zonder tekst.

## 1.6.7

Voorraad: artikelen uit een webshop zonder voorraadbeheer stonden overal als "niet op voorraad".

- **Oorzaak**: aquatechshop.nl bewaart bij veel producten geen aantal (alleen de status "op voorraad").
  `fromRestV3` geeft dan `stockQty: null`, het artikel kwam met stand 0 in Aquatech en de shop, de
  winkelwagen en de groothandel rekenden `stand - gereserveerd > 0`.
- **Oplossing** (migratie 47, `stock_items.stock_managed`): een artikel zonder voorraadbeheer
  (`stock_managed = 0`) volgt de status van het gekoppelde webshopproduct (`shop_products.in_stock`) in
  `storefront-data.js` (`stockOf`) en `web-orders.js` (`priceCart`). Een import zonder aantal zet het zo; de
  migratie zet bestaande gekoppelde artikelen zonder stand, boekingen en gezien webshopaantal ook zo.
  Een ontvangst of telling (`stock.book`, delta > 0 of soort `telling`) of een aantal in de webshop
  (`shop-sync.js`) zet `stock_managed` aan; een verkoop (afboeking) niet. Aquatech blijft de bron voor
  de voorraad zodra die wordt bijgehouden.
- Test: `shopsync.test.js` (webshop zonder voorraadbeheer).

## 1.6.6

Snelheid (deel 2): databasequery's, zonder andere functionaliteit.

- **Gemeten**: queries per verzoek voor 55 routes en de achtergrondtaken op een met testdata gevulde
  omgeving (geen N+1, hoogstens 9 queries per verzoek, de shop 0 dankzij de bestaande caches), en alle
  993 verschillende SQL-opdrachten uit de testsuite langs het queryplan van SQLite. Wat overbleef aan
  tabelscans zit in zeldzame paden (gebruiker of omgeving verwijderen) of alleen in tests.
- **Winkelwagen en afrekenen** (`webshop/web-orders.js`, `priceCart`): het gereserveerde aantal wordt per
  artikel in de wagen via de index opgezocht, in plaats van eerst alle reserveringen van de omgeving op te
  tellen. Elke weergave van de winkelwagen en elke herberekening van het totaal doet dit.
- **Hoofdartikel openen** (`artikelen/stock.js`, `listRows` met `parentId`): de reserveringen en het
  aantal werkorders tellen alleen voor de varianten van dat artikel.
- **Webshopkoppeling** (`webshop/shop-sync.js`): bij het terugschrijven van alleen gewijzigde artikelen
  (na elke voorraadmutatie) en bij *In webshop zetten* geldt hetzelfde: gereserveerd per artikel via de index.
- **Inloggen** (migratie 46, `users_login_name`): gewone index op `users.username`. Een inlogpoging
  zonder treffer in de organisatie zoekt een testaccount op naam over alle omgevingen
  (`store.loginTenantOfTestAccount`); zonder index las PostgreSQL daarvoor elke gebruiker.
- **Tests**: de migratietest controleert dat de nieuwe index er is en dat gebruikersnamen uniek per
  organisatie blijven. Bestaande tests voor gereserveerd/beschikbaar, varianten en de winkelwagen
  dekken de herschreven query's; dezelfde uitkomst is ook gecontroleerd met een meting op 900 artikelen
  en 4.000 reserveringen per omgeving (SQLite en PostgreSQL).

## 1.6.5

Beveiligingsronde en snelheid (deel 1), zonder andere functionaliteit.

- **Beveiliging, metadata** (`uitvoering/photos.js`, `inspectImage`): naast JPEG gaan nu ook bij PNG
  (`tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`) en WebP (`EXIF`, `XMP `, plus de vlaggen in `VP8X`) de
  metadata eruit. Geldt voor werkorderfoto's, meldingen, artikelafbeeldingen (ook overgenomen uit de
  oude webshop en daarna openbaar in de shop) en afbeeldingen van de shop. Beelddata blijft byte voor
  byte gelijk; een onvolledig PNG- of WebP-bestand (blok buiten het bestand, geen IEND) wordt geweigerd.
- **Beveiliging, limieten** (`beveiliging/auth.js`, `clientKey`): limieten per bezoeker tellen bij IPv6
  per /64-netwerk in plaats van per adres. Een IPv6-aansluiting heeft een heel /64-blok, dus per adres
  tellen liet elke limiet (inloggen, registreren, bestellen, openbare links, AI) omzeilen door steeds
  een ander adres te gebruiken. IPv4 blijft per adres, ook in IPv6-vorm (`::ffff:a.b.c.d`). `remoteIp` (auditlog) is ongewijzigd.
- **Snelheid** (`platform/image-cache.js`): artikelfoto's (`/winkel/artikelfoto/`, `/api/stock/images/`)
  en shopafbeeldingen (`/winkel/media/`) komen na de eerste keer uit het geheugen (LRU, 48 resp. 24 MB,
  10 minuten). Scheelt per foto een databaserondgang met de volledige afbeelding (bij Supabase over het
  netwerk, en de synchrone databaselaag houdt de server zolang vast) plus het ontsleutelen. Verwijderen
  of opruimen haalt de afbeelding ook uit het geheugen, net als het leegmaken, vullen met testdata of verwijderen
  van een omgeving (`forgetImages` in server.js).
- **Tests**: PNG/WebP met tekst, EXIF en XMP; `clientKey` en de inloglimiet met wisselende IPv6-adressen
  in één /64; cache (grenzen, verlopen, per omgeving) en een verwijderde artikelfoto komt niet meer uit
  het geheugen.

## 1.6.4

Afbeeldingen overnemen uit de webshop: duidelijker over hergebruik.

- **Onderzoek**: de import bewaart al elke foto één keer (SHA-256 van de inhoud, unieke index
  `item_images_hash`, en elk adres wordt per run één keer opgehaald). Een steekproef van de oude
  webshop (producten en variaties) gaf geen verschillende bestanden met dezelfde foto.
- **Server** (`artikelen/item-images.js`, `importFromShop`): het resultaat bevat nu `stored`, het aantal
  echt nieuw bewaarde afbeeldingen (`imported`/`reused` tellen artikelen).
- **Frontend** (`artikelen/artikelen.js`): de melding noemt gekoppelde artikelen en nieuw bewaarde afbeeldingen, zodat
  "882 overgenomen" niet meer als 882 kopieën leest.
- **Tests**: 30 artikelen over meerdere porties met drie adressen met identieke inhoud geven één afbeelding.

## 1.6.3

Vervolg op 1.6.2 (inkoopprijzen en FIFO).

- **Server** (`artikelen/stock-costs.js`, `issuedCost`): een retour met een herleidbare bron
  (eigen bron zoals `bestelling:<nr>`/`verbruik:<id>`, of een werkorder) waarvan de afboeking geen
  kostregels heeft, krijgt een onbekende inkoopprijs in plaats van de actuele prijs (nooit raden).
  Alleen een retour met een algemene bron zonder werkorder valt terug op de actuele inkoopprijs.
- **Review**: `.coderabbit.yaml` vermeldt dat de software in ontwikkeling is; gegevens van vóór een
  migratie hoeven geen speciale afhandeling.

## 1.6.2

Inkoopprijzen met historie, voorraadlagen (FIFO) en een margerapportage in de webshopmodule.

- **Server** (migratie 45 in `database/db.js` en `database/pgschema.js`): tabellen `stock_cost_prices`
  (prijshistorie: elke nieuwe inkoopprijs is een eigen regel met *geldig vanaf*; `stock_items.cost_price` = de
  actuele), `stock_layers` (elke ontvangst is een laag met zijn inkoopprijs en wat er nog over is),
  `stock_cost_entries` (per mutatie welke laag tegen welke prijs is gebruikt) en `web_sale_lines` (verkoopregels
  van de webshop). De bestaande voorraad wordt één beginlaag tegen de huidige inkoopprijs (leeg = onbekend).
  `artikelen/stock-costs.js`: elke mutatie (`stock.book`) gaat langs de lagen; afboeken gebruikt de oudste laag
  eerst (FIFO), een retour komt terug tegen de prijs van de oorspronkelijke afboeking (bron of werkorder), een
  tekort (negatieve stand) tegen de actuele prijs, en lagen die niet met de stand kloppen worden rechtgezet
  (beginstand). Een onbekende prijs wordt nooit geraden. Nieuwe routes `POST /api/stock/items/:id/cost-prices`
  (`{ price, validFrom, note }`, niet in de toekomst) en `PUT /api/stock/items/:id/layers/:layerId`
  (`{ unitCost }`, alleen een laag met onbekende prijs of de beginstand; wat al uit die laag is afgeboekt gaat
  mee). Een ontvangst kan `unitCost` meekrijgen; een andere prijs dan de actuele wordt de nieuwe inkoopprijs. Een
  andere inkoopprijs in het artikelformulier komt ook in de historie.
- **Rapportage** (`webshop/web-sales.js`, `GET /api/admin/webshop-report?from&to&interval&lines=1`, alleen
  beheerders): omzet artikelen excl. btw (zonder verzendkosten), inkoopwaarde uit de lagen, brutowinst en marge,
  per dag/week/maand, per artikel en per webshopcategorie, plus de voorraadwaarde nu (FIFO). Verzonden
  bestellingen en afgeronde retouren worden bij elke rapportage aangevuld (ook die van vóór deze versie, met
  onbekende inkoop); een retour zonder terugboeking (beschadigd) laat de inkoop staan. Omzet zonder bekende inkoop
  telt apart als *inkoop onbekend* en niet mee in de marge.
- **Frontend**: tabblad *Rapportage* in Webshopbestellingen (`webshop-bestellingen/rapportage.js|.css`):
  kerncijfers, gestapelde staafgrafiek inkoop + brutowinst, top 10 artikelen en categorieën op brutowinst,
  tabel met alle artikelen en Excel-export (overzicht, per periode, per artikel, per categorie, verkoopregels).
  Artikelen: blok *Inkoopprijs en voorraadlagen (FIFO)* (prijs toevoegen met datum, prijshistorie, lagen met
  *onbekend* en een veld om de prijs in te vullen) en een inkoopprijs bij een ontvangst.
- Testdata: de voorraad krijgt vanzelf prijshistorie, lagen en kostregels; `web_sale_lines` staat in
  `NO_TESTDATA` (een testomgeving heeft geen webshop). Tests: `stock-costs.test.js`.

## 1.6.1

Groothandelsvenster in de webshop: snelbestellijst, bestellen op artikelcode, staffelkorting en verpakkingseenheden.

- **Server** (migratie 44 in `database/db.js` en `database/pgschema.js`): `users.wholesale` en
  `users.wholesale_discount` (vaste korting in %, 0-50) en per artikel `stock_items.order_pack_size`,
  `order_min_qty` en `price_tiers` (JSON `[{ minQty, discountPct }]`, hoogstens 5). Een groothandelsklant is
  altijd een zakelijke klant: `PATCH /api/admin/users/:id` met `wholesale` weigert (400) een particuliere klant,
  en particulier maken wist de vlag en de korting. Artikelen: `packSize`, `orderMinQty` (wordt een veelvoud van
  de eenheid) en `priceTiers` in `POST/PUT /api/stock/items`. Rekenregels in `webshop/wholesale.js`
  (zuivere functies): de stukprijs is de zakelijke prijs min de **hoogste** van staffelkorting (voor dat aantal) en
  vaste klantkorting (niet opgeteld); `priceCart` krijgt `wholesale: { discountPct }` mee, meldt per regel
  `packProblem` en laat `place` een aantal dat niet past weigeren (409). De voorwaarden gelden alleen voor
  groothandelsklanten. Winkelwagenlimiet: 60 regels en 9999 stuks per regel (was 40 en 99; de cookie wordt op
  3600 tekens begrensd, `addCartLines`/`fitCart`).
- **Webshop** (`webshop/storefront-wholesale-pages.js`, `storefront-wholesale.js`): `/winkel/groothandel/`
  (alleen voor een ingelogde groothandelsklant, anders 404 of naar inloggen; kopje Groothandel in het menu) met
  de **snelbestellijst** (alle artikelen en varianten, zoeken/filteren in de browser, één knop *Alles in
  winkelwagen*), **bestellen op artikelcode** (plakken uit Excel: tab, `;`, `x` of spatie als scheiding, kopregel
  overgeslagen, dubbele codes opgeteld, onbekende codes gemeld) en **opnieuw bestellen** (laatste 5 bestellingen).
  Alle acties posten naar hetzelfde adres (veld `action`), aantallen worden naar boven afgerond en gemeld. De
  winkelwagen toont de toegepaste korting en de voorwaarde per regel.
- **Frontend**: `beheer/beheer.js` (Groothandel-vakje + vaste korting bij een zakelijke klant) en
  `artikelen/` (velden Verpakkingseenheid, Minimale afname en Staffelkorting, invoer `50:10, 100:15`).
- Testdata: testklant `klant5` is groothandelsklant (5% vaste korting), elk vijfde artikel heeft verpakkingseenheid 10
  en staffels.
- Tests: `wholesale.test.js` (rekenregels, plakken, rechten, andere organisatie, afronden, korting, afrekenen
  blokkeren, opnieuw bestellen).

## 1.6.0

Zakelijke klanten in de webshop: aanvragen, goedkeuren en prijzen excl. btw in de hele shop.

- **Server** (migratie 43 in `database/db.js` en `database/pgschema.js`): kolommen `users.company_name`,
  `kvk_number`, `vat_number` en `business_request` (`aangevraagd` = open aanvraag). `webshop/business-profile.js`
  controleert en normaliseert bedrijfsnaam (verplicht), KvK-nummer (8 cijfers) en btw-nummer (optioneel,
  formaat via `vat.js`; geen VIES of KvK-API). `store.businessProfile`/`saveBusinessProfile`; `createShopCustomer`
  neemt `business` aan. Goedkeuren/afwijzen = `PATCH /api/admin/users/:id` met `customerGroup` (sluit de
  aanvraag); bedrijfsgegevens met `companyName`/`kvkNumber`/`vatNumber` (400 met `field` bij een fout). De
  klantgroep `zakelijk` is de vlag waar een latere groothandelsfunctie op voortbouwt.
- **Webshop** (`webshop/`): registreren met het vakje *Zakelijke klant* + bedrijfsgegevens (aanvraag, tot
  goedkeuring particulier); `POST /winkel/account/zakelijk/` vraagt een zakelijk account aan vanaf *Mijn account*
  (alleen ingelogd, met de `Sec-Fetch-Site`-controle van de andere accountformulieren). Voor een zakelijke klant tonen alle
  pagina's (lijsten, zoeken, product, varianten, voettekst) de zakelijke prijs excl. btw met de regel
  *incl. btw €…* (`priceBusiness`/`priceBusinessIncl` in de catalogus uit `business_price`, anders de
  verkoopprijs); die pagina's krijgen `Cache-Control: private, no-store`. Afrekenen vult bedrijfsnaam en
  btw-nummer vooraf in. Winkelwagen, afrekenen en factuur rekenden al excl. btw (1.4.8) en blijven gelijk.
- **Frontend** (`beheer/beheer.js`): cel *Klantgroep* met keuze particulier/zakelijk, de knop
  *Bedrijfsgegevens* en bij een open aanvraag *Goedkeuren*/*Afwijzen*.
- Testdata: een zakelijke testklant en een klant met een openstaande aanvraag.
- Tests: `business-customers.test.js` (aanvragen, goedkeuren/afwijzen, prijzen per bezoeker, rechten, andere
  organisatie, vooraf invullen bij afrekenen).

## 1.5.9

Samenvoegen van artikelen terugdraaien.

- **Server** (`artikelen/stock.js`, migratie 42 in `database/db.js` en `database/pgschema.js`): tabel
  `stock_merges` met per samenvoeging een momentopname (de webshopkoppeling van elk artikel; verder
  verandert samenvoegen niets aan een artikel). `GET /api/stock/items/:id/unmerge` toont wat er gebeurt,
  `POST /api/stock/items/:id/unmerge` (recht `voorraad`) maakt van de varianten weer losse artikelen
  (id, code, omschrijving, prijzen, voorraad incl. latere boekingen en afbeelding blijven), zet de
  webshopkoppeling terug (niet als het product inmiddels aan een ander artikel hangt) en haalt het
  hoofdartikel weg. Een na het samenvoegen bijgemaakte variant gaat weg (met boekingen: gearchiveerd).
  Is het hoofdartikel aan een webshopproduct gekoppeld, dan weigert de server (409). Samengevoegd onder
  1.5.8 (zonder logboek): de varianten worden losgemaakt, webshopkoppelingen komen niet terug.
- **Frontend** (`artikelen/`): knop *Samenvoeging ongedaan maken* onder Varianten van een hoofdartikel,
  met een bevestiging die de artikelen noemt.
- Testdata: een samengevoegd hoofdartikel (Verloopstuk) met logboek.
- Tests: terugdraaien via de API (rechten, andere organisatie, geblokkeerd, voorraad na samenvoegen),
  zonder logboek en met een later bijgemaakte variant.

## 1.5.8

Losse artikelen samenvoegen tot één variabel artikel.

- **Server** (`artikelen/stock.js`, `artikelen/variant-suggestions.js`): `GET /api/stock/merge-suggestions`
  (recht `voorraad`, één query met alleen de nodige kolommen) groepeert losse artikelen waarvan de
  omschrijving alleen in een maat of kleur verschilt en die dezelfde eenheid, btw en omzetgroep hebben
  (dubbele maten vallen af). `POST /api/stock/merge { ids, code, name, attributeName, values }` maakt in
  één transactie een nieuw hoofdartikel en zet de gekozen artikelen eronder (`parent_id`,
  `variant_values`). Geen migratie: een variant is al een gewoon voorraadartikel.
- **Niets gaat verloren**: id, code, voorraad, prijzen, minimum, afbeelding, boekingen en reserveringen
  van elk artikel blijven; werkorders, offertes, facturen en bestellingen verwijzen nog naar dezelfde
  code. Het hoofdartikel neemt eenheid, btw, omzetgroep en prijs van het eerste artikel (op code) en
  de eerste afbeelding over. Artikelen met verschillende eenheid, btw of omzetgroep, gearchiveerde
  artikelen en artikelen die al hoofdartikel of variant zijn worden geweigerd (409); een id van een
  andere organisatie is 404. Audit: `voorraad_samengevoegd`.
- **Webshop**: een apart aan een webshopproduct gekoppeld artikel verliest die koppeling (een variant
  hoort bij een variatie); daarna zet *In webshop zetten* het hoofdartikel als één variabel product
  in de webshop. Het oude webshopproduct blijft staan tot je het daar weghaalt.
- **Frontend** (`artikelen/merge.js`): knop *Samenvoegen tot variabel artikel* bij Artikelen. Stap 1:
  voorstellen (één klik) of zelf artikelen aanvinken; stap 2: controle met code, omschrijving, kenmerk,
  waarde per artikel en een overzicht van wat er verandert; daarna opent het nieuwe hoofdartikel.
- Staat "Webshop bepaalt de artikellijst" aan (standaard bij een gekoppelde webshop), dan weigert het samenvoegen (409) artikelen die aan een webshopproduct hangen: de volgende synchronisatie zou de varianten archiveren en hun reserveringen wissen.
- Webshopsync (`shop-sync.js`, `matcher`): een variant koppelt alleen nog aan een variatie, niet meer opnieuw aan een los product met dezelfde sku.
- Tests: `test/merge-articles.test.js`.

## 1.5.7

Afbeeldingen bij artikelen: uploaden, overnemen uit de oude webshop en tonen in de eigen shop.

- **Opslag** (migratie 41, `db.js` + `pgschema.js`): tabel `item_images` (versleuteld via
  `vault.sealBytes`, AAD `<tenant>:artikel-afbeelding:<id>`, `content_hash` SHA-256 zodat artikelen
  met dezelfde foto één afbeelding delen, `source_url`) en kolom `stock_items.image_id`.
  Verweesde afbeeldingen worden opgeruimd (`prune`); index `stock_items (tenant_id, image_id)`.
- **Server** (`artikelen/item-images.js`): `PUT|DELETE /api/stock/items/:id/image` (recht
  `voorraad`, eigen `express.json` van 8 MB, type op inhoud gecontroleerd, EXIF weg),
  `GET /api/stock/images/:id` (voorbeeld in het beheer) en het overnemen uit de webshop:
  `GET /api/stock/images-import` (aantal nog te doen) en `POST /api/stock/images-import
  { after }` (porties van 25 artikelen, elk adres één keer opgehaald; alleen https en
  openbare adressen via `netguard.publicAddress` + `pinnedFetch`, geen omleidingen, 4 MB,
  time-out 10 s). Eenmalig en herhaalbaar: alleen artikelen zonder eigen afbeelding komen
  aan bod, mislukte adressen worden gemeld en bij de volgende keer opnieuw geprobeerd.
  `pinned-fetch.js`: `readBytesLimited`.
- **Shop**: `winkel/artikelfoto/<id>` (openbaar, onraadbaar id, immutable cache, eigen limiet van 1200 per minuut per bezoeker);
  `storefront-data.js` (`imageOf`) geeft de eigen afbeelding voorrang boven het adres van het
  webshopproduct, een variant zonder afbeelding gebruikt die van het hoofdartikel.
- **Frontend** (`artikelen/item-images.js`): verkleinen in de browser (max. 1200 px), uploadveld in
  het formulier Nieuw voorraadartikel, blok Afbeelding op het artikel en de knop *Afbeeldingen uit
  webshop* met voortgangsbalk. Layout: de knoppen onder aan de formulieren (`.row.actions`) staan
  los van de velden (de `<datalist>` tussen de rijen brak de afstandsregel).
- **Mediabibliotheek**: tabblad *Afbeeldingen* bij Artikelen (`GET /api/stock/images`, twee queries,
  geen inhoud): raster met alle afbeeldingen + de artikelen die ze gebruiken, zoeken, en de lijst
  met artikelen zonder afbeelding; klik opent het artikel.
- Testdata: het testartikel *Tuinslang* heeft een afbeelding. Tests: `test/item-images.test.js`.

## 1.5.6

Het adres is niet meer met de hand te wijzigen: alleen postcode, huisnummer en toevoeging zijn invulbaar.

- **Frontend**: `shared/address-lookup.js` zet het adresveld (`data-address-lookup`) op
  alleen-lezen. Een treffer vult het in; geen treffer, een ongeldige toevoeging of een
  storing maakt het veld leeg, toont een duidelijke melding (zonder "vul het zelf in") en
  blokkeert het versturen van het formulier (`hasProblem`, `submit` in de capture-fase).
  Een bestaand adres blijft gewoon zichtbaar. Afrekenen: straat en woonplaats zijn
  alleen-lezen voor land NL (bewerkbaar voor andere landen) en bestellen kan pas met een
  gevonden adres.
- **Server**: `createAddressGuard` + `requireVerifiedAddress` (`platform/address-lookup.js`):
  een gewijzigd adres moet precies kloppen met wat PDOK bij postcode + huisnummer
  (+ toevoeging) geeft, anders 400 `invalid_address` (bij een PDOK-storing 503
  `address_unavailable`). Een ongewijzigd ouder adres blijft opgeslagen kunnen worden.
  Toegepast op offerte (POST/PUT), werkorder (POST/PUT), factuur (POST/PUT), debiteur
  (PUT) en melding in het portaal (POST). Afrekenen: bij land NL en DPD worden straat,
  postcode en woonplaats uit PDOK gehaald (`resolveParts`); invoer uit de browser wordt
  vervangen of geweigerd.
- Tests: `test/helpers/pdok-fake.js` (gedeelde nagebootste PDOK); testadressen in de
  bestaande tests hebben nu een postcode.

## 1.5.5

Adres invullen via postcode en huisnummer (PDOK Locatieserver, BAG, gratis en zonder sleutel).

- **Afrekenen zonder knop**: een ander land of een btw-nummer werkt het totaal en de
  verzendopties op de achtergrond bij (`refreshTotals` in `storefront-checkout.js`, verzoek
  `action=update` met alleen land, methode en btw-nummer); de knop *Totaal bijwerken* is
  met script verborgen en blijft zonder script werken. Bestellen tijdens een berekening
  wacht tot het totaal klopt.

- **Server**: `platform/address-lookup.js` (`createAddressLookup`, `registerAddressRoute`)
  vraagt PDOK (vast adres, geen invoer van een tenant) en onthoudt uitkomsten 24 uur
  (max. 2000); time-out 4 s, storing → 502 `unavailable`, ongeldige invoer → 400.
  Route `GET /api/address-lookup` (login, 60 per minuut per gebruiker/IP) en in de
  shop `GET /winkel/adres/` (30 per minuut per IP). De browser praat dus alleen met
  de eigen server: de CSP van de app blijft ongewijzigd; die van de shop kreeg
  `connect-src 'self'`. Tests vervangen PDOK via `createApp({ addressFetch })`.
- **Frontend**: één gedeelde component `shared/address-lookup.js`
  (`AddressLookup.attach` voor losse velden, `enhance`/`enhanceAll` voor elk element
  met `data-address-lookup`): debounce 400 ms, postcodecontrole, melding in een
  `role="status"` / `aria-live="polite"`, veld blijft bewerkbaar. Toegevoegd aan
  offertes (klant en bedrijfsprofiel), werkorders, facturen (klant en debiteur) en
  het meldformulier van het portaal.
- **Webshop**: afrekenen heeft postcode boven straat, met (alleen met script)
  huisnummer en toevoeging; alleen voor land NL. `layout()` accepteert meerdere scripts.

## 1.5.4

Verbeteringen aan de eigen webshop en de plaats van de bestellingen.

- **Webshopbestellingen onder Verkoop**: nieuwe module `webshop-bestellingen`
  (recht `beheer`, zijbalkgroep Verkoop) met de tabbladen Bestellingen en
  Retouren; ze zijn uit Beheer gehaald. De scripts `beheer/bestellingen.js` en
  `beheer/retouren.js` worden hergebruikt.
- **Afrekenen**: `afrekenen.js` werkt bij een andere verzendmethode het
  overzicht, het totaal en het verwachte totaal (`expectedTotal`) direct bij
  uit gegevens die de server per beschikbare methode meegeeft (`summaries`).
  Een ander land of btw-nummer rekent de pagina opnieuw door; zonder script
  blijft de knop *Totaal bijwerken*. Verzendkosten krijgen "incl. btw" of
  "excl. btw" (zakelijk) in de omschrijving; de berekening (21% over de
  verzendkosten, bij verlegging 0%) is ongewijzigd.
- **Productkaarten**: label "N varianten" bij een hoofdartikel met varianten;
  prijs en voorraadregel staan in `.product-foot` onderaan de kaart. Op de
  productpagina staat het aantal varianten bij de naam van de keuzelijst.
- **Retouren, klant**: formulier met opgemaakte keuzelijst en aantalveld
  (leeg met placeholder 0), eerdere retouren als kaarten met statuslabel.
  Een **afgewezen** retour telt voortaan mee in `COUNTING` (web-returns.js):
  die artikelen kunnen niet opnieuw worden ingediend (409, ook via de API);
  alleen een ingetrokken retour geeft ze weer vrij.
- **Retouren, Beheer**: artikelnaam en artikelnummer onder elkaar, tekstvak en
  knoppen in de stijl van Beheer.
- **Mededelingenbalk**: nieuw veld `notice.color` (sleutel uit
  `NOTICE_COLORS`: paars, donkerblauw, groen, turquoise, oranje, rood, grijs;
  de CSP van de shop staat geen inline stijl toe, dus een vaste lijst met
  klassen `kleur-<sleutel>` en leesbare achtergronden). Een onbekende
  waarde valt terug op paars.

## 1.5.3

Online betalen in de eigen webshop via Mollie (stap 8 van de webshop-roadmap).

- **Betaalwijze bij het afrekenen**: online (iDEAL, kaart en wat in Mollie
  aan staat) en/of op rekening. Instelling `shopPayment` (`online`,
  `publicUrl`, `onAccount` iedereen | zakelijk | nooit, `holdHours`) en
  geheim `mollieApiKey` (versleuteld, alleen hoofdtenant, Beheer > Webshop >
  Betalen). Zonder online betalen blijft op rekening bestellen werken.
- **Mollie-client** `webshop/mollie.js` (API v2: betaling aanmaken en
  opvragen, `Idempotency-Key` per poging); tests gebruiken
  `createApp({ mollieFetch })` en `test/helpers/mollie-fake.js`.
- **Betaalstroom** `webshop/web-payments.js`: de bestelling krijgt
  `data.pay` (open, betaald, mislukt, verlopen). Betaalpagina via
  `bestelling/<id>/betalen/` (nieuwe betaling als de vorige mislukte),
  webhook `POST mollie/webhook/<bestelling>/` (alleen het id komt mee; de
  uitkomst, het bedrag en de bestelling uit de metadata controleren we bij
  Mollie zelf) en terugkeer `?betaald=1` die de stand opvraagt. De overgang
  naar betaald gebeurt één keer (`web-orders.changePay`, in een transactie).
- **Bevestigingsmail** van een online bestelling gaat pas na de betaling;
  de factuur van een online betaalde bestelling ontstaat al bij de betaling
  (definitief en betaald, en zo ingesteld per mail naar de klant). Een
  een afrondingsverschil tussen bestelling en factuur wordt in de prijs van een
  gewone artikelregel verwerkt (geen aparte regel), zodat het factuurbedrag en
  de btw gelijk zijn aan wat de klant betaalde. Annuleren van een bestelling met een
  definitieve factuur maakt meteen een creditnota (`onCancelled`).
- **Verzenden pas na betaling** (409 bij een onbetaalde online bestelling);
  een onbetaalde online bestelling houdt de voorraad vast en vervalt na `holdHours`
  (`app.locals.webPaymentsExpire`, elk uur); betaald na annuleren geeft
  `refundNeeded` en een waarschuwing in Beheer (terugboeken via Mollie).
- Beheer: formulier Betalen, betaalstatus in de bestellijst en het detail.

## 1.5.2

Juridische pagina's in de eigen webshop (stap 7 van de webshop-roadmap).

- **Standaardpagina's** `pagina/algemene-voorwaarden/`, `pagina/privacyverklaring/`
  en `pagina/herroepingsrecht/` (met modelformulier), teksten in
  `webshop/legal-pages.js` met de bedrijfsgegevens uit de contactblokken. Een
  eigen pagina met dezelfde naam uit Beheer gaat voor. Links staan altijd in de
  voet (`foot-legal`).
- **Akkoord bij afrekenen**: verplicht vinkje (`terms`) met links naar de
  drie pagina's; `web-orders.place` weigert zonder akkoord (400, veld `terms`)
  en bewaart `data.consent` `{ terms, at }`.
- Bevestigingsmail van de bestelling noemt het herroepingsrecht (consument,
  14 dagen) en waar de voorwaarden staan.
- Beheer > Webshop-inhoud > Pagina's: knoppen om de standaardtekst van de
  drie pagina's te openen en aan te passen (`defaults.legal`).
- Testhulp `postCheckout` stuurt standaard `terms: 'ja'` mee.
- Testdata: een afspraakreactie in het verleden zonder vaste dag viel om zodra
  het later op de dag was dan het geplande tijdstip (`Invalid time value`); die
  krijgt nu het tijdstip van het vullen.

## 1.5.1

Retouren in de eigen webshop (stap 6 van de webshop-roadmap).

- **Retour aanvragen** door de klant op de bestelpagina
  (`/winkel/bestelling/:id/`, blok *Retourneren*): artikelen en aantallen
  kiezen, een reden (niet meer nodig, verkeerd besteld, defect, anders) en
  een toelichting. Kan binnen 14 dagen na verzending (`RETURN_DAYS`), alleen
  voor de eigen bestelling en nooit meer dan er is verzonden min wat al in
  een lopende of afgeronde retour zit. Een aangevraagde retour kan de klant
  intrekken. Formulier-POST's `bestelling/:id/retour` en
  `…/retour/:retourId/intrekken` met `Sec-Fetch-Site`-controle en limiet per
  IP (20 per uur).
- **Beheer > Webshopretouren** (`beheer/retouren.js`, API
  `/api/admin/web-returns`): goedkeuren, afwijzen (met verplichte reden),
  *Retour ontvangen en afronden* en Excel-export. Bij afronden gaan de
  artikelen terug op voorraad (`stock.book`, soort `retour`, bron
  `retour:<nummer>`) tenzij je dat uitzet (beschadigd).
- **Creditnota** (`creditReturn` in `web-order-invoices.js`): bij afronden een
  creditfactuur bij de factuur van de bestelling met alleen de teruggestuurde
  regels (zonder verzendkosten), zo ingesteld meteen definitief en per mail
  verstuurd; boekt de voorraad niet nog eens. Zonder (definitieve) factuur of
  met facturen voor webshopbestellingen uit staat de reden bij de retour en
  kan *Creditnota maken* later opnieuw. Eén creditnota per retour.
- **Mails** (`web-returns-mail.js`): bevestiging aan de klant en melding aan het
  bedrijf bij een aanvraag, het besluit (goedgekeurd met retouradres uit het
  bedrijfsprofiel, of afgewezen met reden) en een bericht bij afronden.
- Tabel `web_returns` (migratie 40, ook in `PG_MIGRATIONS`) met index op
  bestelling en op status; bij verwijderen van een klant wordt `user_id` leeg.
  Nummer `<bestelnummer>-R1`. Zonder testdata (testomgevingen hebben geen
  webshop, zie `NO_TESTDATA`).
- Tests: `test/web-returns.test.js`; de gedeelde opzet van de webshoptests staat
  nu in `test/helpers/webshop-world.js`.
- Een mislukte mail over de afgeronde retour is opnieuw te versturen met
  de knop *Mail opnieuw versturen* (`POST /api/admin/web-returns/:id/completion-mail`).
- Een creditconcept dat bleef staan (ook zonder foutmelding) wordt bij de
  volgende poging alsnog definitief gemaakt, tenzij definitief maken uit staat.

## 1.5.0

Verzendmail en bestelhistorie in de eigen webshop (stap 5 van de
webshop-roadmap).

- **Verzendmail** (`web-orders-mail.js`, `sendShipment`): bij Verzonden krijgt
  de klant een mail dat de bestelling onderweg is, met de volgcode en de
  DPD-link als die er is, of dat de bestelling klaarstaat om op te halen.
  Komt de volgcode later (`POST /api/admin/web-orders/:id/tracking`), dan volgt
  één mail met die code; dezelfde code nog eens geeft geen nieuwe mail. De
  uitkomst staat in `data.shipMail` en in Beheer > Bestellingen. Nieuwe haak
  `webOrders.onTracking` naast `onShipped`.
- **Bestelhistorie** in het klantaccount: `/winkel/bestellingen/` (nieuwe
  knop *Mijn bestellingen* bij Mijn account) met alleen de eigen
  bestellingen (`listForUser`, zonder regels); het detail toont verloop,
  volgcode en factuur. De bevestigingspagina met "Bedankt" verschijnt alleen
  direct na het plaatsen (`?bedankt=1`).
- **Factuur als PDF** voor de klant: `/winkel/bestelling/:id/factuur.pdf`, alleen
  voor de eigen bestelling en alleen een definitieve factuur (geen concept);
  anders 404, zonder sessie het inlogscherm.
- Tests: `test/order-history.test.js`.

## 1.4.9

Facturen en Visma voor bestellingen van de eigen webshop (stap 4 van de
webshop-roadmap).

- **Factuur bij Verzonden** (`backend/src/verkoop/web-order-invoices.js`): zodra
  een bestelling op Verzonden gaat maakt Aquatech er een factuur van
  (`shop_order_id` = `web:<bestelling>`, uniek per omgeving, dus één factuur
  per bestelling; geen migratie nodig). Regels uit de bestelling (excl. btw,
  tarief van de bestelling, verzendkosten als eigen regel), klant als
  debiteur (gekoppeld aan het klantaccount), btw verlegd met vermelding en
  btw-nummer op de factuur. De factuur wordt meteen definitief en boekt
  geen voorraad af (dat gebeurde al bij Verzonden); e-mail (`autoSend`) en
  Visma (`autoSync`) volgen de bestaande haken van definitief maken.
- **Instelling** `invoicing.webOrders` {`enabled`, `finalize`} (standaard
  allebei aan), te zetten in Facturen > Instellingen.
- **Beheer > Bestellingen**: de factuur staat in het detail (link naar
  Facturen); mislukt het maken, dan staat de fout erbij en maakt de knop
  *Factuur maken* (`POST /api/admin/web-orders/:id/invoice`, idempotent) de
  factuur opnieuw. `GET .../web-orders/:id` en de statusroute geven `invoice`
  mee. Betaling blijft op rekening: de factuur wordt handmatig op betaald gezet.
- Haak `webOrders.onShipped(hook)` in `web-orders.js`; fouten in de haak
  laten de verzending ongemoeid.
- Tests: `test/web-order-invoices.test.js`.

## 1.4.8

Btw en prijzen voor particulieren en zakelijke klanten in de eigen webshop
(stap 3 van de webshop-roadmap).

- **Klantgroep** (`users.customer_group`, migratie 39, SQLite en PostgreSQL):
  leeg = particulier, `zakelijk`. Een beheerder zet hem per klantaccount in Beheer >
  Gebruikers (kolom *Klantgroep*, alleen bij klantrollen); `PATCH
  /api/admin/users/:id` met `customerGroup`. Een klant kiest zijn groep niet zelf.
- **Zakelijke prijs** (`stock_items.business_price`, excl. btw, optioneel) bij
  Artikelen; zonder zakelijke prijs geldt de gewone verkoopprijs. Het wordt
  niet naar WooCommerce teruggeschreven.
- **Winkelwagen, afrekenen en bestelling** tonen aan een zakelijke klant de
  prijzen excl. btw met het totaal excl. btw, de btw per tarief en het totaal incl.
  btw (`totalsOf` rekent dan vanuit de bedragen excl.). Bedrijfsnaam is verplicht;
  een optioneel btw-nummer wordt op formaat per EU-land gecontroleerd (`vat.js`).
- **Btw verlegd**: een zakelijke klant met een geldig btw-nummer van het land van
  aflevering, bij bezorging in een ander EU-land dan Nederland, krijgt de bestelling
  (ook de verzendkosten) zonder btw. Het nummer wordt alleen op formaat gecontroleerd,
  niet bij VIES; controleer het nummer zelf voor je de levering factureert. Ophalen
  is altijd een levering in Nederland (gewone btw).
- Bestelling: `customerGroup`, `vat` ({ number, shifted }), regels met `lineExcl`;
  Beheer > Bestellingen toont groep, btw-nummer en verlegging; de Excel-export heeft
  kolommen Klantgroep, Btw-nummer en Btw verlegd; de bevestigingsmail toont de
  totalen excl. btw of *btw verlegd*.
- Beperking: de productlijsten en productpagina's blijven de prijs incl. btw voor
  iedereen tonen (ze zijn voor alle bezoekers hetzelfde); de zakelijke prijs verschijnt
  in de winkelwagen.

## 1.4.7

Verzending in de eigen webshop (stap 2 van de webshop-roadmap): ophalen en
bezorging door DPD.

- **Instelling `shopShipping`** (`webshop/shipping.js`, alleen hoofdtenant, Beheer >
  Webshop en WooCommerce > Verzending): ophalen (gratis, naam en toelichting),
  DPD met tarieven per land en gewichtsklasse, gratis vanaf een bedrag per land en
  een standaardgewicht voor artikelen zonder gewicht. Zonder instelling gelden
  indicatieve startwaarden (DPD Nederland), zodat bestellen blijft werken.
- **Gewicht per artikel** (`stock_items.weight_grams`, migratie 38, SQLite en
  PostgreSQL), in te vullen bij Artikelen; varianten erven het gewicht van het
  hoofdartikel bij aanmaken.
- **Afrekenen**: de klant kiest ophalen (geen adres nodig) of DPD (land, kosten
  of *Gratis*, of de reden waarom het niet kan, zoals te zwaar). De server
  controleert de keuze opnieuw bij het plaatsen en rekent de verzendkosten (21%
  btw) mee in het btw-overzicht en het totaal. Postcode wordt per land gecontroleerd.
- **Bestelling**: `data.shipping` (methode, kosten, gewicht, volgcode), het land
  bij het adres; verzending staat op de bevestigingspagina en in de mail.
- **Track & trace**: bij *Verzonden* (of achteraf, `POST
  /api/admin/web-orders/:id/tracking`) legt de beheerder de DPD-volgcode vast;
  de klant ziet een link naar de volgpagina van DPD. Excel-export heeft kolommen
  Verzending, Verzendkosten en Volgcode.
- Beperking: de verzendkosten gelden voor één btw-tarief (21%); btw per
  klantsoort volgt in 1.4.8.

## 1.4.6

Winkelwagen en bestellen op rekening in de eigen webshop (stap 1 van de
webshop-roadmap).

- **Aan/uit**: instelling `shopOrdering` (Beheer > Webshop en WooCommerce, alleen
  hoofdtenant, standaard uit). Uit = de knop *In winkelwagen* blijft zoals hij was.
- **Winkelwagen** (`storefront-cart.js`): cookie met codes en aantallen, zonder
  script; pagina's `winkelwagen/`, `afrekenen/` en `bestelling/<id>/`. Prijs,
  btw en voorraad komen bij elke pagina en bij het plaatsen opnieuw uit de
  database (`web-orders.js`, `priceCart`), nooit uit de cookie.
- **Bestellen**: alleen ingelogd (inloggen/registreren sturen met `?volgende=afrekenen`
  terug naar het afrekenen). Tabel `web_orders` (migratie 37, SQLite en
  PostgreSQL), nummer `WEB-<jaar>-0001`. Een bestelling reserveert de voorraad
  in `stock_reservations` (`work_order_id` `order:<id>`), dus de beschikbare
  stand in de shop, Artikelen en WooCommerce klopt meteen.
- **Status**: nieuw, verzonden, afgerond, geannuleerd. *Verzonden* boekt de
  artikelen af (bron `bestelling:<nummer>`), *Annuleren* geeft de reservering vrij.
- **Mail** (`web-orders-mail.js`): bevestiging aan de klant en melding aan het
  bedrijfsadres uit het bedrijfsprofiel; een mislukte mail houdt de bestelling
  niet tegen en staat bij de bestelling.
- **Beheer > Webshopbestellingen**: lijst met filter en zoeken, detail, statusknoppen
  en export naar Excel (bestellingen en regels). API `/api/admin/web-orders`.
- Beperking: geen verzendkosten (komen in de volgende stap), alleen aflevering in
  Nederland, betalen alleen op rekening; er is nog geen factuur per bestelling.

## 1.4.5

Voorraadstand in de eigen webshop.

- **Stand**: de shop gebruikt de voorraad uit het systeem (`stock_items.on_hand`
  min de reserveringen voor open werkorders, dezelfde beschikbare stand die naar
  WooCommerce gaat); per variant en bij een hoofdartikel op voorraad als een
  variant dat is. Er gaan nooit aantallen naar de bezoeker, alleen
  *Op voorraad* of *Niet op voorraad*.
- **Filter**: `?voorraad=1` op categorie en zoeken toont alleen wat op voorraad
  is (keuze *Alles / Alleen op voorraad*); de omleiding van `categorie/<slug>`
  naar `categorie/<slug>/` behoudt de querystring.
- **Waarschijnlijke oorzaak 'alles niet op voorraad'** (live shop: 882 regels
  niet, 0 wel op voorraad; de database zelf niet ingezien): mogelijk geen fout in de
  shop, maar nog te controleren op `on_hand`, reserveringen en synchronisatiestatus. Artikelen die uit
  WooCommerce zijn overgenomen krijgen alleen een beginstand als het product
  daar voorraadbeheer heeft (`manage_stock` met aantal) en de koppeling
  voorraad synchroniseert; anders blijft `on_hand` 0 totdat er geteld of
  geboekt wordt bij Artikelen.

## 1.4.4

Beheer: dezelfde layout op elk tabblad.

- `frontend/beheer/beheer.css`: één vaste container. Het zijmenu (zoekveld +
  sectielijst) staat strak links; de inhoud rechts heeft op elke sectie
  dezelfde positie en breedte (max. 1180 px, formulieren niet meer smaller
  dan tabellen). `scrollbar-gutter: stable` voorkomt dat de inhoud
  opschuift als een sectie een scrollbalk krijgt.

## 1.4.3

Artikelen met varianten staan in de webshop als één regel met een keuzelijst.

- **Lijst** (`webshop/storefront-pages.js`, `variantRow`): in categorie en
  zoekresultaat één regel per hoofdartikel met foto, naam, artikelnummer en
  kenmerken, een keuzelijst (naam van het kenmerk, anders *Uitvoeringen*) met
  "N varianten", en rechts prijs incl. btw, voorraad, aantal en een
  winkelwagenknop (nog uitgeschakeld, bestellen volgt). Elders (startpagina,
  uitgelicht) toont de kaart "Vanaf" de laagste prijs.
- **Catalogus** (`storefront-data.js`): `buildCatalog` voegt varianten (`parent_id`)
  samen onder hun hoofdartikel (`products` bevat de hoofdartikelen, `variantProducts`
  de losse varianten); categorietellingen tellen één regel per hoofdartikel. Nog
  steeds één query. Hoofdartikel zonder zichtbare variant komt niet in de shop.
- **Keuze**: `product/<slug>/?v=<artikelnummer>` toont de gekozen variant (ook
  zonder script, met de knop *Kies*); een variant blijft op zijn eigen adres
  bereikbaar met een link naar alle uitvoeringen.
- **Script**: alleen op pagina's met een variantenregel, `assets/varianten.js`
  (eigen bestand, geen inline); de shop-CSP kreeg `script-src 'self'`.

## 1.4.2

De inhoud van de eigen webshop (`winkel/`) is zelf te bewerken in Beheer.

- **Beheer → Integraties → Webshop-inhoud** (`frontend/beheer/webshop-inhoud.js`,
  recht `beheer`): blokken van de startpagina (mededelingenbalk, hero,
  voordelen, merken, zakelijk blok), contactgegevens en tekst in de voet, vaste
  pagina's met een eenvoudige tekst-editor (kop, subkop, vet, cursief, lijsten,
  citaat, links, afbeeldingen) en een afbeeldingenbibliotheek.
- **Concept en publiceren**: wijzigingen zijn eerst een concept; bezoekers zien
  pas wat is gepubliceerd. Een beheerder bekijkt het concept met
  `?voorbeeld=1` op de shop. Concept weggooien en de vorige gepubliceerde
  versie terugzetten kan per onderdeel.
- **Opslag** (`backend/src/webshop/shop-content.js`, migratie 36 in `MIGRATIONS`
  en `PG_MIGRATIONS`): `shop_content` (concept, gepubliceerd, vorige versie, per
  tenant) en `shop_images` (versleuteld met `vault.sealBytes`, type op inhoud
  gecontroleerd, EXIF eruit, geen SVG). Zonder opgeslagen inhoud geldt de
  standaard, die gelijk is aan de shop van 1.4.1.
- **Saneren**: pagina-HTML gaat door een whitelist (alinea's, kopjes, lijsten,
  vet, cursief, citaat, https/mailto/tel-links, eigen afbeeldingen); scripts,
  stijlen en andere attributen verdwijnen. Alle blokvelden worden begrensd.
- **Shop**: nieuwe routes `pagina/<naam>/` en `media/<id>`; de pagina `over-ons`
  uit Beheer vervangt de standaardpagina Over ons. Pagina's met menu of voet
  komen in kop en voet. De webshop-inhoud geldt alleen voor de hoofdtenant
  (andere omgevingen: 404 op de API).
- **Audit**: `webshop_inhoud_*`, `webshop_pagina_verwijderd`,
  `webshop_afbeelding_*`.

## 1.4.1

Uitlijning van de webshop en een eigen pagina Over ons.

- **Uitlijning** (`storefront.css`): de titel van een productkaart heeft een
  vaste hoogte van drie regels (daarna afgekapt, volledige naam in het
  `title`-attribuut), zodat prijs en voorraad op elke kaart op dezelfde lijn
  staan. De regels in de kolommen op de startpagina hebben een vaste hoogte
  (foto 80 px, titel twee regels, prijs en voorraadstand) en liggen daardoor
  naast elkaar op één lijn.
- **Kopbalk**: de lichte streep tussen het menu en de foto (rand onder
  `.shop-head`) is weg. De telefoonlink heeft een `aria-label`, ook als de
  tekst op een smal scherm verborgen is.
- **Over ons** (`webshop/storefront-pages.js` `aboutPage`, route `over-ons/`):
  eigen pagina met de tekst en afbeeldingen van aquatechshop.nl/over-ons/ in
  plaats van een verwijzing naar aquatechservice.nl, in menu en voet.

## 1.4.0

Voorraadbeheer is overal hernoemd naar **Artikelen**; de werking, de opslag en
het recht `voorraad` blijven gelijk.

- **Module**: map `frontend/voorraad/` is `frontend/artikelen/` (`artikelen.js`,
  `artikelen.css`), adres `artikelen/`. De oude adressen `voorraad`, `voorraad/`
  en `voorraad/…` (met querystring) sturen relatief door naar `artikelen/…`.
- **Backend**: `backend/src/voorraad/` is `backend/src/artikelen/`. API
  (`/api/stock…`), tabellen, recht en module-sleutel `voorraad` (instelling
  `modules`) blijven ongewijzigd, zodat bestaande rollen en instellingen
  blijven werken.
- Teksten en verwijzingen aangepast in de rolomschrijving, werkorders,
  planner, Beheer → Webshop, facturen en de artikelkiezer.

## 1.3.9

Beheer en de zijbalk zijn overzichtelijker ingedeeld; niets verandert aan de
werking of de opslag.

- **Beheer**: de tabbladen en het lange tabblad *Instellingen* zijn vervangen
  door een zijmenu met zes groepen (Overzicht, Organisatie & gebruikers,
  Modules, Integraties, Toegang & beveiliging, Systeem). Elke sectie heeft een
  eigen pagina en adres (`beheer/#mail`, `#ai`, `#access`, `#modules`,
  `#outsourcing`, `#season`, `#security`, `#backup`; de overige behouden hun
  naam). `#settings` opent *Modules aan/uit*. Zoekveld *Zoek instelling* filtert
  op naam en trefwoorden. Op een smal scherm klapt het menu uit. Nieuw bestand
  `beheer/indeling.js` met de indeling.
- **Eigen webshop** (`storefront`, `shopPlanner`): staan nu bij *Webshop en
  WooCommerce* in plaats van onder *Toegang*, in een eigen formulier `#s-shop`.
- Verwijzingen in meldingen en docs (Beheer → Integraties → E-mail, → Webshop,
  → Modules → Uitbesteden) en links in Offertes en Uitbesteden aangepast.
- **Zijbalk**: modules staan in inklapbare groepen *Ontwerpen*, *Verkoop*
  (incl. Klantdossiers) en *Uitvoering*; Nieuws staat bovenaan, Artikelen
  (voorheen Voorraadbeheer, alleen de zichtbare naam; de rest volgt in 1.4.0)
  los eronder. De groep met de huidige pagina staat open, de rest onthoudt de
  gebruiker. Ingeklapte zijbalk toont alle iconen. `navGroup` in
  `dashboard/modules.js` kiest de groep.

## 1.3.8

De webshop (`winkel/`) heeft de opzet van aquatechshop.nl als basis, en een
verouderd stijlbestand in de browser kan de shop niet meer breken.

- **Cache**: elke link naar CSS, logo en afbeeldingen van de shop draagt
  `?v=<versie>` (`assetUrl` in `storefront-pages.js`). Met versie een jaar
  `immutable`, zonder versie 5 minuten (was 24 uur zonder versie, waardoor een
  oude CSS na een uitrol bleef hangen).
- **Header**: mededelingenbalk, klantenservicenummer, groene knop *Product
  zoeken* met uitklapmenu, *Over ons* en de hoofdgroepen. Alleen CSS, geen scripts.
- **Startpagina**: foto met kop, assortimentsbalk (horizontaal scrollbaar, met
  een productfoto per hoofdgroep), *Populaire producten*, drie kolommen met
  producten per hoofdgroep, voordelen, merken en een oproep voor een zakelijk
  account (knop naar registreren). Afbeeldingen staan in `webshop/assets/`.
  Uitgelichte producten worden aangevuld met producten zonder voorraad als er te
  weinig op voorraad zijn, zodat de startpagina nooit zonder plaatjes is.
- **Voet**: kvk, adres, contact, account en betaalmethoden. Productpagina heeft
  een uitgeschakelde knop *In winkelwagen*; echt bestellen volgt in een
  volgende stap.

## 1.3.7

Accounts in de webshop zijn de accounts van de planner: registreren of inloggen
in `winkel/` maakt of gebruikt een account met de rol klant, met dezelfde
sessie als de rest van de app. Geen aparte shop-accounts.

- **Webshop** (`webshop/shop-accounts.js`, `storefront-account-pages.js`):
  pagina's `inloggen/`, `registreren/`, `account/` en formulieren (POST, zonder
  scripts; CSP ongewijzigd). Inloggen met gebruikersnaam of e-mailadres, alleen
  in de tenant van de shop; registreren maakt een klant (gebruikersnaam
  afgeleid van het e-mailadres, `store.createShopCustomer`), logt meteen in en
  weigert een tweede account met hetzelfde e-mailadres. Beveiliging: limiet per
  IP (inloggen 20 per 15 min, registreren 5 per uur), blokkering per
  gebruikersnaam zoals het gewone inlogscherm, verborgen valstrikveld,
  `Sec-Fetch-Site`-controle, wachtwoordbeleid van de app, auditlog
  (`ingelogd`/`klant_geregistreerd` met `via: winkel`). Mijn account heeft knoppen
  *Naar de planner*, *Mijn portaal* en *Mijn profiel*.
- **Kopje Planner** in de navigatie van de shop (instelling `shopPlanner`,
  standaard aan, Beheer → Instellingen → Toegang, alleen hoofdtenant): zonder
  account een aanmeldformulier met alleen naam, e-mail en wachtwoord, daarna
  direct naar de planner; met account meteen naar de planner. Uit = kopje
  verborgen en `planner/` geeft 404.
- **Database**: migratie 35 (index `users (tenant_id, email)`), ook in
  `PG_MIGRATIONS`. `store.accountIdsByEmail`, `loginNameFor`.

## 1.3.6

Bekijken als klant (klantweergave): een beheerder ziet de app in een
testomgeving precies zoals een klant hem ziet, om te testen.

- **Server** (`beveiliging/impersonation.js`): `GET|POST
  /api/admin/view-as-customer` (recht `beheer`). Alleen in een testomgeving:
  in live geeft GET `{ available: false }` en weigert POST het starten met
  403 `test_only`. Alleen accounts met een klantrol (`keysOfKind
  'klant'`) van de eigen organisatie (de testomgeving zelf of de live-tenant
  erboven; anders 404), geen wachtwoord of toestemming van de klant nodig.
  Zelfde cookie-mechanisme als de impersonatie van de hoofdbeheerder, met
  `impersonations.mode = 'klant'` (migratie 34), hoogstens 2 uur. Bij elk
  verzoek opnieuw gecontroleerd: nog beheerder van die omgeving, omgeving nog
  test en actief, doel nog een actieve klant; anders direct beëindigd.
  `identify()` laat `resolve` nu voor elk account de cookie controleren.
  Tijdens de klantweergave alleen de rechten van de klant (geen beheer, geen
  omgevingswissel, geen nieuwe impersonatie). Auditlog
  `klantweergave_gestart`/`klantweergave_beeindigd` in de testomgeving; acties
  tijdens de weergave krijgen `impersonatie: <beheerder>`. Terug naar beheer
  houdt de beheerder in dezelfde testomgeving.
- **Frontend**: blok *Bekijken als klant* in Beheer → Gebruikers (in live alleen
  uitleg), balk bovenin elke pagina "Je bekijkt als …" met *Terug naar beheer*
  (`shared/env.js`, hint-cookie `…|klant`), knop in de kopbalk
  (`dashboard/account.js`).

## 1.3.5

Webshop (`winkel/`): een echt ontwerp in de stijl van aquatechshop.nl.

- **Ontwerp** (`webshop/storefront-pages.js`, `storefront.css`): kopbalk met het
  woordmerk Aquatechshop.nl, zoekveld, account en winkelwagen (nog zonder
  werking), menu van hoofdcategorieën met uitklappers (alleen CSS; op een smal
  scherm één menuknop), startpagina met hero, productgroepen met hun
  subcategorieën en uitgelichte producten met foto, voet met navigatie.
  Kleuren navy `#1b3768`, turquoise `#37bac8`, groen `#1a9f5b`.
- **Hoofdcategorieën** (`storefront-data.js`, `groupOf`): WooCommerce geeft
  alleen platte categorienamen; die worden op naam ingedeeld in Beregening,
  Elektra, Pomp & techniek en Leidingen & toebehoren (zoals het menu van
  aquatechshop.nl), de rest in Overig. Nieuwe pagina `groep/<slug>/`.
  `featured` kiest om en om per groep producten met foto die op voorraad zijn.
- **Zoeken** (`zoeken/?q=`): op naam, artikelnummer en categorie; CSP
  `form-action 'self'`.
- **HTML-tekens** (`webshop/html-entities.js`): `&amp;` e.d. in product- en
  categorienamen worden bij de import (`woocommerce.js`) en bij het tonen
  gelezen.
- **Logo's**: icoon als favicon (shop, planner, login-, setup-, wachtwoord- en
  openbare pagina's via `shared/common.js` of een eigen link) en als logo in de
  ingeklapte zijbalk (`shared/icons/logo-icon.png`); de uitgeklapte zijbalk
  houdt het AquaTech Service-logo.

## 1.3.4

Varianten: drie correcties na de review van 1.3.3.

- **Facturen** (`verkoop/invoices.js`): een losse factuur met de code van een
  hoofdartikel boekt niets af (een hoofdartikel heeft geen eigen voorraad);
  gewone artikelen en varianten wel.
- **Werkorders per hoofdartikel** (`voorraad/stock.js`): `listRows` telt in
  dezelfde query `family_orders` (unieke `work_order_id` over de actieve
  varianten); een werkorder met twee maten telt bij het hoofdartikel één keer.
- **WooCommerce** (`webshop/woocommerce.js`): mislukt bij `createVariations`
  een latere batch, dan blijven de resultaten van de eerdere batches bewaard en
  krijgt alleen die batch een fout per variatie.

## 1.3.3

Artikelen met varianten (maat, lengte, kleur), ook in de webshopkoppeling.

- **Datamodel** (migratie 33 in `MIGRATIONS` en `PG_MIGRATIONS`):
  `stock_items.parent_id`, `has_variants`, `attributes` (kenmerken van het
  hoofdartikel, JSON `[{ name, values }]`) en `variant_values` (waarden van een
  variant, JSON); index `(tenant_id, parent_id)`. `shop_products` krijgt
  `parent_id` en `attributes` voor WooCommerce-variaties.
- **Voorraad** (`voorraad/stock.js`): `setVariants` maakt van een artikel
  zonder voorraad/boekingen een hoofdartikel en maakt elke ontbrekende
  combinatie aan als variant (code `<hoofdcode>-<waarden>`, prijzen, eenheid,
  btw, omzetgroep en webshopinstelling van het hoofdartikel). Een variant is
  een gewoon voorraadartikel (eigen code, prijs, kostprijs, voorraad, minimum,
  bestellen tot); het hoofdartikel heeft geen eigen voorraad (mutaties 409),
  toont de totalen en staat niet in het bestelvoorstel, de verkoopinfo of de
  eigen webshop. Eenheid, btw en omzetgroep volgen het hoofdartikel;
  archiveren/terugzetten en verwijderen nemen de varianten mee.
- **Werkorders**: de code van een hoofdartikel reserveert niets;
  `GET /api/stock/workorders/:id` geeft die regels als `chooseVariant`.
- **API**: `PUT /api/stock/items/:id/variants` (recht `voorraad`),
  `GET /api/stock/articles` (werkorders, offertes of voorraad; zonder
  inkoopprijs) en `POST /api/stock/items/:id/publish` (artikel of hoofdartikel
  als nieuw product in WooCommerce, recht `voorraad`, gelimiteerd).
- **WooCommerce** (`webshop/woocommerce.js`, `shop-sync.js`): via de REST API
  komen de variaties van variabele producten mee; een variabel product wordt
  een hoofdartikel, variaties worden varianten (`shop_product_id` = id van de
  variatie). Prijs en voorraad per variatie via
  `/products/<id>/variations/batch`. Met *Aquatech is de bron* worden
  ontbrekende variaties van een gekoppeld hoofdartikel aangemaakt (eerst
  koppelen op sku of waarden, kenmerken van het product aangevuld, andere
  kenmerken blijven staan).
- **Voorraadbeheer**: hoofdartikel klapt uit in de lijst, blok *Varianten*
  op de artikelpagina (kenmerken + varianten), knop *In webshop zetten*;
  Excel-export met kolommen Hoofdartikel en Variant.
- **Werkorder en offerte**: knop *+ Uit voorraad* (`shared/article-picker.js`):
  eerst het artikel, dan per kenmerk de waarde; *Kies maat* bij een regel met
  de code van een hoofdartikel. De planner kiest de maat zelf; varianten met
  een catalogus-code tellen mee in het assortiment.
- Tests: `test/variants.test.js`; testdata krijgt een tuinslang met drie
  lengtes.

## 1.3.2

Artikeleenheden beheren en een ruimere indeling van de artikelpagina.

- **Eenheden** (`stock_units`, migratie 32 in `MIGRATIONS` en `PG_MIGRATIONS`):
  per omgeving een lijst eenheden (standaard st, m, m², rol, set, zak, kg, l,
  uur plus wat artikelen al gebruiken). API `GET|POST /api/stock/units` en
  `DELETE /api/stock/units/:id` (recht `voorraad`, dubbel = 409, in gebruik =
  409). Een artikel met een nieuwe eenheid (API, import) zet die vanzelf in de
  lijst.
- **Voorraadbeheer**: het veld *Eenheid* (nieuw artikel en artikelpagina) is
  een keuzelijst; knop *Eenheden* opent het beheer (toevoegen, verwijderen).
- **Opmaak**: meer ruimte tussen velden en knoppen (Boeken, Opslaan,
  Verwijderen) in de formulieren van Voorraadbeheer.
- Tests: `test/stock.test.js`; testdata krijgt een eigen eenheid.

## 1.3.1

Opzet van de eigen webshop (stap 1, alleen lezen), als module van dit systeem.

- **Openbare pagina's op `winkel/`** (`webshop/storefront.js`, router die ook
  op een eigen domein of in een eigen container te monteren is): startpagina
  met categorieën en producten, categoriepagina (`categorie/<slug>/`) en
  productpagina (`product/<slug>/`, zoals WooCommerce). Server-side HTML
  zonder scripts, eigen eenvoudig ontwerp in de AquaTech-huisstijl
  (`--at-*`-kleuren, Montserrat, logo), alle adressen relatief.
- **Gegevens** (`webshop/storefront-data.js`): niet-gearchiveerde
  voorraadartikelen met verkoopprijs en *Naar webshop* aan; categorie en
  afbeelding komen uit het gekoppelde webshopproduct (`shop_products`),
  prijs wordt incl. btw getoond, voorraad alleen als op voorraad/niet.
  Inkoopprijs, locatie, notities en aantallen komen er niet in. Eén query
  (LEFT JOIN), 30 s cache per omgeving.
- **Instelling** `storefront` (Beheer → Instellingen → Toegang, standaard
  uit): zolang uit geeft `winkel/` overal 404. De shop toont de artikelen van
  de hoofdtenant.
- **Beveiliging**: alleen GET/HEAD, limiet per IP (240/min), eigen CSP
  (geen scripts, afbeeldingen alleen https), namen ontsnapt, vaste lijst
  bestanden voor assets/lettertypen. Geen winkelwagen, betaling of accounts
  (volgen later).
- Tests: `test/storefront.test.js`.

## 1.3.0

Webshop leidend voor de voorraadlijst.

- **Alles overnemen**: bij een webshopkoppeling maakt elke volle synchronisatie
  (knop *Alles uit webshop* in Voorraadbeheer, Beheer → Webshop en elke 10
  minuten, ook zonder terugschrijven) van elk webshopproduct een voorraadartikel.
  Producten zonder sku of `aquatech_code` krijgen de code `WC-<product-id>`.
- **Opruimen**: artikelen die niet (meer) in de webshop staan worden
  *gearchiveerd*, niet verwijderd, zodat werkorders, offertes en facturen
  intact blijven; reserveringen vervallen. Staat een product later weer in de
  webshop, dan komt het artikel terug. Artikelen met een bestaande
  productkoppeling blijven gekoppeld, ook als de sku wijzigt.
- **Aquatech als toekomstige bron**: instelling *Webshop bepaalt de artikellijst* (Beheer → Webshop, standaard aan). Uit = geen automatisch aanmaken of archiveren meer; het WooCommerce product-ID blijft per artikel bewaard voor terugschrijven.
- **Voortgangsvenster** met balk bij het overnemen; de keuzelijst met
  producten is vervallen. Zonder webshopkoppeling verandert er niets.

## 1.1.1

- Inloggen met een testaccount (`<testomgeving>.<naam>`) werkt ook als de organisatiecode leeg of verkeerd is, bijvoorbeeld doordat de browser de code van de hoofdbeheerder onthoudt. De testomgeving wordt dan uit de gebruikersnaam gehaald (alleen testomgevingen).

## 1.0.1

- Planner: het eigenschappenpaneel rechts (en de lege strook die het opleverde) verdwijnt zolang er niets geselecteerd is en er geen aandachtspunten zijn; de tekening gebruikt de volle breedte. Het paneel is 260 px i.p.v. 280 px.

## 0.72.1

- Klantportaal: geen melding "Er staat nog niets voor u klaar" meer als er alleen een seizoensherinnering staat.
- Test voor de verzendronde: na drie tijdelijke fouten stopt de ronde. Tijdelijk geweigerde ontvangers worden niet vastgelegd en komen in een volgende ronde opnieuw aan de beurt.

## 0.72.0

Seizoensherinneringen voor klanten (voorjaar opstarten, najaar winterklaar).

- **Instelling** `seasonReminders` per omgeving (Beheer → Instellingen):
  aan/uit (standaard uit), adres van het klantportaal voor de knop in de mail
  en de herinneringen (sleutel, onderwerp, dag/maand, tekst; standaard
  voorjaar 15 maart en najaar 1 oktober).
- **Verzendronde** (`uitvoering/season-reminders.js`, elk uur vanuit het
  onderhoud, `app.locals.seasonRemindersAll`): tot 21 dagen na de datum een
  mail via de eigen mailserver aan actieve klantaccounts met e-mailadres en
  een werkorder in die omgeving (via offerte of melding). Tabel
  `season_reminders_sent` (migratie 31) houdt bij wie welke herinnering in
  welk jaar kreeg; hoogstens 100 mails per omgeving per ronde.
  Een testomgeving mailt alleen haar eigen testaccounts (nooit live-klanten),
  een uitgeschakelde organisatie niets.
- **Klantportaal**: blok *Seizoensonderhoud* (twee maanden na de datum) met
  *Afspraak aanvragen* (meldformulier als onderhoud, ook via
  `portaal/?herinnering=<sleutel>` uit de mail) en een vinkje om de mails
  uit te zetten (voorkeur `seasonReminders`).
- Testdata: klanten met een installatie kregen vorig najaar de herinnering.
## 0.71.0

Nacalculatie per werkorder.

- Blok **Nacalculatie** op de werkorder (`werkorders/costing-panel.js`, kern
  `werkorders/costing-core.js`, UMD): begroot uit de geaccordeerde offerte
  (zonder offerte: werkstappen en materiaallijst) tegenover de geboekte uren
  en het materiaalverbruik, met verschil per onderdeel en per artikel.
  Kosten = uren × kostprijs per uur + verbruik × inkoopprijs uit de voorraad;
  opbrengst = definitieve/betaalde facturen van de werkorder (credit negatief),
  anders de offerte netto of, zonder offerte, een schatting uit de
  werkorderbegroting. Marge in euro en procent; waarschuwingen bij
  ontbrekende kost-/inkoopprijzen of conceptfacturen. Excel-export
  (samenvatting + materiaal), geen CSV.
- API `GET /api/workorders/:id/costing` (`backend/src/uitvoering/costing.js`),
  nieuw recht **nacalculatie** (standaard alleen beheerder, `needs`
  werkorders). Vast aantal queries (`test/queries.test.js`), geen migratie.
- Bedrijfsgegevens: nieuw veld **Kostprijs per uur** (`quoteProfile.hourlyCost`,
  standaard 0 = niet ingevuld). `stock.saleInfo(..., { withCost: true })` geeft ook `costPrice` (alleen voor de nacalculatie); `hourlyCost` gaat niet naar klanten of de openbare offerte.

## 0.70.2

Installatiedossier per locatie: alles van één adres bij elkaar.

- **Klantdossiers**: tweede weergave *Per locatie* (`?weergave=locaties`,
  detail `?locatie=<sleutel>`) met per adres de installaties (oplevering,
  ontwerp, zones, foto's), plannen, offertes, meldingen en de materialen
  (geplaatst volgens de werkorder en verbruikt volgens de urenregistratie).
  Excel-export van de locaties; afdrukken als opleverrapport. Adressen in het
  klantdossier linken naar het installatiedossier.
- **Klantportaal**: blok *Mijn installaties per adres* met het dossier van de
  eigen werkorders en meldingen, zonder bedragen, verbruik, uren, interne
  notities en interne foto's (`#locatie=<sleutel>` opent het direct).
- Geen nieuwe tabel of migratie: de locatie is het adres, vergelijkbaar
  gemaakt met `locationKey` (photos.js: kleine letters, zonder leestekens,
  postcode en huisnummertoevoeging aaneen, SHA-256). Store en routes in `uitvoering/locations.js`:
  `GET /api/locations[/:key]` (recht `werkorders`) en
  `GET /api/portal/locations/:key` (recht `portaal`, zelfde klantregel als
  `OF_CUSTOMER` in workorders.js). Vast aantal queries (id's per omgeving,
  daarna `IN (...)`), getest in `queries.test.js`.

## 0.70.1

Opschoonronde planner (laatste deel): duidelijke namen en een commentaarblok
bij elke functie in `beregening/js/`, zonder gedragswijziging. Opgeschoond:
`planimport.js`, `autotrace.js`, `concept.js`, `simulation.js`, `geometry.js`,
`sprinklerlib.js`, `hydraulics.js`, `bom.js`, `catalog.js`, `editor.js`,
`localrecog.js` en `app.js`. Exportnamen, opgeslagen sleutels en
eigenschappen van het datamodel (zoals `pts`, `r`, `w`/`h` in uitvoer) zijn
ongewijzigd. `tools/codestyle-baseline.json` is nu leeg: alle eigen code
voldoet aan de codestijl.

## 0.70.0

Bestelvoorstel bij lage voorraad.

- **Voorraadbeheer**: nieuwe kolom `stock_items.reorder_qty` (migratie 30,
  SQLite en PostgreSQL), in het artikel als *Bestellen tot* (leeg = 2×
  minimum; lager dan het minimum telt als 2× minimum).
- `GET /api/stock/reorder` (recht `voorraad`, per omgeving): artikelen waarvan
  beschikbaar (stand − gereserveerd) onder het minimum ligt, met
  `target`, `orderQty` (aanvullen tot `target`, naar boven afgerond op hele
  eenheden), `amount` (op inkoopprijs) en het totaal. Eén query (`list`).
- Knop **Bestelvoorstel** maakt er een Excel van (tabblad *Bestelvoorstel*,
  met totaalregel); de gewone voorraadexport heeft de kolom *Bestellen tot*.
- Testdata vult *Bestellen tot* bij een deel van de artikelen.
## 0.69.1

Opschoonronde frontend deel 3: duidelijke namen en een commentaarblok bij elke
functie, zonder gedragswijziging. Opgeschoond: `sw.js`, `portaal/portaal.js`,
`werkorders/worklog.js`, `planning/planning.js`, `voorraad/voorraad.js`,
`hoofdbeheer/hoofdbeheer.js`, `beheer/beheer.js`, `facturen/facturen.js`,
`offertes/offertes.js` en `werkorders/werkorders.js`; ze staan niet meer in
`tools/codestyle-baseline.json`. De wijzigingen uit 0.69.0 (eigenaar in de
offline wachtrij) zijn in de opgeschoonde `sw.js` en `worklog.js` meegenomen.

- `body-parser` 1.20.9 (lockfile; `npm audit` meldde GHSA-27r3-jxmh-p828).

## 0.69.0

Beveiligingsronde naar aanleiding van een geautomatiseerde code-analyse (24
bevindingen opgelost; de PDF-decoder van pdf.js in `vendor/` blijft zoals hij is).

- **Offline wachtrij**: een bewaarde wijziging draagt `X-Aquatech-Owner`
  (`<gebruiker>@<omgeving>`); de server voert hem niet uit als er intussen
  iemand anders is ingelogd (409 `owner_mismatch`). Alleen de bekende
  werkorder-wijzigingen mogen nog in de wachtrij (`QUEUEABLE` in
  offline-core). Een laat antwoord van de vorige gebruiker komt niet meer in
  de offline cache. De terugval-wachtrij van de urenregistratie bewaart de
  eigenaar per regel; regels zonder eigenaar of van een ander account worden
  niet onder de huidige gebruiker geboekt.
- **Planner**: het lokale concept bewaart van wie het is en wordt alleen aan
  die gebruiker getoond (ook op het dashboard); uitloggen wist het. Plangegevens
  uit bestand, server of tekening worden opgeschoond (`sanitizePlan`: tekst
  blijft tekst, getallen binnen bereik, coördinaten binnen 5 km, elke zone één
  keer) en waarden in invoervelden ge-escaped. Rasterlijnen met een telling
  (geen eindeloze lus bij grote coördinaten), meetraster van automatisch
  plaatsen hoogstens 250.000 cellen, projectvelden altijd als tekst in Excel.
- **Plannen** vereisen het recht `plannen` (lijst, openen, opslaan,
  verwijderen, ter controle aanbieden, klantportaal).
- **Uitgeschakelde organisatie**: ook accounts in haar testomgevingen worden
  geweigerd, en de AI-route accepteert geen afgewezen sessie meer.
- **Inloggen**: een hoofdbeheerder telt mislukte pogingen in de hoofdtenant,
  welke organisatiecode er ook staat; de toegangscode heeft een totaalgrens
  (30 per kwartier); optioneel `TRUSTED_PROXIES` voor de doorgegeven IP-kop.
- **Sessieduur** (`sessionIdleDays`/`sessionMaxDays`) volgt de eigen
  organisatie van het account in plaats van de hoofdtenant.
- **Foto's**: een klant haalt een losse foto alleen op als de offerte niet
  verwijderd en geen concept is (zelfde regel als het dossier); miniaturen
  hoogstens 1024 px (werkorder en melding).
- **Mail**: zonder SSL/TLS is STARTTLS nu altijd verplicht (`requireTLS`).
- **Webshop**: verbinding naar precies het goedgekeurde IP-adres
  (`beveiliging/pinned-fetch.js`, hostnaam blijft voor certificaat en SNI);
  antwoorden worden met een grens na uitpakken gelezen.
- **Afspraak (.ics)**: tekst volgens RFC 5545 ontsnapt; werkordertitel op één regel.
- **PDF**: afbreken van lange woorden lineair in plaats van kwadratisch.
- **Back-up/overstap**: kopiëren in porties na de laatste sleutel (keyset)
  in plaats van OFFSET; een profiel opslaan zonder wijziging schrijft geen
  auditregel meer.

## 0.68.6

Opschoonronde frontend, deel 2 (geen functionele wijziging): duidelijke namen
en een commentaarblok bij elke functie in 11 bestanden (Meldingen,
Uitbesteden, Klantdossier, Plannen, Beheer > AI-kosten, foto's bij de
werkorder, en de kernbestanden `quote-core`, `quote-view`, `invoice-core`,
`workorder-core` en `shared/offline-core`).

- Interne afkortingen als `C`/`Hy`/`Q`/`W`/`M` heten nu `Catalog`,
  `Hydraulics`, `QuoteCore`, `WorkOrderCore` en `AiModels`; geëxporteerde
  namen en opgeslagen velden zijn ongewijzigd.

## 0.68.5

Opschoonronde frontend, deel 1 (geen functionele wijziging): duidelijke namen
en een commentaarblok bij elke functie in 23 bestanden (dashboard, profiel,
nieuws, openbare offerte- en afspraakpagina, Beheer > Rollen/Webshop/Sproeiers,
voorraadblok en urenkern van de werkorder, en in `shared/` common, env, roles,
theme, sidebar, offline en ai-models).

- `state.wo`/`state.opts`/`state.el`/`state.a` heten nu naar wat erin staat
  (`workOrder`, `options`, `box`/`container`, `appointment`).
- Lokale verwijzingen naar namespaces voluit (`QuoteView`, `WorkOrderCore`,
  `SprinklerLib`, `Catalog`).

## 0.68.4

Opschoonronde tests (geen functionele wijziging): duidelijke namen en een
commentaarblok bij elke functie in alle bestanden onder `backend/test/`.

- Gedeelde hulpcode in `test/helpers/`: `http-client.js` (`createClient`,
  `listen` voor een testserver, `createLogin` voor een ingelogde client per
  account) en `png.js`. De 31 losse kopieën van de testclient zijn weg.
- Offertetest gebruikt `signaturePng` uit `test-data.js` voor de handtekening.

## 0.68.3

Opschoonronde backend deel 3 (geen functionele wijziging): duidelijke namen
en een commentaarblok bij elke functie. Daarmee is alle code in
`backend/src/` opgeschoond.

- `uitvoering/` (photos, service-requests, worklog, workorders).
- `voorraad/stock.js` (`sumQty` voor reserveringstotalen).
- `platform/test-data.js` (PNG-opbouw gedeeld in `pngFile`).
- `server.js` (`allEnvironments`/`allEnvironmentIds` voor onderhoud en
  synchronisatie over alle omgevingen).

## 0.68.2

Opschoonronde backend deel 2 (geen functionele wijziging): duidelijke namen
en een commentaarblok bij elke functie.

- `beregening/` (plan-analyzer, recognitions, drawings, sprinklers).
- `verkoop/` (quotes, invoices, invoice-pdf, invoice-mail, pdf, visma).
- `webshop/` (woocommerce, shop, shop-sync, shop-orders).
- `uitvoering/portal.js` en `uitvoering/outsourcing.js` (`respondable` geeft
  nu `{ tenantId, offerRow }`).
- Codestijl-afbouwlijst van 118 naar 101 bestanden.

## 0.68.1

Opschoonronde backend deel 1 (geen functionele wijziging): duidelijke namen
en een commentaarblok (omschrijving, `@param`, `@returns`) bij elke functie.

- `beveiliging/` (auth, vault, netguard, rate-limit, idempotency,
  impersonation, session-secret), `database/` (db, pgdb, pgdb-worker,
  pgschema, db-copy), `backup.js`, `migrate-to-postgres.js`.
- `platform/` (store, settings, roles, mailer, wan-ip, news, ai-usage) en
  `verkoop/debtors.js`.
- Hernoemen alleen binnen de eigen scope, gecontroleerd op gelijke
  code-tokens; codestijl-afbouwlijst van 140 naar 118 bestanden.

## 0.68.0

Automatisch plaatsen stuurt op een groene neerslagkaart.

- **Kosten** (`WEIGHTS` in `planner.js`): elke cel buiten 85–130% van het gemiddelde
  telt mee (`off` 2 per % te weinig, `offHigh` 1,5 per % te veel), droge
  plekken 6 per %. Water op vlakken *Moet droog blijven* telt 6×, op *Mag nat
  worden* ¼× (`dry`/`wet` in `autoPlace`/`bestPlace`/`tune`, uit
  `App._surroundings`).
- **Zoeken**: koppen verschuiven bij het afstellen (binnenkop in 4
  richtingen, randkop langs de rand, `variantsOf(head, grid)`), sproeihoek opnieuw
  uit de echte rand, worp ook 1,2×. Nieuwe indeling vanaf de rand
  (`layoutPerimeter`: hoeken, gelijke afstanden langs de rand, raster
  binnenin). Per afstand zowel de grove als de gewone vorm. Beste zes
  indelingen ruw afgesteld, beste twee met verschuiven en aanvullen, winnaar
  6 rondes.
- Melding *Sproeiers plaatsen…* tijdens het rekenen.
- Groen deel van het gazon (gemiddeld over de testvormen, automatisch type):
  89% → 97%; terrastuin 80% → 94%, onregelmatig gazon 78% → 94%. Een gazon
  van 20 × 15 m krijgt 12 i.p.v. 9 rotators: met 9 spuiten de randkoppen ruim
  25 m² naast het gazon.
- `planner.js` volgt de codestijl (duidelijke namen, commentaarblok per
  functie) en staat niet meer in `tools/codestyle-baseline.json`; uitkomst
  van het plaatsen ongewijzigd.

## 0.67.2

Mappenstructuur van de backend per onderwerp (geen functionele wijziging).

- `backend/src/` ingedeeld in `database/`, `beveiliging/`, `platform/`,
  `beregening/`, `verkoop/`, `webshop/`, `uitvoering/`, `voorraad/` en
  `paginas/` (login/setup/wachtwoord). In de root alleen de opdrachten
  `server.js`, `backup.js` (blijft `node src/backup.js create` voor
  `update.sh`), `migrate-to-postgres.js` en het nieuwe `paths.js`
  (`FRONTEND_DIR`, `PAGES_DIR`).
- Bestandsnamen in kebab-case: `plan-analyzer.js`, `rate-limit.js`,
  `db-copy.js`, `session-secret.js` (was `options.js`), `wan-ip.js`,
  `test-data.js`, `ai-usage.js`, `invoice-pdf.js`, `invoice-mail.js`,
  `shop-sync.js`, `shop-orders.js`, `service-requests.js`.
- Verwijzingen in CLAUDE.md, README (nieuwe structuuroverzicht) en
  commentaar bijgewerkt; `queries.test.js` doorzoekt ook de submappen.
- Codestijlcontrole: een korte functie in een object op één regel telt als
  callback (geen commentaarblok nodig).

## 0.67.1

Codestijlregels vastgelegd en bewaakt (geen functionele wijziging).

- **Codestijl** (CLAUDE.md, *Codestijl*): duidelijke namen (geen namen van
  één letter, geen cryptische afkortingen) en een commentaarblok met
  omschrijving, `@param` en `@returns` bij elke functie.
- **Controle** `tools/codestyle.js` (acorn, devDependency) + `npm run
  codestyle` en `test/codestyle.test.js`. Bestanden die nog niet zijn
  opgeschoond staan in `tools/codestyle-baseline.json`; die lijst mag alleen
  korter worden.
- Losse screenshots en een export uit de root van de repo verwijderd.

## 0.67.0

Automatisch plaatsen: rustiger indeling en automatisch het beste sproeiertype.

- **Beste type per gazon** (`Planner.bestPlace`): plaatst elk bruikbaar type
  (assortiment, druk ≥ minimale kopdruk + 0,2 bar) en kiest per gazon de
  laagste kosten op één gezamenlijke beoordeling. Sproeiertype `auto` in de
  planner (stap 1 en 4, standaard voor nieuwe plannen), behuizing per type
  (`body-lawn-<type>`), melding met de keuze per gazon. `C.usableType` valt
  bij een onbekend type terug op het eerste bruikbare.
- **Geen kluitjes langs de rand**: per kopafstand een grovere vorm
  (`coarseShape`: randen korter dan 0,3 × afstand weg, naar buiten), daarna
  `prune` (overbodige koppen weg) en `fill` (kop bij de droogste plek, alleen
  als het beter wordt). Afstanden tot 1,2 × de maximale worp dwars op het
  gazon (twee rijen randkoppen), de beste zes indelingen worden afgesteld.
- **Kosten** (`W`): water buiten het gazon over de volle worp (was tot 3 m)
  en zwaarder (80), gele plekken < 70% van het gemiddelde (2,5 per %),
  droge plekken 3 per %. Meetraster iets verschoven (geen punten precies op
  een rechte rand).
- **Sneller** (ca. 5×): bijdrage per kop onthouden (`headCells`), sector
  zonder hoekfuncties, laagste kwart via quickselect, natte cellen buiten
  het gazon bijgehouden.
- **Neerslagkaart** (`simulation.js`): kleur en DU/droog per gazon t.o.v. het
  eigen gemiddelde (`areaMean`), zodat rotators naast turbines niet geel
  lijken.
- Voorbeeld terrastuin (getrapte rand): rotators 20 → 12 koppen (kleinste
  afstand 1,0 → 4,0 m, DU 71 → 81%), turbines 18 → 9 (DU 62 → 85%).

## 0.66.0

Sproeierbibliotheek (behuizing + nozzle) en grotere worp bij automatisch
plaatsen.

- **Automatisch plaatsen** (`js/planner.js`): kostenweging `W` (kop 2,5,
  gelijkmatigheid pas onder DU 0,85), rechthoekig verband (afstand langs en
  dwars apart, `spacingsAlong`, verhouding max. 2), worp tot de volle worp van
  de grootste kop die past (gat tussen twee koppen: de grootste eronder),
  binnenkoppen langs de rand korter (tot 0,55 × afstand), de beste drie
  indelingen eerst afstellen (2 rondes, ook 0,6 × worp) en dan kiezen.
  Voorbeelden: 30 × 12 m van 18 naar 12 koppen, 20 × 15 m van 12 naar 9,
  onregelmatig gazon van 22 naar 14.
- **Sproeierbibliotheek** (`js/sprinklerlib.js`, UMD): behuizingen (`mount`,
  pop-up, drukregeling) en nozzles (groep spray/rotator/rotor, sectoren,
  min. worp/inkorten, werkdruk, `matched`, prestatiepunten druk/worp/debiet)
  met `perfAt`, `radiusRange`, `flowLph`, `sanitize`, `merge`,
  `toSheets`/`fromSheets`. Standaard: Rain Bird 1804/1806/1812 PRS en SAM-P45,
  Hunter Pro-Spray PRS40 (10/15/30 cm), Rain Bird 5004 PC/PRS en 5012 PC,
  Hunter MP1000/2000/3000/3500/Corner (sleutels als voorheen), Rain Bird
  HE-VAN-08/10/12/15 en Rain Curtain 1,5–8,0 (afgerond uit de
  fabrikanttabellen).
- **Catalogus** (`js/catalog.js`): `setLibrary`, `bodies`, `nozzles`,
  `nozzlesFor`, `bodiesFor`, `bodyOf`, `nozzleOf`, `autoNozzle` (rotornozzle op
  neerslag), `headRange`, `fitHead` (= `fitRotator`), `headSetting`,
  `headPr`, `headMinBar`, `libraryArticles`; `rotatorModels` en het bereik per
  sproeiertype volgen uit de bibliotheek. Sproeier: `body` (behuizing) en
  `model` (nozzle, voor elk type). Met eigen assortiment alleen behuizingen
  en nozzles waarvan de code erin staat.
- **Simulatie/hydraulica/stuklijst**: neerslag per kop uit de nozzle
  (`headPr`), min. druk uit drukregeling van het huis, stuklijst met
  huis- en nozzlecode (anders generiek), Excel-kolom *Sproeikop / instelling*
  met behuizing. Werkorder: kolom *Behuizing* (`heads[].body`).
- **Planner** (`js/app.js`): behuizing gazon/beplanting voor automatisch
  plaatsen (`settings.bodies`), blok *Zelf een kop plaatsen* (behuizing +
  nozzle → volle worp), eigenschappenpaneel met behuizing, nozzle en bereik
  voor alle typen.
- **Per omgeving** (`backend/src/sprinklers.js`, tabel `sprinkler_library`,
  migratie 29): `GET /api/sprinkler-library` (ingelogd), `PUT` (Excel als
  JSON, recht `beheer`, server controleert opnieuw, alleen afwijkingen van de
  standaard), `DELETE` (terug naar standaard); audit
  `sproeierbibliotheek_ingelezen|_standaard`. `shopcatalog.js` laadt hem samen
  met `api/catalog`; eigen codes tellen mee in het assortiment
  (`libraryCodes` in shop.js). **Beheer → Sproeiers**: overzicht, Excel
  downloaden (sjabloon met uitleg) en inlezen.
- Testdata: eigen behuizing (pop-up 20 cm) en eigen MP3000-prijs; tuinen met
  Hunter Pro-Spray PRS40 en Rain Bird 5004.

## 0.65.0

Brincr vervangen (deel 3): koppeling met Visma eAccounting.

- **Visma** (`backend/src/visma.js`): OAuth2 (authorization code, scopes
  `ea:api offline_access ea:sales`) per omgeving. De app-registratie
  (instelling `vismaApp` + geheim `vismaClientSecret`, `platform: true`) staat
  in de hoofdtenant en vul je in via **Hoofdbeheer → Visma**
  (`GET|PUT /api/platform/visma`). Per omgeving: refresh token als geheim
  `vismaRefreshToken` (versleuteld), keuzes in instelling `visma`
  (`internal`: niet via Beheer > Instellingen); access token alleen in het
  geheugen, bij 401 vernieuwd. Vaste hosts (sandbox/productie), geen SSRF.
- **Doorsturen**: definitieve factuur → verkoopfactuur (`POST
  /customerinvoices`), debiteur → klant met het debiteurnummer (`POST
  /customers`; bestaat het nummer al voor een andere naam: 409
  `number_taken`). Elke regel op het Visma-artikel van zijn omzetcategorie
  (`visma.articles`); ontbreekt er een, dan `visma_error` op de factuur.
  Creditfactuur met `IsCreditInvoice` en `CreditedInvoiceId`.
- **Wanneer**: knop op de factuur (`POST /api/visma/invoices/:id`), *Nu
  doorsturen* (`POST /api/visma/sync`, max. 50 per keer, oudste eerst) of
  automatisch (`visma.autoSync`, standaard uit): 5 s na definitief
  (`invoices.onFinalized`) en elke 10 minuten (`app.locals.vismaAll`). Alleen
  facturen vanaf `visma.since` (automatisch aan zonder datum = vandaag).
- Migratie 28: `debtors.visma_customer_id`, `invoices.visma_invoice_id|
  visma_number|visma_synced_at|visma_error` + index `invoices_visma`.
- **Facturen**: tabblad *Visma* (verbinden/verbreken, status, artikel per
  omzetcategorie, betalingstermijn, automatisch + datum), knop *Naar Visma* en
  status/fout op de factuur, kolom *Boekhouding* in de lijst.
- Settings: `max` per geheim (refresh token tot 4000 tekens).

## 0.64.2

Planner: ingezoomd blijven tekening en vlakken scherp en op hun plek.

- `Concept.straighten` trok lokaal herkende vlakken zo hard recht dat bochten
  verdwenen en randen tot ca. 0,5 m naast de tekening kwamen (zichtbaar bij
  inzoomen). Nu: vereenvoudigen met hooguit 0,15 m tolerantie en
  `G.regularize(..., { maxShift })`: een schuine rand wordt alleen recht gezet
  als de uiteinden hooguit 0,15 m opschuiven, en de uitkomst mag nergens verder
  dan dat van de invoer liggen (`G.deviation`), anders blijft de invoer.
  De sproeierplaatsing (planner.js) gebruikt regularize ongewijzigd.
- Ondergrond: `Editor._bgSource` tekent alleen het zichtbare deel van het
  beeld (bronrechthoek, `imageSmoothingQuality: 'high'`) in plaats van het
  hele beeld vele malen groter dan het canvas. Safari op iOS verloor
  ingezoomd fijne lijnen en zette de tekening soms verschoven neer.
- Randen van vlakken 2 px in plaats van 1,25 px (geselecteerd 3 px), zodat ze
  op een drukke tekening zichtbaar blijven.

## 0.64.1

Kopbalk op de telefoon past weer op elke pagina.

- **Kopbalk smal scherm** (`dashboard/dashboard.css`, ≤ 600px): op een
  modulepagina met paginatitel (`.brand-name`) vallen het logo en de
  scheidingslijn weg (logo staat in de zijbalk en op het overzicht); de titel
  staat links en kort zo nodig in met een beletselteken. Organisatiekiezer en
  gebruikersmenu krimpen niet meer, zodat de avatar altijd zichtbaar is. Onder
  360px wordt het logo op het overzicht iets kleiner. Getest op 320, 375, 390
  en 430px voor alle modulepagina's, met organisatiekiezer.

## 0.64.0

Planner gebruikt alleen artikelen uit het eigen assortiment.

- **Eigen assortiment** (`backend/src/shop.js`): `GET /api/catalog` geeft
  `assortment` (plannercodes die de organisatie als voorraadartikel of
  gekoppeld webshopproduct heeft, niet-gearchiveerd) en `unknownCodes`
  (voorraadartikelen met een code die de planner niet kent). Leeg = de
  standaardcatalogus blijft de terugval.
- **Catalogus** (`js/catalog.js`): `setAssortment`, `available`, `pick`,
  `typeAvailable`, `usableType`, `rotatorModelsAvailable`. Buisdiameters
  zonder artikel vallen af (`C.pipes`), `autoRotatorModel`/`rotatorModelOf`
  kiezen een beschikbare kop (dichtstbijzijnde worp), `planner.js` plaatst
  rotators alleen op afstanden die een beschikbare kop haalt.
- **Stuklijst** (`js/bom.js`): alternatieven waar dat technisch kan
  (bijv. CON-FLEX ↔ CON-ECO, VAL-24V-FC ↔ VAL-24V, BOX-JUMBO ↔ BOX-STD,
  CTRL-WIFI ↔ CTRL-ECO, CAB-7 → CAB-13); wat dan nog ontbreekt staat in
  `rows.missing` en niet in de stuklijst, offerte (`fromPlan` geeft een
  waarschuwing) of totalen. Planner toont een blok *Niet in je assortiment*,
  Excel een aparte lijst.
- **Planner** (`js/app.js`): sproeiertypes zonder artikel zijn uitgeschakeld
  (stap 1, stap 4, eigenschappen), MP-koppen alleen uit het assortiment.
- `shopcatalog.js`: verkoopprijzen uit Voorraadbeheer werden zonder
  webshopkoppeling niet toegepast (alleen met `syncedAt`); nu wel.

## 0.63.0

Brincr vervangen (deel 2): webshopbestellingen als factuur, debiteuren en
facturen per e-mail met PDF.

- **Debiteuren** (`backend/src/debtors.js`, tabel `debtors`, migratie 27):
  nummer per omgeving vanaf `invoicing.debtorStart` (standaard 1000),
  herkend aan klantaccount, webshopklant, e-mailadres of naam
  (`match_key`). Definitief maken koppelt de factuur (`invoices.debtor_id`)
  en werkt de debiteur bij. API `GET /api/debtors`, `GET|PUT /api/debtors/:id`
  (recht `facturen`); tabblad Debiteuren in Facturen; debiteurnummer in de
  Visma-export.
- **Webshopbestellingen** (`backend/src/shoporders.js`, `fetchOrders` in
  woocommerce.js): bestellingen met de ingestelde status (standaard
  `completed` = Afgerond) sinds `invoicing.shopOrders.since` worden een
  factuur (`invoices.shop_order_id`, unieke index: nooit dubbel), met
  debiteur, btw-tarief per regel uit de belastingregels, verzendkosten en
  toeslagen (groep overig); optioneel meteen definitief, betaald als de
  webshop `date_paid` heeft, en verstuurd. Elke 10 minuten (na de
  prijs/voorraadsynchronisatie) en via `POST /api/invoices/shop-orders/sync`.
  Voorraad: met `pushStock` al afgeboekt door shopsync.js (`skipStock`),
  anders boekt de factuur af. Stand in `shop_sync.orders_*`.
- **PDF** (`backend/src/pdf.js`, `backend/src/invoicepdf.js`): eigen kleine
  PDF-schrijver (Helvetica/WinAnsi, PNG-logo met alfakanaal, meerdere
  pagina's), kleuren uit het thema. `GET /api/invoices/:id/pdf`; de knop PDF
  in Facturen gebruikt die (de afdrukversie in de browser is weg).
- **Versturen** (`backend/src/invoicemail.js`): `POST /api/invoices/:id/send`
  met PDF-bijlage (`mailer.send` kent nu `attachments`), voorstel via
  `GET /api/invoices/:id/mail`; `invoicing.autoSend` verstuurt bij
  definitief (ook uit de webshop). `sent_at`/`sent_to`/`send_error` op de
  factuur; een mislukte verzending laat de factuur definitief.
- Testomgeving leegmaken wist nu ook facturen en debiteuren; testdata met een
  webshopfactuur, debiteuren en een verstuurde factuur.

## 0.62.0

Planner: vlakken achteraf corrigeren en verschuiven tijdens het tekenen.

- **Vorm corrigeren** (`js/editor.js`, `js/app.js`): hoekpunten en middens
  van het geselecteerde vlak gaan in `hitTest` vóór sproeiers en elementen
  (sproeiers op de rand blokkeerden het slepen). Aangetikt hoekpunt
  (`activeVertex`) is oranje; verwijderen met Delete/Backspace, dubbelklik
  of de knop *Punt N verwijderen* in het paneel (minimaal 3 punten).
  *Opnieuw tekenen* (`redrawArea`, `toolOpts.redrawId`) vervangt de vorm
  van hetzelfde vlak (naam, type, zone en methode blijven,
  `replaceAreaPoints`); annuleren laat het vlak staan. Na een vormwijziging
  `areaShapeChanged` (sproeiers in beplanting opnieuw via `_applyMethods`).
- **Verschuiven tijdens tekenen**: het handje (werkbalk en nieuwe knop
  *✋ Schuiven* in de tekenbalk) schakelt tijdens het tekenen `panHold` in
  zonder het gereedschap of de lopende vorm te wissen (voorheen brak het
  handje de vorm af). Scrollwiel/touchpad verschuift nu (Shift = opzij),
  Ctrl/Cmd + scrollen of knijpen op het touchpad zoomt; pijltjestoetsen
  verschuiven. Spatie loslaten zet het gereedschap niet meer opnieuw (de
  vorm bleef toen ook niet bewaard). Touch: slepen en knijpen werkten al.
- **Leidingkleuren** (`js/hydraulics.js`): zonepalet zonder groen- en
  bruintinten (`ZONE_COLORS`); bewaarde plannen worden omgezet
  (`refreshZoneColors` in `calculate`). Leidingen en zonerand van
  druppelvlakken krijgen een witte rand eronder.

## 0.61.0

Brincr vervangen (deel 1): verkoopprijzen in Aquatech als bron voor de
webshop, facturen en de export naar de boekhouding.

- **Artikelen** (`backend/src/stock.js`, migratie 26): `stock_items` krijgt
  `sale_price` (excl. btw), `vat_rate`, `revenue_group` (producten, arbeid,
  overig), `shop_sync` en de webshopstand (`shop_product_id`, `shop_dirty`,
  `shop_price_seen`, `shop_stock_seen`, `shop_synced_at`, `shop_error`).
  Elke wijziging van prijs of stand zet `shop_dirty`. `saleInfo()` geeft de
  verkoopgegevens per code; `GET /api/catalog` gebruikt de verkoopprijs vóór
  de webshopprijs. Producten uit de webshop overnemen:
  `GET /api/stock/shop-products`, `POST /api/stock/import-shop`.
- **Webshop in twee richtingen** (`backend/src/shopsync.js`, WooCommerce REST
  v3): `shopSource.push` (+ `pushStock`) schrijft prijs (incl. btw als de
  webshop zo rekent, met het tarief van het artikel) en beschikbare voorraad
  (stand − gereserveerd) terug via `/products/batch`. Een daling van de
  webshopvoorraad sinds de vorige ronde wordt eerst afgeboekt (bron
  `webshop`); een prijs die alleen in de webshop wijzigde wordt overgenomen.
  Na een wijziging na 3 s (alleen de gewijzigde artikelen, met hun actuele
  stand via `include=`), elke 10 minuten alles, en met de knop in Beheer →
  Webshop. Zonder push blijft de webshop leidend voor de prijs.
- **Facturen** (`backend/src/invoices.js`, kern `frontend/facturen/invoice-core.js`,
  tabel `invoices`, migratie 26): concept → definitief (nummer
  `<voorvoegsel><jaar>-0001` per omgeving, vergrendeld) → betaald;
  creditfactuur als nieuw concept met negatieve regels. Uit een werkorder:
  de gekozen offerteregels plus geboekt materiaal dat niet in de offerte
  staat (meerwerk), of zonder offerte het geboekte materiaal en de uren
  × uurtarief. Een losse verkoop boekt bij definitief de voorraad af (bron
  `factuur:<id>`), de credit ervan boekt terug. Instelling `invoicing`
  (voorvoegsel, betaaltermijn, betaaltekst, voettekst, omzetcategorieën per
  groep × btw-tarief met grootboekrekening). Recht `facturen` (beheerder).
  API `/api/invoices[/:id]`, `.../finalize|paid|credit`, `/api/invoices/settings`,
  `/api/invoices/articles`, `/api/invoices/export[/mark]`.
- **Module Facturen** (`frontend/facturen/`): overzicht met filters,
  factuur bewerken (`?id=`), afdrukversie/PDF, export voor Visma eAccounting
  als Excel (omzetregels per categorie, facturen, totalen, debiteuren) en de
  instellingen. Knop *Factuur maken* in het menu van de werkorder.
- Testdata: verkoopprijzen en facturen (betaald, openstaand over de
  vervaldatum, concept, credit, losse verkoop).

## 0.60.0

Klantportaal: storing of onderhoud melden, met foto's; medewerkers maken er
een werkorder van.

- **Melden** (`frontend/portaal/`): blok *Storingen en onderhoud* met een
  formulier (soort storing/onderhoud/vraag, spoed, installatie uit de eigen
  werkorders, onderwerp, omschrijving, adres, telefoon, voorkeursmoment) en
  tot 6 foto's (verkleind in de browser via `WorkOrderPhotos.prepare`).
  Overzicht van de eigen meldingen met status, reactie en de werkorder; de
  klant kan foto's toevoegen/verwijderen of de melding intrekken zolang hij
  loopt. `portaal/#melden` opent het formulier, `#melding=<id>` een melding.
- **Opslag** (`backend/src/servicerequests.js`): tabellen `service_requests`
  en `service_request_photos` (migratie 25, SQLite en PostgreSQL), nummer
  `M-<jaar>-0001` per omgeving. Foto's op inhoud gecontroleerd en zonder
  EXIF (`photos.inspectImage`), versleuteld met `vault.sealBytes` (AAD
  `<tenant>:melding-foto:<id>:beeld|mini`). `customer_id`, `handled_by`,
  `work_order_id` zonder foreign key; bij het verwijderen van een account
  worden ze leeg.
- **API klant** (recht `portaal`): `GET|POST /api/portal/requests`,
  `GET /api/portal/requests/:id`, `POST|DELETE .../photos[/:pid]`,
  `GET .../photos/:pid`, `POST .../withdraw`. `/api/portal` geeft
  `requests` mee (zonder interne notitie). Limiet 10 meldingen en 60 foto's
  per uur per klant.
- **Module Meldingen** (`frontend/meldingen/`, recht `werkorders`): overzicht
  (lopend of alles), detail via `?id=`, reactie aan de klant (ook per mail),
  interne notitie, status. API `GET /api/service-requests[/:id]`,
  `PUT /api/service-requests/:id`, `GET .../photos/:pid`.
- **Werkorder maken**: `POST /api/service-requests/:id/workorder`
  (`workorders.createReceived`, nu met `assigneeId`): klantgegevens,
  omschrijving als instructie, ontwerp/zones/koppen van de gekozen
  installatie en de foto's van de klant (als foto's *voor*) gaan mee. De
  klant ziet die werkorder in zijn portaal (afspraak bevestigen, voortgang,
  foto's): werkorder-, portaal- en fotoquery's tellen naast
  `quotes.customer_id` ook `service_requests.customer_id` mee.
- **E-mail** (als er een mailserver is): nieuwe melding naar het e-mailadres
  van het bedrijfsprofiel, een nieuwe reactie naar de klant.
- **Testdata**: vier meldingen (nieuw met foto's, in behandeling, afgehandeld
  en één omgezet in een ingeplande werkorder).

## 0.59.0

Voorraadbeheer: nieuwe module `frontend/voorraad/`, gekoppeld aan de
stuklijst en werkorders via de artikelcode.

- **Opslag** (`backend/src/stock.js`, migratie 24 in SQLite en PostgreSQL):
  `stock_items` (per omgeving, code uniek per tenant, stand `on_hand`,
  locatie, minimum, inkoopprijs, archief), `stock_movements` (logboek:
  ontvangst, afboeking, retour, correctie, telling; wijziging + stand erna,
  werkorder, bron, gebruiker) en `stock_reservations` (per werkorder en
  artikel). Indexen met `tenant_id` vooraan.
- **Reserveren**: `onWorkOrderChange` na aanmaken, opslaan en verwijderen van
  een werkorder (`ctx.onChange` in workorders.js): open werkorders (Nieuw,
  Gepland, In uitvoering) reserveren benodigd − afgeboekt per voorraadcode;
  gereed/geannuleerd/verwijderd geeft vrij. Nieuwe voorraadartikelen
  reserveren meteen op open werkorders (`resyncOpen`).
- **Afboeken**: bij Gereed wordt de reservering afgeboekt (bron `gereed`),
  tenzij er materiaalverbruik is geboekt. `syncUsage` boekt verbruik
  idempotent per verbruiksregel (bron `verbruik:<id>`, alleen het verschil,
  0 = terugboeken) voor de koppeling met de materiaalregistratie op de
  werkorder. Handmatig per regel of alles via `POST
  /api/stock/workorders/:id/issue`.
- **API**: `/api/stock` (overzicht in één query), `/api/stock/items[/:id]`,
  `/api/stock/items/:id/movements`, `/api/stock/import` (uit de catalogus),
  `/api/stock/movements` (periode, voor de export), `/api/stock/reservations`,
  `/api/stock/resync` (recht `voorraad`) en `/api/stock/workorders/:id`
  (recht `werkorders`). Eigen `express.json({ limit: '256kb' })`.
- **Rechten**: nieuw recht `voorraad` (beheerder en installateur).
- **Frontend**: module Voorraadbeheer (overzicht, gereserveerd, mutaties,
  artikel via `?id=`, Excel-export van voorraad en mutaties) en blok
  Voorraad op de werkorder (`werkorders/stock-panel.js`).
- **Testdata**: voorraadartikelen, mutaties en reserveringen bij de
  testwerkorders. Tests in `test/stock.test.js` (flow, verbruik, rechten,
  andere tenant → 404) en `test/queries.test.js`.

## 0.58.0

Installeerbare app (PWA) die op locatie ook zonder verbinding werkt, voor
installateurs: startscherm, werkorders en foto's.

- **App**: `frontend/manifest.json` (relatief, standalone, iconen in
  `shared/icons/`), ingevoegd door `shared/common.js` op elke pagina, die ook
  de service worker `sw.js?v=<versie>` registreert. Manifest, `sw.js`,
  `shared/offline-core.js` en iconen staan in `PUBLIC_FILES` (geen gegevens).
- **Service worker** (`frontend/sw.js`): pagina's eerst van de server, bij geen
  verbinding uit `aquatech-shell-<versie>` (vooraf: dashboard en werkorders met
  scripts/CSS); onveranderlijke bestanden (`?v=`, immutable) eerst uit de
  cache. Gegevens alleen voor de lijst in `offline-core.js` (api/me, my-day,
  werkorders, foto-lijsten en miniaturen, medewerkers, bedrijfsprofiel) en
  alleen voor een eigen account met recht `werkorders`, niet tijdens
  impersonatie. Cache `aquatech-data` wordt gewist bij uitloggen, een andere
  gebruiker/omgeving, een 401 en na 14 dagen per item.
- **Generieke wachtrij** (IndexedDB): een verzoek met `X-Aquatech-Offline: 1`
  gaat bij geen verbinding of een onbereikbare server (502/503/504/52x) in de
  wachtrij en geeft 202 `{ queued: true }`. Optioneel `-Key` (samenvoegen),
  `-Label`, `-Patch: merge` (bewaarde GET bijwerken, zodat de pagina offline de
  eigen wijziging terugziet) en `X-Aquatech-Base`. Versturen bij openen van een
  pagina, `online`, Background Sync en elke 30 s; per item een
  `Idempotency-Key`. Bruikbaar voor elke module (uren, materiaal).
- **Conflicten**: `X-Aquatech-If-Base` op `PUT /api/workorders/:id` geeft 409
  `conflict` als de werkorder intussen is gewijzigd. De service worker voegt
  dan per veld en per werkstap/materiaalregel samen (`merge3`); alleen als
  beide kanten hetzelfde veld wijzigden kiest de gebruiker (toch opslaan of
  weggooien) in het offline-paneel (`shared/offline.js|.css`).
- **Server**: `backend/src/idempotency.js` (Idempotency-Key per gebruiker +
  omgeving + methode + pad, 24 u in het geheugen, begrensd; 409 `in_progress`).
- **Werkorders/foto's/startscherm**: autosave en foto-upload/-wijziging via de
  wachtrij; foto's die nog wachten staan in de galerij; het startscherm zet de
  klussen van vandaag en de volgende alvast op het toestel. Uitloggen
  waarschuwt bij niet-verstuurde wijzigingen en wist alles.
- **Urenregistratie** (0.57.0) gebruikt nu dezelfde wachtrij: nieuwe uren- en
  materiaalregels gaan offline via de service worker (`api/workorders/:id/worklog`
  ook in de offline cache en vooraf geladen); de localStorage-wachtrij blijft
  de terugval zonder service worker en wordt bij uitloggen gewist.
- Tests: `test/offline.test.js`.

## 0.57.0

Urenregistratie en materiaalverbruik op de werkorder.

- **Opslag** (`backend/src/worklog.js`, migratie 23 in `MIGRATIONS` én
  `PG_MIGRATIONS`): tabellen `work_order_hours` (datum, begin/eind/pauze of
  direct minuten, soort werk|reistijd|meerwerk, werkstap, opmerking) en
  `work_order_materials` (datum, code, omschrijving, eenheid, aantal;
  negatief = retour; `material_id` = geplande regel, leeg = extra;
  `stock_movement_id` voor voorraadbeheer). `user_id` zonder FK, naam in
  `user_name`; `client_id` (UUID uit de browser, uniek per tenant) maakt
  boeken idempotent voor offline synchroniseren. Indexen met `tenant_id`
  vooraan.
- **Rekenkern** `frontend/werkorders/worklog-core.js` (UMD, ook op de
  server): `cleanHours`, `cleanMaterial`, `minutesBetween`, `totals`
  (geboekt tegenover gepland, per soort/medewerker/artikel).
- **API**: `GET /api/workorders/:id/worklog`, `POST|PUT|DELETE
  /api/workorders/:id/hours[/:eid]` en `.../materials[/:eid]` (recht
  `werkorders`; eigen regels, met recht `planning` ook voor collega's en na
  status Gereed/Geannuleerd, anders 409 `locked`), `GET /api/worklog?from&to[&user]`
  (urenstaat, zonder `planning` alleen eigen uren, max. 400 dagen). Body-limiet
  32 kB. Werkorderoverzicht geeft `logged` (één UNION-query).
- **Voorraad**: `workLogStore.hook(fn)`; `fn(tenantId, { id, work_order_id,
  code, qty, deleted }, user)` wordt in dezelfde transactie aangeroepen na
  boeken/wijzigen/verwijderen; de teruggegeven id komt in `stock_movement_id`.
  `usedByCode(tenantId, woId)`.
- **Frontend**: kaart *Uren en materiaalverbruik* in de werkorder
  (`worklog.js|.css`, tabbladen, mobiel als kaartjes), wachtrij in
  localStorage bij geen netwerk (verstuurt bij `online`/openen), Excel:
  bladen Uren, Materiaalverbruik en Gepland vs verbruikt bij de werkorder,
  knop **Urenstaat** in het overzicht (per regel, per medewerker en dag,
  materiaal).
- Testdata: uren en verbruik bij de werkorders in uitvoering en gereed.
  Gebruiker verwijderen zet `user_id`/`created_by` op NULL; leegmaken en
  definitief wissen nemen de regels mee.

## 0.56.0

Plan herkennen: vaste AI-uitkomst per tekening, betere herkenning zonder AI
en een lokale herkenning die leert van AI-herkenningen en goedgekeurde plannen.

- **Zonder AI** (`localrecog.js`): textuur per pixel (`normalizedColors`
  geeft `tex`, gemiddelde helderheidsafwijking zonder inkt). Gevlekt
  lichtgroen (getekende planten, boomkroon) telt als beplanting
  (`TEX_PLANTS`). Gazon: losse snippers (< 10% van het grootste stuk) weg,
  daarna sluiten met straal 2,5% van het beeld over beplanting/papier
  (watermerk, tekst), en alleen gaten die droog moeten blijven (bestrating,
  water) worden een sleutelgat; een border of boom in het gras hoort bij het
  gazon. `dropIslands`: groepjes vlakken ver van de tuin met < 10% van de
  oppervlakte (logo, legenda) vallen weg. Op het voorbeeldplan van
  Daniël: 1 gazon i.p.v. 5, 9–12 koppen i.p.v. 55, DU 43% → 71–74%
  (vaste test met `test/fixtures/tuinontwerp-voorbeeld.png`, kleine
  PNG-lezer `test/png.js`).
- **Plaatsen** (`planner.js`): randjes korter dan 0,6 m in de
  plaatsingsvorm worden weggewerkt (`collapseShortEdges`), zodat een trapje
  geen drie hoekkoppen krijgt.
- **Vaste AI-uitkomst**: tabel `plan_recognitions` (migratie 22, SQLite en
  PostgreSQL, `recognitions.js`). `/api/plan/analyze` bewaart elke
  herkenning onder SHA-256 van de afbeelding + model + versie van de
  opdracht (`PROMPT_VERSION` in planAnalyzer.js) per omgeving en geeft
  dezelfde tekening daarna uit de opslag (`recognition.cached`, geen
  kosten, telt niet voor de daglimiet). `fresh: true` herkent opnieuw;
  knop **Opnieuw herkennen met AI** in stap 1.
- **Leren**: na een AI-herkenning of het goedkeuren van een plan telt de
  planner per kleur/textuur-vakje (8×8×8 kleuren × 3 texturen) welk type
  vlak er lag (`LocalRecognizer.learn`/`samplesFromPixels`) en stuurt alleen
  die tellingen naar `POST /api/plan/learn` (bij de herkenning, één keer;
  of bij een goedgekeurd plan met recht `plannen.goedkeuren`). `GET
  /api/plan/learned` telt de laatste 300 voorbeelden van de omgeving op
  (goedgekeurd plan telt dubbel, cache 60 s); de lokale herkenning
  gebruikt een vakje vóór de vaste regels als het minstens 40 gewicht en
  60% eenduidigheid heeft. Geen afbeelding in de database; plan wissen
  (AVG) wist ook de tellingen van dat plan; omgeving leegmaken wist alles.
- Testdata: drie herkende plannen met kleurtellingen.

## 0.55.0

Legenda in de tekening van de beregeningsplanner.

- **Legenda over het canvas** (rechtsboven, in elke stap): vlaktypes met
  totaal oppervlak, beregeningswijze in beplanting (druppelslang,
  druppelaars), sproeiers, zones met hun type en de systeemelementen. Alleen
  wat in het plan staat; zonder vlakken alle vlaktypes als sleutel.
  Inklapbaar, stand per browser onthouden (`localStorage`
  `aquatech-legenda-open`, op een smal scherm standaard dicht). Schuift
  onder de tekenbalk als die zichtbaar is.
- Symbolen getekend met dezelfde canvascode als de tekening
  (`Editor.legend()` + `_legendSwatch`), dus altijd gelijk aan het plan.
- **Export**: *Plan als PNG* en de afbeelding in de Excel-export hebben de
  legenda als vak rechts naast de tekening; *Afdrukken* neemt de legenda mee
  als die open staat.

## 0.54.0

Inzicht in de kosten van AI, modelkeuze en een eigen sleutel per organisatie.

- **Beheer → AI-kosten**: elk AI-verzoek (nu: plan herkennen) staat in de
  nieuwe tabel `ai_usage` met gebruiker, omgeving, functie, model,
  resultaat, tokens in/uit/cache, duur en kosten in dollar en euro
  (migratie 21, SQLite en PostgreSQL). Totalen per dag of maand, per
  gebruiker, functie en model, losse verzoeken met details en een
  Excel-export (`aiusage.js`, API `/api/admin/ai-usage[/requests]`).
  Ook mislukte verzoeken die tokens kostten (weigering, te lang,
  onleesbaar) tellen mee. Geen afbeelding of antwoord in het logboek;
  bewaartermijn = die van het auditlog.
- Een hoofdbeheerder ziet ook **alle organisaties** samen
  (`?scope=all`, uitsplitsing per organisatie) of één andere omgeving
  (`?tenant=`); een gewone beheerder krijgt daarop 403.
- **Modelkeuze** per organisatie in Beheer → Instellingen (instelling
  `aiModel`: Opus 5.5, Sonnet 5.5, Haiku 5.5 of Fable 5.1, met prijs en
  uitleg); prijzen gedeeld in `frontend/shared/ai-models.js`. Server-side
  fallback alleen bij modellen die het ondersteunen. **Sleutel testen**
  controleert het gekozen model.
- **Eigen API-sleutel per organisatie**: de sleutel uit de Docker-omgeving
  geldt alleen voor de hoofdorganisatie (en diens testomgevingen), nooit
  voor een andere organisatie; die moet een eigen sleutel invullen. Een
  testomgeving zonder eigen sleutel gebruikt sleutel en model van haar
  live-omgeving.
- Instelling `aiEurCentsPerUsd` (koers, standaard 86) en nieuw instellings-
  type `enum`.
- Testdata: AI-verzoeken van de testgebruikers (ook een weigering, een
  ander model en een klant).

## 0.53.0

Betere automatische sproeierplaatsing en instelbare meerstraalsrotators.

- **Automatisch plaatsen** opnieuw opgezet (`planner.js`): de vorm wordt eerst
  vereenvoudigd (Douglas-Peucker) en rechtgetrokken op de hoofdrichting
  (`Geo.simplifyClosed`, `Geo.dominantAngle`, `Geo.regularize`). Daarna
  worden varianten doorgerekend (vierkant/driehoek, twee richtingen,
  afstanden die het vlak in gelijke stukken delen) met koppen op hoeken,
  randen (zonder gaten) en binnenin, kop-tot-kop. Een snelle eigen beoordeling
  (vaste meetpunten per vlak) kiest de beste; daarna kort een greedy stap per
  kop de worp in als dat minder overspray geeft. Op gekartelde vlakken uit de
  lokale herkenning: 4–8 koppen in plaats van 27–39, DU van 65–77% naar
  86–93%, veel minder water buiten het gazon.
- **Lokaal herkende vlakken worden rechtgetrokken** (`Concept.straighten`),
  zodat ze niet meer uit tientallen kleine knikken bestaan.
- **Meerstraalsrotator per kop instelbaar**: `Catalog.rotatorModels` (MP1000,
  MP2000, MP3000, MP3500, MP Corner met worp- en sectorbereik),
  `fitRotator`, `rotatorModelOf`, `rotatorSetting`. Sproeier krijgt optioneel
  `model`; zonder model kiest de planner de kop bij worp en sproeihoek.
  Eigenschappenpaneel: kop kiezen, worp en sproeihoek binnen het bereik.
- **Grepen in de tekening** voor worp en begin/einde van de sproeihoek van
  de geselecteerde sproeier (alle cirkelsproeiers; rotators binnen het
  bereik van hun kop).
- Stuklijst: sproeikop volgt de gekozen kop (nieuw artikel `ROT-MPCORNER`);
  Excel-blad *Sproeiers* toont de instelling per kop.
- **Koppen automatisch optimaal afstellen** (`Planner.tune`): per kop worp,
  sproeihoek, richting en daarmee de MP-kop kiezen op de neerslagsimulatie
  (incrementeel, snel). Gebeurt altijd: bij automatisch plaatsen, handmatig
  plaatsen en na verslepen (sproeihoek volgt de nieuwe plek); knop *Alle
  koppen opnieuw afstellen*. Met de grepen of het paneel ingestelde waarden
  blijven staan tot je opnieuw afstelt.
- **Werkorder: afstelling per kop** (`heads` in de werkorder, `zonesFromPlan`):
  nr, zone, kop, sector, sproeihoek, worp, linkerrand en plek. Op het scherm,
  op de werkbon (afdrukken) en als Excel-blad *Afstelling koppen*. *Zones en
  afstelling opnieuw uit het plan* ververst ze.
- Testdata: rotators met vaste MP-kop, één ingeregeld met de stelschroef.

## 0.52.0

Klanten tekenen zelf, een installateur controleert.

- **Direct een tekening maken** (inlogpagina): een klant zonder account
  opent de beregeningsplanner, tekent de tuin (ook met een foto of PDF als
  ondergrond en de lokale herkenning) en dient de tekening in met naam,
  e-mail, telefoon, adres en een vraag (*"Kan dit gecontroleerd worden?"*).
  Tot het indienen blijft de tekening alleen in de browser. De knop staat
  er alleen als de organisatie (organisatiecode) dat toestaat; instelling
  in **Beheer → Instellingen → Toegang** (standaard aan).
- **Controle van plannen**: een plan heeft nu een status *Concept*, *Ter
  controle* of *Goedgekeurd*. Een plan van een klant is nooit meteen
  definitief: de klant biedt het **ter controle** aan (of dient het in
  zonder account) en een installateur **keurt het goed**. Een installateur
  keurt een eigen plan in één keer goed. Wijzigt een klant een goedgekeurd
  plan, dan gaat het opnieuw ter controle.
- **Offerte alleen uit een goedgekeurd plan** (ook op de server
  afgedwongen); een losse offerte zonder plan blijft mogelijk.
- **Plannenoverzicht**: kolom en filter *Status* (direct naar
  `plannen/?review=ter_controle`), teller *ter controle*, de vraag en
  contactgegevens van wie zonder account indiende, knoppen *Controleren in
  de planner* en *Goedkeuren*; Excel-export met status en vraag.
- Nieuw recht **Plannen goedkeuren** (standaard beheerder en installateur).
- Het bedrijf krijgt een e-mail bij elke nieuwe aanvraag (als de mailserver
  en het e-mailadres in het bedrijfsprofiel zijn ingesteld). De indiener
  krijgt bewust geen mail: anders kon iedereen via het formulier mail naar
  willekeurige adressen laten sturen.
- Bestaande plannen van beheerders en installateurs gelden als goedgekeurd.
- Testdata: een tekening die zonder account is ingediend, een plan van een
  klant ter controle en een nog niet goedgekeurd plan van een installateur.
- Database: migratie 20 (controlestatus op `plans`, index op
  `tenant_id, review_status, updated_at`), voor SQLite en PostgreSQL.
## 0.51.0

Nieuws: berichten van de organisatie en wat is nieuw in de app.

- **Pagina Nieuws** (`nieuws/`, voor iedereen; tegel op het dashboard en in
  de zijbalk, en in het gebruikersmenu): links de berichten van de
  organisatie, rechts *Wat is nieuw in de app*, een versielogboek in gewone
  taal (zonder technische details) per versie. Wat na het vorige bezoek kwam
  heeft het label **Nieuw**.
- **Melding**: een bolletje met het aantal bij Nieuws (zijbalk, tegel,
  gebruikersmenu), een stip op het rondje rechtsboven en een balk op het
  overzicht zolang er iets nieuws is. Na het openen van de pagina is alles
  gezien (bewaard bij het account, dus op elk toestel). Een nieuw account
  krijgt geen lange lijst, alleen de laatste versie.
- **Berichten plaatsen** (nieuw recht *Nieuwsberichten plaatsen*, standaard
  de beheerder; aan te zetten voor andere rollen in Beheer → Rollen): titel,
  tekst (alinea's, aanklikbare links), voor *alle medewerkers* of *iedereen,
  ook klanten*, bovenaan vastzetten, bewerken en verwijderen. Optioneel ook
  per e-mail naar de collega's (los per ontvanger, via de eigen mailserver);
  klanten krijgen nooit een e-mail. Plaatsen, wijzigen en verwijderen staan
  in het auditlog (zonder de tekst).
- **Versielogboek** in `frontend/nieuws/releases.js`, per punt te beperken
  tot rechten (een klant ziet alleen wat voor hem geldt). Een test eist dat
  de versie uit `package.json` erin staat: bij elke versie-bump een regel
  toevoegen. Gevuld met de versies 0.36.0 tot en met 0.51.0.
- API `GET /api/news`, `POST /api/news`, `PUT|DELETE /api/news/:id` (recht
  `nieuws`), `POST /api/news/seen`; `api/me` geeft `news` (aantal nieuwe
  items, uit een cache van 30 s per omgeving, dus geen extra query per
  pagina). Voorkeuren `newsSeenAt` en `seenRelease` op het account.
- Database: tabel `news` (migratie 19, SQLite en PostgreSQL, index op
  tenant + datum). Testdata: drie berichten van de testbeheerder, één ook
  voor klanten en vastgezet.

## 0.50.0

- **E-mailinstellingen in Beheer → Instellingen** (verplaatst uit Offertes →
  Bedrijfsgegevens). Nieuw: soort **Exchange Online-connector (op IP)**,
  zonder gebruikersnaam en wachtwoord, via poort 25 met verplichte STARTTLS.
  De SMTP-server wordt voorgesteld uit het domein van de afzender.
- Het scherm toont het **WAN-IP van de server** (het openbare uitgaande
  adres, niet dat van Cloudflare) om vrij te geven in de connector, met
  knoppen Kopiëren en Opnieuw bepalen, plus een korte handleiding voor
  Office 365. Vast in te stellen met `WAN_IP` in de Docker-omgeving.
- API: `/api/admin/mail[/test]` en `/api/admin/wan-ip` (alleen beheerders);
  het wachtwoord gaat nooit terug naar de browser.

## 0.49.0

- **Rollen aanpassen** (**Beheer → Rollen**): per rol de rechten aan- en
  uitzetten in één tabel, naam en omschrijving wijzigen en eigen rollen
  toevoegen (medewerker of klant, eventueel met de rechten van een bestaande
  rol als start). Wijzigingen gelden direct en staan in het auditlog. De
  beheerder houdt vaste rechten; een eigen rol kan pas weg als niemand hem
  meer heeft. Rollen gelden voor de hele organisatie, ook in test.
- **Nieuwe rol Planner**: plant werkorders in de agenda, stuurt de
  afspraaklink naar de klant en ziet werkorders en klantdossiers, zonder
  offertes, plannen of beheer. Een planner is zelf geen uitvoerder en ziet
  op het startscherm standaard de hele ploeg.
- **Nieuwe rechten** Planning en Uitvoerder: de planning en het inplannen
  of versturen van een afspraak vragen nu het recht Planning; wie als
  uitvoerder kan worden ingepland, bepaalt het recht Uitvoerder (standaard
  beheerder en installateur, zoals voorheen).
- Testdata: een testplanner (`<code>.planner`) die in de planning start.
- Database: migratie 18 (tabel `roles`, rol van een gebruiker is een vrije
  sleutel), voor SQLite en PostgreSQL.

## 0.48.0

Opdrachten uitbesteden aan andere organisaties op het platform.

- **Uitbesteden**: te veel werk? Een beheerder biedt een werkorder (status
  Nieuw of Gepland) aan bij één andere organisatie of bij iedereen die
  opdrachten ontvangt, met een bericht en eventueel een vergoeding. Vanuit de
  werkorder via menu ⋯ → *Uitbesteden aan andere organisatie*, en terug te
  zien in de nieuwe module **Uitbesteden**.
- **Aannemen of afwijzen**: de ontvangende organisatie ziet het aanbod in
  Uitbesteden → *Aangeboden aan ons* en neemt het aan of wijst het af (met
  toelichting). Wie aanneemt krijgt een eigen werkorder (eigen nummer) met de
  klantgegevens, werkstappen, zones en materialen. Bij een open aanbod krijgt
  de eerste die aanneemt de opdracht.
- **Alleen met opt-in**: versturen en ontvangen staan standaard uit en zet de
  beheerder van de organisatie aan in Beheer → Instellingen → Uitbesteden,
  met een werkgebied dat andere organisaties zien. Recht `uitbesteden`
  (beheerder). Een testomgeving werkt alleen met andere testomgevingen.
- **Alleen delen wat nodig is**: vóór het aannemen ziet een andere organisatie
  geen klantnaam, adres, contactgegevens of instructies, alleen omschrijving,
  plaats (postcodecijfers en woonplaats), planning, werkstappen met uren en
  materialen. Offerte, prijzen, foto's en de eigen ploeg gaan nooit mee. De
  uitbesteder ziet daarna alleen de voortgang (status, planning, afgevinkte
  stappen, opleverdatum), bij de werkorder en in Uitbesteden.
- Berichten per e-mail (als er een mailserver is ingesteld) bij een nieuw
  aanbod, aannemen en afwijzen; alles in het auditlog.
- Tabel `work_order_offers` (migratie 17, SQLite en PostgreSQL); testdata
  biedt een geplande werkorder aan andere testomgevingen aan.

## 0.47.0

- **Snellere database (Supabase)**: elk verzoek kost minder rondgangen naar
  de database en haalt alleen op wat het toont. Sessie, gebruiker en tenant
  in één query (was 4 per verzoek); de laatste-activiteit wordt alleen nog
  geschreven als die ouder is dan 5 minuten; scripts en stylesheets van een
  pagina controleren de sessie één keer per 30 seconden.
- **Plannen opslaan** leest het plan (met de achtergrondafbeelding van
  megabytes) niet meer terug uit de database; het plannenoverzicht haalt
  alleen de vlakken en aantallen op. Verwijderen leest het plan zonder
  achtergrond.
- **Eén query in plaats van twee of meer**: offerte en werkorder openen,
  klantportaal (was één query per werkorder), klantdossier (foto's per
  installatie), supporttoestemmingen in Hoofdbeheer, klantaccounts bij een
  offerte, het startscherm (foto's alleen van de klussen van die dag).
- **Geen overbodige kolommen**: gebruikersbeheer zonder wachtwoord-hashes,
  werkorderlijsten zonder versleutelde klantlink, controles bij bewerken
  zonder offerte-inhoud en handtekening.
- **Nieuwe indexen** (migratie 16, SQLite en PostgreSQL): historie en plannen
  per gebruiker, werkorders per uitvoerder en datum, verlopen sessies,
  impersonaties per gebruiker.
- **Nergens meer `SELECT *`**: elke query noemt de kolommen die hij nodig
  heeft, zodat een nieuwe (grote) kolom nooit ongemerkt meekomt.
- `test/queries.test.js` bewaakt het aantal queries, de hoeveelheid data en
  dat er geen `SELECT *` in de backend staat.

## 0.46.1

Beveiligingscontrole.

- **Limieten per bezoeker**: achter de Cloudflare-tunnel kwam elk verzoek van
  hetzelfde adres (de tunnel), dus golden de inloglimiet (10 per kwartier) en
  de limiet op openbare offerte- en afspraaklinks voor alle bezoekers samen:
  één persoon kon zo het inloggen voor iedereen blokkeren. De app gebruikt nu
  het echte bezoekers-IP (`CF-Connecting-IP`), maar alleen als het verzoek van
  een proxy in het eigen netwerk komt. Ook het auditlog toont nu dat adres.
- **Geen toegang tot het eigen netwerk**: de mailserver en de webshop die een
  organisatie invult, moeten een openbaar adres hebben. De naam wordt eerst
  opgezocht; interne adressen (LAN, Docker, Tailscale, localhost) worden
  geweigerd. De mail gaat naar het gecontroleerde adres, het certificaat
  blijft op naam gecontroleerd.
- **Verzoeken van andere subdomeinen** die iets wijzigen worden geweigerd
  (`Sec-Fetch-Site`); SameSite-cookies houden andere sites al buiten, maar
  niet de andere apps onder hetzelfde domein.

## 0.46.0

- **Geen tussenstappen meer**: een offerte die u vanuit het portaal, een
  klantdossier, een werkorder of de planner opent, verschijnt meteen (zonder
  eerst het overzicht), net als werkorders. De terugknop brengt u terug naar
  waar u vandaan kwam (bijv. **← Mijn portaal**, **← Klantdossiers**,
  **← Werkorders**), via de echte terugstap van de browser.
- **Startpagina zonder omweg**: met een startpagina in Mijn profiel gaat de
  app daar direct heen; het dashboard wordt niet eerst opgebouwd (de server
  zet de startpagina in de pagina, `shared/common.js` volgt hem meteen).
- **Sneller laden**: kopbalk, zijbalk en module delen één verzoek voor
  `api/me` en `api/config` (was twee tot vier per pagina); werkorders,
  offertes, profiel, portaal en klantdossier halen hun gegevens tegelijk op
  in plaats van na elkaar. Scripts en stylesheets met versienummer blijven
  in de browsercache (`immutable`), dus geen controle meer bij elke klik. De
  Excel-bibliotheek (bijna 1 MB) laadt pas bij de eerste export.
- Terug op de planning, het dashboard, het portaal of een dossier via de
  knop Terug: de gegevens worden opnieuw opgehaald, zodat een gewijzigde
  status meteen klopt.
- Planner: **Nieuw project** vraagt alleen nog om bevestiging als er
  werkelijk iets verloren kan gaan.

## 0.45.0

- **Rechtstreeks naar de werkorder**: een klik op een afspraak in de planning
  (of op het startscherm, in een klantdossier of vanuit een offerte) opent
  meteen de werkorder, zonder eerst het werkorderoverzicht te tonen. De
  terugknop gaat terug naar waar u vandaan kwam (bijv. **← Planning**).
- **Korte omschrijving op de afspraak**: elke afspraak in de planning toont
  wat er gedaan moet worden: de eerste regel van de instructies, anders de
  omvang (zones, sproeiers, m² gazon) en de uitvoeringsstappen uit de offerte
  (`Core.summary`, veld `summary` in de werkorder-API). Ook op het startscherm
  van de installateur als er geen instructies zijn.

## 0.44.0

- **Kleuren kiezen**: een hoofdbeheerder kiest onder **Hoofdbeheer → Kleuren**
  de hoofd-, actie- en accentkleur van de app, met een live voorbeeld. Het
  standaardthema geldt voor alle organisaties (ook inloggen en de openbare
  offerte- en afspraakpagina); een organisatie kan een eigen thema krijgen,
  dat haar testomgevingen volgen. Zonder keuze blijft de huisstijl van
  AquaTech Service, met een knop om die terug te zetten.
- **Leesbaar**: kleuren die te licht zijn voor witte tekst worden geweigerd
  (hoofdkleur minimaal 4,5:1, actiekleur 3:1); de donkere en lichte tinten
  worden afgeleid en blijven leesbaar.
- Vensters in Beheer/Hoofdbeheer en de hulp in de planner vallen niet meer
  half achter de zijbalk.
## 0.43.0

- **Mijn profiel** (nieuwe pagina `profiel/`, voor elke rol met een eigen
  account): naam, e-mailadres en telefoonnummer wijzigen, persoonlijke
  voorkeuren en het wachtwoord wijzigen op één plek. Bereikbaar via het
  gebruikersmenu rechtsboven en onderaan de zijbalk.
- **Gebruikersmenu in de kopbalk**: de losse knoppen *Wachtwoord* en
  *Uitloggen* zijn vervangen door een rondje met initialen (met de naam op
  een breed scherm) dat een menu opent met *Mijn profiel* en *Uitloggen*.
  Zo past de kopbalk ook op de telefoon.
- **Voorkeuren**: *Startpagina* (de app opent na het starten of inloggen in
  een gekozen module) en *kopie van verstuurde offertes en afspraken* (bcc
  naar het eigen e-mailadres).
- **Versienummer** staat niet meer in de kopbalk; beheerders zien het op
  Mijn profiel.
- Database: kolommen `email`, `phone` en `preferences` (JSON) op `users`
  (migratie 15, SQLite en PostgreSQL). API `GET`/`PUT /api/account/profile`;
  het logboek legt vast welke velden zijn gewijzigd, nooit de waarden.
  Beheerders zien e-mail en telefoon in het gebruikersoverzicht (API).
- Testdata: testaccounts hebben een e-mailadres, telefoonnummer en
  voorkeuren.

## 0.42.0

- **Startscherm voor installateurs**: het overzicht begint met *Vandaag*:
  de klussen die vandaag op je naam staan (ook elke werkdag van een
  meerdaagse klus, met "dag 2 van 3"), op starttijd. Per klus de tijd,
  status, klant, adres met **Route**, **Bellen**, de werkplekafspraken en
  instructies, de voortgang van de werkstappen en directe knoppen naar de
  werkorder en de foto's. Bladeren per dag, **Hele ploeg** toont de klussen
  van iedereen (standaard voor beheerders), en staat er niets gepland dan
  zie je de eerstvolgende klus. Gemaakt voor de telefoon.
- API `GET /api/my-day?date=JJJJ-MM-DD[&all=1]` (recht werkorders).

## 0.41.0

- **Zijbalk netjes uitgelijnd**: de lijn onder het logo in de zijbalk ligt nu
  precies op de onderkant van de kopbalk, op elke pagina (de hoogte van de
  kopbalk wordt gemeten, ook in de planner waar die hoger is).
- **Mijn portaal** heeft een eigen icoon (persoon) in plaats van het huisje,
  zodat het niet meer op een dubbel *Overzicht* lijkt.
- **Geen "Binnenkort" meer in de zijbalk**: de zijbalk toont alleen modules
  die er zijn en aan staan. Aan- en uitzetten gaat bij Beheer > Instellingen >
  *Modules* (geldt voor zijbalk en dashboard); geplande modules staan daar
  als "binnenkort" en zijn aan te zetten zodra ze klaar zijn.

## 0.40.0

- **Planning als agenda** met drie weergaven, te wisselen bovenaan:
  - **Dag**: de tijd verticaal en de installateurs naast elkaar als kolommen
    (Outlook-achtig), met een rode lijn op het huidige tijdstip. Op een
    telefoon scroll je horizontaal langs de installateurs.
  - **Werkweek**: de tijd verticaal en de dagen als kolommen; de kleur van
    een blok is de uitvoerder.
  - **Maand**: maandrooster met de klussen per dag (op een telefoon als
    gekleurde stippen); een dag aantikken opent de dagweergave.
- **Plannen op tijdstip**: sleep een werkorder naar een tijd (per kwartier)
  in de dag- of werkweekweergave. Heeft de werkorder nog geen eindtijd, dan
  volgt het blok meteen uit de **geplande uren uit de offerte** (de
  werkstappen); meer dan een werkdag van 8 uur wordt verdeeld over gelijke
  werkdagen (12 uur vanaf 08:00 = 2 dagen 08:00–14:00). Een blok dat al een
  eindtijd heeft houdt zijn lengte. Hetzelfde gebeurt in de werkorder als je
  een starttijd invult zonder eindtijd. De geplande uren staan op elk blok.
- Filter op uitvoerder (of *Mijn klussen*), weekend aan/uit, naar een datum
  springen, en Excel-export van wat in beeld is. De gekozen weergave wordt
  onthouden; op een telefoon begint de planning in de dagweergave.

## 0.39.0

- **Supabase is de standaard in productie**: de productie-compose gebruikt
  `DATABASE_URL_FILE`; de release-pipeline test elke versie ook tegen
  PostgreSQL voordat er een image komt. SQLite blijft de terugval zonder
  databaseverbinding (lokaal, tests, noodgeval) en het formaat van de
  versleutelde back-ups.
- **Back-up op commando**: `node src/backup.js create` maakt een versleutelde
  back-up, ook van PostgreSQL en terwijl de app draait. `update.sh` doet dat
  vóór elke update (bij Supabase in plaats van de oude kopie van
  `aquatech.db`) en zet bij een mislukte update alleen de image terug.

## 0.38.0

- **Foto's bij werkorders**: in de werkorder de kaart *Foto's van de
  installatie*. Op de telefoon opent **Foto maken** direct de camera,
  **Foto's kiezen** neemt er meerdere tegelijk uit de galerij (op de
  computer ook slepen). Per foto de fase (voor, tijdens, oplevering), een
  bijschrift en of de klant hem mag zien; vergroten met vorige/volgende (ook
  vegen). De browser verkleint foto's naar max. 2048 px (JPEG), waarmee ook
  EXIF en GPS-locatie wegvallen; de server haalt bij JPEG alsnog EXIF/XMP
  weg, accepteert alleen JPEG, PNG en WebP (op inhoud gecontroleerd) en
  max. 100 foto's per werkorder.
- **Veilige opslag**: foto en miniatuur staan versleuteld (AES-256-GCM, eigen
  van de hoofdsleutel afgeleide sleutel, tenant + foto-id als AAD) in de
  database (nieuwe tabel `work_order_photos`, migratie 14). Ze gaan dus mee
  in de versleutelde back-ups en in Supabase, en verdwijnen met het
  definitief wissen van de werkorder, de testomgeving of de tenant.
- **Klantdossiers** (nieuwe module, beheerder en installateur): per klant
  alle installaties met opleverdatum, wie heeft afgetekend en uitgevoerd,
  opmerkingen, ontwerp, zone-indeling, geplaatste materialen, foto's per
  fase en de offertes. Af te drukken als **opleverrapport** (PDF via het
  printvenster), met of zonder interne foto's. Overzicht van alle klanten
  met Excel-export. Een klant hoort bij een dossier via zijn klantaccount of,
  zonder account, via de naam op de werkorder.
- Voor het klantportaal: `GET /api/portal/photos/:id` geeft een klant alleen
  de zichtbaar gezette foto's van zijn eigen werkorders.
- Testdata: foto's bij de opgeleverde werkorder en de werkorder in
  uitvoering.

## 0.37.0

- **Klantportaal** (module *Mijn portaal*, voor klanten): één overzicht met
  wat er voor de klant klaarstaat (offertes om te beantwoorden, afspraken om
  te bevestigen), de werkzaamheden uit zijn offertes met datum, monteur en
  voortgang, zijn offertes en plannen, en de contactgegevens van het bedrijf.
- **Opleverdossier** per werkorder in het portaal: afgevinkte werkzaamheden,
  zones, gebruikte materialen (zonder prijzen), opmerkingen bij de
  oplevering en de foto's voor de klant; af te drukken of op te slaan als
  PDF. Interne gegevens (uren, werkinstructies, locatienotities, ploeg)
  blijven bij de medewerkers.
- Nieuw recht `portaal` voor de rol klant; API `/api/portal`.
- Testdata: een vierde testklant (`klant4`) met een ingeplande werkorder,
  zodat het portaal een afspraak toont.

## 0.36.0

- **Planning** (nieuwe module, tegel op het dashboard en in de zijbalk, voor beheerders en
  installateurs): weekagenda van alle werkorders, met een rij per uitvoerder
  en een kolom per dag (weekend optioneel). Inplannen of verplaatsen door een
  werkorder naar een dag en uitvoerder te slepen; op een telefoon tik je eerst
  op de werkorder en dan op de dag. Ernaast staan de werkorders die nog
  ingepland moeten worden en de klanten die om een ander moment vragen (met
  hun toelichting). Kerncijfers per week en export van de weekplanning naar
  Excel.
- **Werkorders** hebben naast datum en starttijd nu een eindtijd en een
  aantal **werkdagen** (een klus van meer dagen staat op elke werkdag,
  weekenden overgeslagen).
- **Afspraak bevestigen via een link**: vanuit de werkorder stuur je de klant
  de afspraak per e-mail (eigen mailserver), via het eigen mailprogramma of
  als gekopieerde link. Op de openbare pagina (zonder account, ook op de
  telefoon) ziet de klant datum, tijden, werkdagen en adres, zet hij de
  afspraak in zijn agenda (.ics) en **bevestigt** hij met zijn naam, of
  **vraagt hij een ander moment** met een toelichting. Tijdstip, naam en
  IP-adres worden vastgelegd en het bedrijf krijgt een e-mail. Verschuift de
  planning daarna, dan staat de afspraak weer op *wacht op klant* tot de
  klant het nieuwe moment bevestigt. Stand van de afspraak zichtbaar in de
  werkorder, het overzicht en de planning.
- Testdata: de werkorders hebben een afspraaklink en een reactie van de
  klant (bevestigd of ander moment gevraagd).

## 0.35.0

- **Zijbalk voor beheerders**: beheerders en hoofdbeheerders krijgen op elke
  pagina een vaste zijbalk met alle modules (Overzicht, Beregeningsplanner,
  Plannenoverzicht, Offertes, Werkorders, onder *Beheer* Beheer en
  Hoofdbeheer, en de geplande modules onder *Binnenkort*) in plaats van het
  tegeldashboard. De actieve module is gemarkeerd. Welke modules erin staan
  volgt uit de rechten en uit de modules die bij Beheer > Instellingen zijn
  uitgezet, net als bij de tegels; een nieuwe module in
  `dashboard/modules.js` verschijnt er vanzelf in.
- De zijbalk is in te klappen tot een smalle iconenbalk (per browser
  onthouden); de planner begint ingeklapt, zodat de tekening de ruimte houdt.
  Op een smal scherm (telefoon, kleine tablet) is de zijbalk een lade die
  opent met de menuknop links in de kopbalk; het projectmenu van de planner
  blijft rechts.
- Installateurs en klanten houden voorlopig het tegeldashboard.

## 0.34.0

- **Supabase (PostgreSQL) als database**: met `DATABASE_URL` (of
  `DATABASE_URL_FILE` als Docker-secret) gebruikt de app PostgreSQL, bijv.
  Supabase, in plaats van het SQLite-bestand. Zonder die instelling blijft
  alles zoals het was. Het schema in PostgreSQL is gelijk aan dat in SQLite
  (zelfde tabellen, kolommen, controles, foreign keys en indexen), in een
  eigen schema `aquatech` met row level security, zodat de REST-API van
  Supabase er niet bij kan. Verbinding altijd via TLS met controle van het
  certificaat (de root-CA van Supabase zit in de app).
- **Overstap één op één**: `node src/migrate-to-postgres.js` kopieert alle
  gegevens (tenants, gebruikers, sessies, plannen, historie, offertes,
  werkorders, instellingen, webshop, auditlog) ongewijzigd en controleert
  daarna per tabel het aantal rijen en een SHA-256 over alle waarden.
  Versleutelde geheimen blijven met dezelfde hoofdsleutel leesbaar en
  ingelogde gebruikers blijven ingelogd. Stappen in DOCS.md > *Database:
  Supabase (PostgreSQL)*.
- **Back-ups** werken ook met PostgreSQL: de versleutelde back-up is dan een
  kopie van alle rijen als SQLite-bestand (zelfde formaat, zelfde
  terugzetopdracht).
- De hele testsuite draait in CI ook tegen PostgreSQL.

## 0.33.0

- **Tenants verwijderen**: in **Hoofdbeheer** heeft elke live-tenant (behalve
  de hoofdtenant) een knop **Verwijderen**. Ter bevestiging typ je de
  tenantcode over. De tenant gaat definitief weg met al zijn testomgevingen,
  gebruikers, sessies, plannen, historie, offertes, werkorders, instellingen,
  webshopgegevens en auditlog; in de auditlog van de hoofdtenant blijft een
  regel *Tenant verwijderd* staan. Alleen voor hoofdbeheerders.
- **Back-ups verwijderen**: knop **Verwijderen** per back-up in **Beheer →
  Instellingen** (alleen hoofdbeheerders).
- **Geaccordeerde offertes** verwijderen of definitief wissen kan alleen na
  het overtypen van het offertenummer (ook in de API: `{ confirm: nummer }`).
  Verwijderen van een offerte komt nu ook in de auditlog.

## 0.32.0

- **Testdata vult alle features**: naast accounts, plannen en offertes nu ook
  klantlinks (verstuurd en bekeken), opties, digitaal akkoord met naam en
  handtekening, een afwijzing met reden, werkorders (gepland, in uitvoering,
  gereed) en een nepwebshop met prijzen. Klantlinks, reacties en werkorders
  lopen via dezelfde opslaglogica als in de app. Een test controleert dat
  elke tabel met gegevens per tenant testdata krijgt, zodat een nieuwe
  feature de testdata meeneemt.
- **Klantlink zichtbaar bij de offerte**: onder *Digitale offerte* staat het
  adres dat de klant krijgt, met **Kopiëren** en **Openen** (openen telt niet
  als bekeken door de klant). Een verstuurde offerte zonder link zegt dat
  ook; het verzendvenster toont de link die in de e-mail komt.

## 0.31.0

- **Eigen wachtwoord wijzigen**: knop *Wachtwoord* rechtsboven (naast
  Uitloggen) opent de pagina `wachtwoord`. Met het huidige wachtwoord ter
  controle; daarna is de gebruiker op zijn andere toestellen uitgelogd. Na
  10 foute pogingen 15 minuten geblokkeerd; vastgelegd in de auditlog.
- **Wachtwoord wijzigen na eerste aanmelding**: beheerders (Beheer →
  Gebruikers) en hoofdbeheerders (Hoofdbeheer → Gebruikers, nieuwe tenant)
  kunnen per gebruiker afdwingen dat die bij de volgende aanmelding eerst
  zelf een wachtwoord kiest. Standaard aan bij een nieuw account en bij een
  nieuw wachtwoord van een beheerder; aan/uit via de kolom *Nieuw ww.
  verplicht*. Zolang het aan staat toont elke pagina alleen het
  wachtwoordscherm en weigert de API de rest (`password_change_required`).
  Database-migratie 12 (`users.must_change_password`).

## 0.30.0

- **Gebruikers verwijderen**: knop *Verwijderen* (met bevestiging) in Beheer →
  Gebruikers en Hoofdbeheer → Gebruikers, API `DELETE /api/admin/users/:id`
  en `DELETE /api/platform/tenants/:id/users/:uid`. Plannen, offertes en
  werkorders gaan naar de systeemgebruiker *Verwijderde gebruiker*; sessies,
  supporttoestemmingen en impersonaties van het account verdwijnen. Niet
  mogelijk voor het eigen account, de laatste actieve beheerder van een tenant
  en de laatste actieve hoofdbeheerder. Auditregel `gebruiker_verwijderd`.

## 0.29.2

- **Hoofdbeheerder kon niet inloggen** als er nog een organisatiecode in het
  inlogveld stond (de browser onthoudt de code van de vorige inlog) of als
  de naam van de hoofdtenant werd ingevuld. Hoofdbeheerders horen bij de
  hoofdtenant en loggen nu in met elke organisatiecode; gewone gebruikers
  blijven gebonden aan de code van hun eigen organisatie.

## 0.29.1

- **Home Assistant-verpakking verwijderd**: `config.yaml`, `apparmor.txt`,
  `icon.png`, `logo.png` en `repository.yaml` zijn weg. De app draait alleen
  nog als Docker-container (Cloudflare-tunnel, automatische uitrol via CI/CD).
- Versiecheck (`scripts/check_version.py`, workflow `version.yml`) kijkt alleen
  nog naar `backend/package.json`.

## 0.29.0

- **Webshopkoppeling** (prototype, WooCommerce): in **Beheer → Webshop**
  koppelt een beheerder de webshop van de organisatie. De stuklijst in de
  planner, de Excel-export en nieuwe offertes gebruiken dan de naam, prijs
  (omgerekend naar excl. btw), het artikelnummer en de link uit de webshop;
  artikelen zonder koppeling houden de indicatieve prijs.
  - Ophalen via de openbare Store API (geen sleutels) of de REST API v3 met
    alleen-lezen sleutels; de sleutels staan versleuteld in de instellingen.
  - Koppelen op SKU gelijk aan de artikelcode, het productveld
    `aquatech_code` of een handmatige lijst `ARTIKELCODE=SKU`. Het tabblad
    toont welke artikelen nog niet gekoppeld zijn.
  - Per organisatie en per omgeving (een testomgeving heeft een eigen
    koppeling); producten in de nieuwe tabel `shop_products` (migratie 11).
  - In een offerte komt de materiaalopslag niet op regels met een
    webshopprijs (die is al een verkoopprijs); overige regels houden de opslag.
  - Alleen openbare https-adressen; mislukt het ophalen, dan blijven de
    vorige producten staan en ziet de beheerder de foutmelding.

## 0.28.0

- **Werkorders** (nieuwe module, tegel op het dashboard, voor beheerders en
  installateurs; een klant ziet ze niet): van een offerte met status
  **Akkoord** maak je een werkorder, in de offerte met de knop **Werkorder
  maken** of in de module via **Nieuwe werkorder uit offerte**.
- De werkorder bevat het uitvoeringsplan: werkstappen per fase
  (voorbereiding, uitvoering, oplevering) in een logische volgorde, met de
  uren uit de offerte en een kolom voor de werkelijke uren; de zone-indeling
  uit het plan (onderdelen, debiet, leidinglengte en druk per zone); en de
  materiaallijst zonder prijzen om af te vinken bij het verzamelen.
- Inplannen met datum en starttijd, toewijzen aan een uitvoerder, ploeg,
  werkinstructies, bijzonderheden van de locatie en een opleverblok. De
  status volgt vanzelf (datum = gepland, eerste afgevinkte stap = in
  uitvoering) en is ook met de hand te zetten.
- Werkbon als PDF (afdrukversie met afvinkvakjes en aftekenregels) en Excel
  (werkorder, zones en materialen op aparte tabbladen); het overzicht is ook
  naar Excel te exporteren. Nummering `WO-<jaar>-0001` per omgeving.
- Opties uit de offerte die de klant niet heeft gekozen, komen niet in de
  werkorder (materialen en werkstappen).

## 0.27.0

- **Hoofdbeheerders aanmaken**: in Hoofdbeheer opent de knop
  *Hoofdbeheerders* de gebruikers van de hoofdtenant. Daar kun je een nieuwe
  gebruiker meteen hoofdbeheerder maken, of een bestaand account
  hoofdbeheerder maken of dat weer intrekken. Hoofdbeheerders horen altijd
  bij de hoofdtenant en hebben de rol beheerder.
- Alleen een hoofdbeheerder kan een hoofdbeheerder wijzigen, uitschakelen,
  een nieuw wachtwoord geven of uitloggen; een gewone beheerder van de
  hoofdtenant niet meer. De laatste actieve hoofdbeheerder kan niet worden
  ingetrokken of uitgeschakeld.
- **Nieuwe tenant: duidelijke velden voor de eerste beheerder**. Volledige
  naam, gebruikersnaam en wachtwoord staan apart met uitleg eronder; de
  gebruikersnaam vult zich vanuit de naam ("Piet Groen" → `piet.groen`) en
  wordt vanzelf in kleine letters gezet. Een fout geeft een melding die zegt
  wat er mis is, in plaats van de browsermelding "Gebruik de gevraagde
  notatie". Onder het formulier staat waarmee de beheerder inlogt
  (organisatiecode + gebruikersnaam).
- Zelfde uitleg bij het toevoegen van gebruikers in Hoofdbeheer en Beheer.

## 0.26.0

- **Digitale offerte**: per offerte een persoonlijke link (*Digitale offerte*
  in de editor). De klant opent die zonder account, bekijkt de offerte, kiest
  eventuele opties en geeft akkoord met zijn naam, een handtekening (muis,
  vinger of pen) en een vinkje voor de voorwaarden, of wijst af met een reden.
  - Vastgelegd: naam, tijdstip, IP-adres, browser, handtekening, gekozen
    opties, totaalbedrag en een kenmerk (SHA-256) van de geaccordeerde inhoud.
    Daarna ligt de offerte vast; wijzigen kan alleen via een kopie.
  - Je ziet of en hoe vaak de klant de offerte heeft geopend; de link is in
    te trekken. Alleen een hash van het token staat doorzoekbaar in de
    database, het token zelf versleuteld.
  - **Opties**: zet een regel op *Optie* of *Optie (aan)*; de klant vinkt die
    zelf aan of uit en het totaal rekent mee (ook in PDF en Excel).
- **E-mail** via de eigen SMTP-server (Bedrijfsgegevens → E-mail, wachtwoord
  versleuteld): offerte versturen met een knop naar de digitale offerte,
  bevestiging naar de klant na een akkoord en een bericht naar het bedrijf.
  Zonder mailserver opent *Versturen* het bericht in je eigen mailprogramma.
- Klantaccounts geven in *Mijn offertes* op dezelfde manier akkoord (naam,
  handtekening, voorwaarden).

## 0.25.0

- **Gebruikersnamen uniek per organisatie**: de tenant wordt niet meer uit de
  gebruikersnaam afgeleid. Dezelfde naam (bijvoorbeeld een voornaam) kan in
  meerdere organisaties bestaan; elke gebruiker heeft zijn eigen id.
- **Organisatiecode bij het inloggen**: de inlogpagina vraagt de code van de
  organisatie en onthoudt die in de browser; `login?org=<code>` vult hem in.
  Leeg = de hoofdorganisatie (hoofdbeheerders). De code van een testomgeving
  werkt ook. Beheer → Gebruikers toont de code en een inloglink; de Excel met
  testaccounts heeft een kolom Organisatiecode.
- Blokkade na tien mislukte pogingen geldt per organisatie en gebruikersnaam.
- Migratie 8 verwijdert de platformbrede index op gebruikersnaam; bestaande
  accounts blijven ongewijzigd (ze waren al uniek per tenant).

## 0.24.0

- **Inloggen als een gebruiker (impersonatie)** voor de hoofdbeheerder:
  vanuit Hoofdbeheer → Gebruikers werk je tijdelijk met de rol en rechten
  van een gebruiker. In een testomgeving zonder goedkeuring; in live alleen
  met toestemming die de gebruiker zelf geeft op het dashboard (*Support op
  afstand*, voor 1 uur tot 3 dagen, altijd in te trekken).
- Tijdens een impersonatie staat onderin elke pagina een rode balk met
  **Terug naar eigen account** (één klik); hoogstens 8 uur, en uitloggen
  stopt hem ook.
- Auditlog: start, einde (met reden: gestopt, verlopen, toestemming
  ingetrokken) en elke actie tijdens een impersonatie met de naam van de
  hoofdbeheerder. De gebruiker ziet zelf wie er heeft meegekeken.

## 0.23.0

- **Testomgeving vullen met testdata** (Hoofdbeheer): één knop maakt
  testaccounts voor elke rol (beheerder, twee installateurs, drie klanten)
  met één gedeeld wachtwoord, zeven nepklanten met een volledig getekende
  tuin (gebieden, sproeiers, systeemelementen en zones) en vijf offertes in
  alle statussen. De inloggegevens zijn als Excel te downloaden. Alleen in
  testomgevingen; wat er stond wordt eerst gewist.
- Testaccounts horen bij de testomgeving zelf: inloggen brengt je direct
  daar, een testbeheerder beheert alleen de testaccounts en Leegmaken of
  Verwijderen ruimt ze op. In Hoofdbeheer heeft elke testomgeving een knop
  **Testaccounts**.
- Offertes in een testomgeving kun je aan klantaccounts van live én van de
  testomgeving koppelen.

## 0.22.0

- **Rollen**: hoofdbeheerder, beheerder, installateur en klant. Elke rol
  ziet op het dashboard alleen wat erbij hoort en de API controleert de
  rechten zelf (één bron: `frontend/shared/roles.js`).
  - Hoofdbeheerder: alles, in elke tenant.
  - Beheerder: alles binnen de eigen organisatie.
  - Installateur: plannen en offertes van de hele organisatie, zonder
    gebruikers, instellingen of historie.
  - Klant: alleen de eigen plannen en de offertes die voor hem klaarstaan.
- Bestaande gebruikers worden installateur, gasten worden klant (migratie
  van de database; de oude rolnaam *gebruiker* wordt nog geaccepteerd).
- **Mijn offertes** voor klanten: een offerte koppel je bij *Klantaccount*
  aan een klant; vanaf de status Verzonden ziet de klant de offerte als
  document en kan hij akkoord geven of afwijzen (in het auditlog).
- Plannenoverzicht en offertes: installateurs zien alle plannen en offertes
  van de organisatie; de knop Offerte maken alleen voor wie offertes opstelt.

## 0.21.0

- **Offertes** (nieuwe module): een offerte opbouwen uit een
  beregeningsplan. De stuklijst wordt als materiaalregels overgenomen (met
  instelbare opslag) en de arbeid wordt uit het plan geschat (sproeiers,
  sleuven en leidingen, ventielen, besturing, druppelirrigatie,
  wateraansluiting, inregelen) tegen het uurtarief. Prijzen, aantallen,
  btw-tarief per regel, korting, klantgegevens en teksten zijn aan te passen
  en worden automatisch bewaard. Export als PDF (afdrukversie in huisstijl)
  en als Excel met formules; het overzicht van alle offertes ook naar Excel.
- Vast offertenummer per jaar en tenant, status (concept, verzonden,
  akkoord, afgewezen) en herkenbaar verlopen offertes.
- Bedrijfsgegevens, uurtarief, opslag, voorrijkosten en standaardteksten voor
  offertes per tenant (beheerders, in de module Offertes).
- Knop **Offerte maken** in de planner (stap Stuklijst & export) en in het
  plannenoverzicht.

## 0.20.0

- **Multitenant.** De app kan meerdere klanten (tenants) bedienen, elk met
  eigen gebruikers, plannen, historie en instellingen die de andere tenants
  niet zien. Inloggen blijft op dezelfde URL met gebruikersnaam en
  wachtwoord: de tenant volgt uit het account (gebruikersnamen zijn daarom
  uniek over het hele platform).
- **Hoofdbeheer** (nieuwe module, alleen voor hoofdbeheerders): alle tenants
  met gebruikers, plannen en laatste activiteit; tenants aanmaken (met
  meteen de eerste beheerder), hernoemen, uit- en inschakelen, gebruikers van
  een tenant beheren, een tenant openen om erin te werken, en het overzicht
  exporteren naar Excel. De bestaande beheerders van Aquatech zijn
  hoofdbeheerder geworden; de hoofdtenant kan niet worden uitgeschakeld en de
  laatste hoofdbeheerder blijft actief.
- **Testomgevingen naast live.** Per tenant een of meer testomgevingen met
  eigen plannen, historie en instellingen (bij het aanmaken gekopieerd, en
  desgewenst de huidige plannen). Wisselen gaat via de keuzelijst rechtsboven
  zonder opnieuw in te loggen of een andere URL. In een testomgeving staat
  een oranje streep en label in de kopbalk, en heeft de planner een eigen
  lokaal concept. Testomgevingen zijn leeg te maken of te verwijderen; live
  blijft ongemoeid. Beheerders van een tenant kunnen in de eigen
  testomgevingen werken, gewone gebruikers alleen in live.
- Limieten voor automatisch herkennen (per dag en per IP) gelden nu per
  tenant en per omgeving.
- Sessies horen bij de eigen tenant van het account; het auditlog en de
  bewaartermijnen werken per tenant en per testomgeving. Versleutelde
  geheimen worden bij een nieuwe testomgeving opnieuw versleuteld
  overgenomen.
- Back-ups (de hele database, alle tenants) zijn alleen voor
  hoofdbeheerders, of met de toegangscode van de hoofdtenant. Plan
  definitief wissen werkt in de actieve omgeving.
## 0.19.1

- Home Assistant-add-on: stoppen en herstarten gebeurt weer netjes. Sinds
  de app als gewone gebruiker draait, mocht het init-proces het stopsignaal
  niet doorgeven (AppArmor-profiel miste `capability kill`).

## 0.19.0

- **Versleutelde back-ups**: elke dag een kopie van de database in
  `/data/backups` (of `BACKUP_DIR`), versleuteld met een van de hoofdsleutel
  afgeleide sleutel. Standaard 14 dagen bewaard (Beheer → Instellingen →
  Back-ups, 0 = uit). Daar kun je ook direct een back-up maken en een
  back-up downloaden om elders te bewaren. Terugzetten:
  `node src/backup.js decrypt <back-up> <aquatech.db>`.
- **Plan definitief wissen** (AVG-verzoek, alleen beheerders, in het
  Plannenoverzicht): verwijdert het plan en haalt klant, adres, kopieën en
  IP-adressen uit de historie. Komt in het auditlog.

## 0.17.0

- **Na een update altijd de nieuwe opmaak.** Op de iPhone kon de browser (of
  de Cloudflare-tunnel) na een update nog een oude stylesheet gebruiken bij de
  nieuwe pagina, waardoor de kopbalk rommelig werd (losse "Menu"/✕-knop en
  afgesneden knoppen rechtsboven). De server zet nu de appversie achter elke
  stylesheet en elk script (`css/app.css?v=0.17.0`), zodat elke update ook
  nieuwe CSS en JS afdwingt.

## 0.16.0

Beveiliging van de opslag (getoetst aan OWASP ASVS niveau 2 en de AVG).

- **Geheimen versleuteld**: de API-sleutel en de toegangscode staan
  versleuteld in de database (AES-256-GCM). De hoofdsleutel staat in
  `/data/master-key` of, beter, los van de data in `AQUATECH_MASTER_KEY_FILE`
  (Docker-secret). Bestaande waarden worden bij de start vanzelf versleuteld.
  **Bewaar een kopie van de hoofdsleutel**: zonder die sleutel zijn de
  opgeslagen geheimen onbruikbaar.
- **Sessies op de server**: uitloggen, een nieuw wachtwoord, uitschakelen of
  *Uitloggen* bij een gebruiker (Beheer → Gebruikers) beëindigt een sessie
  meteen, ook op andere toestellen. Een sessie verloopt na 14 dagen zonder
  gebruik en uiterlijk na 30 dagen (instelbaar). De cookie bevat alleen een
  willekeurig token; de database alleen de hash daarvan. **Iedereen moet na
  deze update één keer opnieuw inloggen.**
- **Wachtwoorden**: minimaal 12 tekens, niet de gebruikersnaam en geen
  voorspelbare woorden (zoals *wachtwoord2024*). Sterkere hash (scrypt
  volgens OWASP); bestaande wachtwoorden blijven werken en krijgen bij de
  volgende inlog de sterkere hash. Na 10 mislukte pogingen is een account
  een kwartier geblokkeerd.
- **Installatiecode**: het eerste beheerdersaccount aanmaken kan alleen met
  de eenmalige code uit het serverlog (`docker compose logs aquatech`) of
  met de toegangscode, zodat niemand anders het beheer kan overnemen.
- **Auditlog** (Beheer → Auditlog): inloggen (ook mislukt), uitloggen,
  gebruikers- en instellingswijzigingen. Nooit wachtwoorden of sleutels.
- **Bewaartermijnen (AVG)**: IP-adressen in historie en auditlog worden na
  90 dagen gewist, auditregels na 365 dagen verwijderd (instelbaar onder
  Beheer → Instellingen).
- **Database**: alleen leesbaar voor de app (rechten 0600), verwijderde
  gegevens worden overschreven (`secure_delete`), integriteitscontrole bij de
  start. De server draait in de container als gewone gebruiker (niet root).
- **Beveiligingsheaders**: Content-Security-Policy, geen inbedden in frames,
  HSTS via https en geen caching van API-antwoorden.

## 0.15.0

- **Eerste beheerder in de browser.** Zolang er geen beheerdersaccount is,
  toont de app bij het openen het scherm *Welkom bij Aquatech* om het eerste
  beheerdersaccount (naam, gebruikersnaam, wachtwoord) aan te maken. Je bent
  daarna meteen ingelogd en het scherm verschijnt niet meer. De
  automatisch aangemaakte toegangscode in het log is vervallen.
- **Inloggen is standaard verplicht**: iedereen logt in met een eigen
  account. Gasten zonder inloggen kun je weer toestaan onder **Beheer →
  Instellingen**. De toegangscode blijft optioneel bestaan.
- De laatste actieve beheerder kan niet meer worden uitgeschakeld of
  gebruiker gemaakt (anders zou iedereen een nieuwe eerste beheerder kunnen
  aanmaken).
- **Los van Home Assistant**: geen ingress en geen HA-paneel meer (dat gaf
  automatisch beheerdersrechten), geen app-opties (`access_code`,
  `anthropic_api_key`, `ai_daily_limit`) meer; alles staat in de app onder
  Beheer → Instellingen of als omgevingsvariabele in Docker. De versie staat
  nu in `package.json`. De Home Assistant-verpakking blijft tijdelijk alleen
  bestaan zodat de huidige installatie deze update nog krijgt.

## 0.14.0

- **Nieuw: Plannenoverzicht** (tegel op het dashboard en *Alle plannen →*
  bij Mijn plannen): alle plannen in één tabel met projectnaam, klant, adres,
  gazon- en totale oppervlakte, vlakken, sproeiers, zones en datums.
  Sorteren door op een kolomkop te klikken, zoeken, totalen bovenaan en
  export naar Excel. Klik op een plan voor de details of open het in de
  planner.
  - Gebruikers zien alleen hun eigen plannen.
  - Beheerders zien de plannen van iedereen, met de gebruiker, het aantal
    aanvragen, een filter per gebruiker, eventueel ook verwijderde plannen,
    en per plan de tijdlijn uit de historie.

## 0.13.0

- **Mobiele navigatie verbeterd**: geen horizontaal scrollen meer op de
  telefoon.
  - Beregeningsplanner: Voorbeeld, Nieuw, Mijn plannen, Openen, Opslaan,
    Help en Naar het overzicht staan in een **hamburgermenu** (☰) dat als
    lade van rechts uitschuift; ongedaan maken/opnieuw blijven direct
    bereikbaar in de kopbalk. Ook op tablets (tot 1100 px) wordt het menu
    gebruikt, zodat de kopbalk niet meer over meerdere regels loopt.
  - Gereedschapsbalk op de telefoon: alleen iconen, en raster en lagen in
    een uitklapmenu **Lagen ▾**.
  - Dashboard en Beheer: compacte kopbalk (naam ingekort) en de tabbladen
    van Beheer in twee rijen.

## 0.12.0

- **Nieuw: instellingenscherm** onder **Beheer → Instellingen** (alleen
  beheerders), los van de Home Assistant-configuratie:
  - API-sleutel van Anthropic invullen, testen (zonder kosten) en
    verwijderen; de sleutel gaat nooit terug naar de browser, je ziet alleen
    de laatste 4 tekens;
  - AI-herkenning aan/uit, maximum per dag en per uur per IP-adres;
  - toegangscode wijzigen of verwijderen (andere toestellen worden
    uitgelogd, jij niet);
  - modules op het dashboard aan- of uitzetten.
  Alles staat in de database en werkt meteen, zonder herstart. De HA-opties
  `access_code`, `anthropic_api_key` en `ai_daily_limit` blijven werken als
  startwaarden zolang er in het scherm niets is opgeslagen.
- **Klaar voor een losse Docker-server** zonder Home Assistant:
  `docker compose up -d --build` (zie *Losse server (Docker)* in de
  documentatie). Bij de eerste start zonder toegangscode en zonder
  beheerdersaccount maakt de app zelf een toegangscode aan en zet die in het
  log. De container stopt netjes bij `docker stop` en heeft een healthcheck.

## 0.11.0

- **Nieuw: historie van aanvragen en gebruikers met rollen.** De app heeft
  nu een database (`/data/aquatech.db`, in de HA-back-ups).
  - **Mijn plannen**: elk plan wordt automatisch ook op de server bewaard.
    Gebruikers zien alleen hun eigen plannen (in de planner en op het
    dashboard).
  - **Beheer** (nieuwe module, alleen voor beheerders): historie van alle
    aanvragen met zoeken, filteren, details en Excel-export; overzicht van
    alle plannen; gebruikers aanmaken, rol wijzigen, wachtwoord resetten en
    uitschakelen.
  - Rollen: het HA-paneel en inloggen met de toegangscode zijn beheerder;
    accounts krijgen de rol beheerder of gebruiker. Zonder toegangscode
    krijgt elke browser een eigen anonieme gast.
  - Inlogpagina ook op `.../login`, met gebruikersnaam en wachtwoord (of
    alleen de toegangscode, zoals voorheen). Bestaande inlogs blijven geldig.
- Opgelost: automatisch herkennen vanuit de planner (`beregening/`) riep de
  API op het verkeerde pad aan; de API is nu ook onder elke module
  bereikbaar.
## 0.10.0

- **Huisstijl van AquaTech Service** (aquatechservice.nl) in het dashboard,
  de beregeningsplanner en de inlogpagina: het AquaTech Service-logo in de
  bovenbalk (op de telefoon alleen het schild), navy balken en kopteksten,
  groene knoppen en het lettertype Montserrat (lokaal meegeleverd, werkt ook
  zonder internet en onder Home Assistant).
- Nieuw icoon en logo in Home Assistant met het schild van het logo.

## 0.9.0

- **Nieuw: Aquatech-dashboard als startpagina.** De app is nu de basis van
  een groter pakket: de startpagina toont tegels per module. De
  beregeningsplanner is de eerste module; *Planning* en *Voorraadbeheer*
  staan er al als "binnenkort".
- De planner staat nu op `beregening/` (bijv.
  `https://aquatech.den-hollander.com/beregening/`) en heeft linksboven een
  knop **Overzicht** terug naar het dashboard. Het opgeslagen plan blijft
  gewoon staan; het dashboard toont het onder *Verder werken*.
- Het HA-zijpaneel heet nu **Aquatech** (was *Beregening*); de app heet
  in de add-on-winkel ook *Aquatech*. De slug blijft gelijk, dus de
  Cloudflare-tunnel en instellingen werken ongewijzigd.

## 0.8.0

- **Intekenen op telefoon en tablet**:
  - tik om een hoekpunt, element of sproeier te plaatsen (bij loslaten);
    met één vinger slepen verschuift het plan, knijpen met twee vingers
    zoomt — een pinch zet nooit per ongeluk een punt neer;
  - tekenbalk boven het plan met **Punt terug**, **Vorm sluiten** en
    **Stoppen/Annuleren** (vervangt Backspace, Enter en Esc);
  - ruimere raakzones voor hoekpunten, randmiddens, sproeiers en het
    eerste punt (vangzone zichtbaar), grotere grepen en de maat naast in
    plaats van onder de vinger;
  - geen 'ghost click' meer op het paneel dat na een tik verschijnt.
- **Mobiele lay-out**: plan bovenaan, stappenpaneel eronder dat inklapt
  tijdens tekenen (knop **▾ Paneel**), compacte, scrollbare top- en
  gereedschapsbalk en grotere knoppen bij touchbediening.
- Eigenschappen zijn op tablet en telefoon nu bereikbaar als zwevende kaart
  zodra iets geselecteerd is (voorheen verborgen onder 1100 px breed).

## 0.7.0

- **Lokale herkenning werkt nu ook op foto's en scans van getekende plannen**
  (potlood, stift), niet alleen op digitale plannen:
  - ongelijke belichting, grijs of getint papier en een kleurzweem worden
    gecorrigeerd (papierkleur over het hele vel geschat); het papier zelf
    wordt niet meer als één groot "droog te houden" vlak gezien;
  - bleke potloodkleuren en arcering worden uitgemiddeld; zwarte lijnen en
    tekst tellen daarbij niet mee en worden geen grijze "verharding" meer;
  - geel (terras, vlonder) wordt verharding, blauwgroen wordt heesters;
  - een gazon midden in de verharding valt niet meer binnen het
    verhardingsvlak (grote gaten blijven open);
  - titelblok, legenda en de rand van de foto (tafel) worden genegeerd.
- **Schaal**: staat er geen maat met maatlijn op het plan, dan vraagt de
  planner hoe breed de tuin is, in plaats van aan te nemen dat het hele vel
  30 m breed is (leeg laten = tuin 10 m). Bij een PDF met "schaal 1:N" wordt
  de schaal exact uit het paginaformaat berekend.
- Maten lezen is betrouwbaarder: een maatlijn die de tekst raakt wordt goed
  gemeten, "10,00 m" met lage OCR-betrouwbaarheid telt mee, en een gemiste
  komma ("100 m") of "1:100" gelezen als "1100" geeft geen verkeerde schaal
  meer.
- Samen met het lezen van labels uit 0.6.0: de getekende omtrek van een vlak
  (lijn zonder vulling) wordt nog steeds genegeerd, ook met de nieuwe
  sleutelgatsnede.

## 0.6.0

- **Labels lezen, ook handgeschreven.** Woorden als *gras*, *gazon*, *terras*,
  *border*, *beplanting*, *haag*, *vijver*, *grind*, *woning*, *plantenbak*
  (Nederlands, Duits en Engels; kleine schrijf- en leesfouten mogen) bepalen
  het soort vlak waarin ze staan:
  - in een gekleurd plan gaat het label vóór de kleur (een groen vlak met
    "border" wordt beplanting);
  - in een lijntekening of handschets wordt het vlak dat door de getekende
    lijnen rond het label wordt omsloten automatisch uitgetrokken.
- Tekstherkenning met Nederlandse taaldata, in meerdere rondes (normaal en
  zwart-wit, recht en gedraaid) voor betere resultaten bij handschrift.
- Bij een schaal uit één maat toont de planner welke maat gebruikt is en de
  resulterende planbreedte, zodat een verkeerde lezing direct opvalt.

## 0.5.0

- **Plan herkennen zonder AI.** "Plan laden en concept maken" werkt nu ook
  zonder API-sleutel, volledig in de browser en gratis:
  - vlakken worden op kleur herkend (groen = gazon, donkergroen = haag,
    bruin/roze = beplanting, grijs/beige = bebouwing en verharding,
    blauw = water), gaten door tekst en lijnen worden gedicht;
  - de schaal wordt gelezen uit maten met een maatlijn ("12,00 m", "450 cm",
    "8500" mm), ook verticale maten, via lokale tekstherkenning.
- Met een API-sleutel kies je in stap 1 tussen **Lokaal** en **AI**. Lukt de
  AI niet (bijv. geen tegoed), dan wordt automatisch lokaal herkend.

## 0.4.2

- Is het API-tegoed bij Anthropic op, dan meldt "Plan laden en concept maken"
  dat nu duidelijk (in plaats van "Herkennen mislukt (502)").

## 0.4.1

- **Duidelijkere foutmelding bij "Herkennen mislukt".** De melding van de
  AI-dienst wordt nu volledig getoond en in de log gezet.
- Weigert de AI-dienst het verzoek met de fallback-optie, dan probeert de app
  het automatisch één keer zonder.

## 0.4.0

- **Beregeningsmethode kiezen aan het begin (stap 1)** voor borders, hagen en
  plantenbakken: **druppelslang**, **druppelaars** (losse druppelaar per plant
  of pot via microbuis), **sproeiers** (pop-up 30 cm boven de beplanting) of
  **geen beregening**. Ook het sproeiertype voor het gazon kies je hier.
- **Per vlak afwijken** in het eigenschappenpaneel ("Beregening"), met
  hoeveelheden en gift (mm/u) per vlak.
- **Nieuw vlaktype Plantenbak** (standaard druppelaars); ook herkend bij
  "Plan laden en concept maken".
- Elke methode krijgt eigen zones (andere neerslag), het beregeningsschema
  rekent de looptijd per methode en de stuklijst bevat de juiste onderdelen
  (druppelaars, microbuis, aanvoerbuis, ponstang, 30 cm-sproeierhuizen).

## 0.3.0

- **Plan laden en concept maken.** Laad een tuinontwerp, plattegrond, schets
  of luchtfoto (JPG, PNG of **PDF**) en de planner leest zelf de schaal (via
  een maatlijn of schaalstok) en de vlakken: gazon, borders, hagen, woning,
  terras en bestrating. Daarna worden automatisch de wateraansluiting,
  besturing en ventielkast geplaatst, sproeiers verdeeld, zones ingedeeld en
  leidingen berekend. Alles is daarna gewoon aan te passen.
  Vereist een API-sleutel van Anthropic in de app-configuratie
  (`anthropic_api_key`); met `ai_daily_limit` (standaard 30) begrens je het
  aantal analyses per dag.
- **Toverstaf** (stap 2): klik midden in een vlak op het plan en de rand wordt
  op kleur automatisch uitgetrokken. Werkt ook zonder API-sleutel en offline.
- **Slimmere sproeierkeuze:** de worpwijdte wordt gekozen door meerdere
  varianten door te rekenen met de neerslagsimulatie (minder koppen, weinig
  water buiten het gazon, gelijkmatige verdeling).

## 0.2.2

- **Alle termen in correct Nederlands.** Onder meer *turbinesproeier* (was
  turbineregner), *meerstraalsrotator*, *sproeihoek* (was boog),
  *sproeibereik*, *neerslagkaart*, *gelijkmatigheid*, *beregeningscomputer*
  en *knelkoppeling*; uitvoeringsniveaus heten nu **Basis / Standaard /
  Premium**.
- Eenheden in Nederlandse notatie: m³/u, l/u en mm/u, en een decimale komma
  in maten, labels en de Excel-export.

## 0.2.1

- **Toegangscode is optioneel.** Zonder `access_code` is de planner via
  https://aquatech.den-hollander.com zonder inloggen te gebruiken. Vul je een
  code in, dan is inloggen buiten Home Assistant om weer verplicht.

## 0.2.0

- **Bereikbaar via https://aquatech.den-hollander.com** (Cloudflare-tunnel).
  De app luistert daarvoor ook op poort 3300.
- **Inloggen met een toegangscode** buiten Home Assistant om. Stel de code in
  onder **Configuratie** (`access_code`). Via het HA-zijpaneel is geen code
  nodig. Het toestel onthoudt de inlog een jaar; wijzig je de code, dan moeten
  alle toestellen opnieuw inloggen.

## 0.1.0

- **Eerste versie als Home Assistant-add-on.** De planner is te openen via het
  **Beregening**-paneel in het HA-zijmenu (ingress).
- Stappen: ondergrond & schaal, gebieden tekenen, systeemelementen,
  sproeiers (automatisch of handmatig, met neerslagsimulatie), zones &
  leidingen (drukverlies) en stuklijst met export naar Excel.
- Projecten worden in de browser bewaard; met **Opslaan/Openen** werk je met
  een projectbestand.
