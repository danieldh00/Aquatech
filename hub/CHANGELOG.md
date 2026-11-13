# Changelog

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
