# Aquatech

Aquatech is een modulair, ERP-achtig pakket voor beregeningsbedrijven, met een eigen webshop. Na het inloggen
kom je op een dashboard met een tegel per module (beheerders krijgen een zijbalk). Alles draait als één
webserver in Docker (poort 3300) met PostgreSQL (Supabase) of SQLite als database.

| Onderdeel | Wat het doet |
|---|---|
| **Webshop** (`/`) | Eigen winkel met categoriemenu, zoeken, varianten, groothandelsvenster, online betalen (Mollie), op rekening, retouren, SEO (sitemap, JSON-LD, productfeed). Staat standaard uit; dan stuurt `/` door naar de app. Ingelogde medewerkers en beheerders zien in de kop een knop *Beheer* naar `/app/`. |
| **App** (`/app/`) | Dashboard en modules. Openbare offerte- en afspraaklinks staan ook onder `/app/`. |
| Beregening | De beregeningsplanner (hieronder), met *Alles in winkelwagen* vanuit de stuklijst. |
| Plannen, Offertes, Facturen | Plannen met goedkeuring, digitale offerte met akkoord, facturen (PDF, mail, Visma eAccounting met overzicht van de toestemmingen, een logboek en bediening: pauzeren, onderdelen aan/uit, intrekken), debiteuren. |
| Werkorders, Planning | Werkorders uit een offerte of melding, agenda, afspraaklink voor de klant, uren en materiaal, foto's, nacalculatie. |
| Artikelen | Artikelen met varianten en afbeeldingen, voorraad met FIFO-kostprijs, bestelvoorstel, koppeling met WooCommerce. |
| Webshopbestellingen | Bestellingen, betalingen, terugbetalen, retouren en de margerapportage. |
| Meldingen, Klantportaal, Klantdossier | Storingen en onderhoud melden, opleverdossier en installatiedossier per locatie. |
| Uitbesteden, Nieuws, Profiel | Werk tussen organisaties, berichten en versielogboek, eigen voorkeuren en tweestapsverificatie. |
| Beheer, Hoofdbeheer | Instellingen, gebruikers en rollen, back-ups, testomgevingen; platform: organisaties, hoofdbeheerders, multitenancy. Kleuren en de Visma-koppeling zijn per organisatie. |

### Beheer in het kort

- **Instellingen** (Beheer → Instellingen) staan in de database en werken zonder herstart: AI-sleutel, mail,
  webshop, Mollie, Visma, seizoensherinneringen enz. Docker-omgevingsvariabelen zijn alleen startwaarden.
  Geheimen worden versleuteld opgeslagen en nooit volledig getoond.
- **Testomgeving**: elke organisatie kan een testomgeving maken met eigen gegevens en testdata. Koppelingen naar
  buiten (webshop, Mollie, mail, Visma) gaan daar niet mee.
- **Multitenancy** (Hoofdbeheer → Multitenancy, standaard uit): uit = één organisatie, zonder organisatiecode bij
  het inloggen. Aan = meer organisaties naast elkaar, elk met eigen gegevens (afgeschermd met `tenant_id` en
  row-level security in PostgreSQL).
- **Foutopsporing** (Beheer → Instellingen → Foutopsporing, per omgeving, standaard uit): elke onverwachte fout
  krijgt een **foutcode** (ook in het serverlog). Met de debugmodus aan ziet een beheerder bij een fout een paneel
  met de oorzaak (melding, databasecode, plek in de code), met een knop Kopiëren. Klanten en medewerkers zien die
  details nooit; wachtwoorden en sleutels worden er altijd uit gehaald.
- **Beveiliging**: sessies alleen als hash, wachtwoorden met scrypt, tweestapsverificatie (TOTP), versleutelde
  back-ups (dagelijks, ook vóór elke update), auditlog. Zie *Beveiliging en privacy* in `beregeningsplanner/DOCS.md`.

## Beregeningsplanner

Webapplicatie om een automatische tuinberegening te ontwerpen, geïnspireerd op de werkwijze van de DVS Beregnungsplaner: gebieden tekenen → systeemelementen → sproeiers → zones en leidingen → stuklijst.

De planner zelf is volledig client-side (HTML/JS, geen build-stap). Er zijn twee manieren om hem te draaien:

| Manier | Hoe |
|---|---|
| **Eigen server** (Docker) | `docker compose up -d --build` in de root → `http://<server>:3300/app/`; bij de eerste aanmelding maak je het eerste beheerdersaccount aan. Zie *Server (Docker)* in `beregeningsplanner/DOCS.md`. |
| **Lokaal** | `beregeningsplanner/frontend/index.html` (dashboard) of `beregeningsplanner/frontend/beregening/index.html` direct in de browser openen |

## Stappen

| Stap | Functie |
|---|---|
| 1. Project & ondergrond | **Beregeningsmethode** per soort vlak (druppelslang, druppelaars, sproeiers of geen); **Plan laden en concept maken**: plan (JPG/PNG/PDF) wordt gelezen (schaal + vlakken), lokaal zonder AI (kleur + tekstherkenning) of met AI en er wordt direct een volledig concept gemaakt; of alleen als ondergrond laden en de schaal zelf kalibreren |
| 2. Gebieden tekenen | Gazon, beplanting/border, haag, plantenbak, *mag nat worden*, *moet droog blijven*; **toverstaf** (vlak op kleur uittrekken), vrije vorm of rechthoek, hoekpunten verslepen/toevoegen |
| 3. Systeemelementen | Wateraansluiting (dynamische druk + debiet, emmertest-tip), besturing, ventielkast, waterpunten |
| 4. Sproeiers | Automatisch kop-tot-kop plaatsen of handmatig (sproeihoek wordt op rand/hoek automatisch bepaald); neerslagsimulatie met gelijkmatigheid (DU), droge plekken en water op vlakken die droog moeten blijven |
| 5. Zones & leidingen | Automatische zone-indeling per sproeiergroep binnen het beschikbare debiet; leidingtracé (MST) met PE-diameterkeuze en drukverlies |
| 6. Stuklijst & export | Uitvoeringsniveau Basis / Standaard / Premium, beregeningsschema (looptijd per zone) en **export naar Excel** |

## Excel-export

Het `.xlsx`-bestand bevat de tabbladen:

- **Project** – uitgangspunten, aandachtspunten en een afbeelding van het plan
- **Stuklijst** – artikelcode, omschrijving, aantal, eenheid, prijs, totaal (formules), subtotaal, btw 21% en totaal
- **Zones** – debiet, druk na ventiel, druk op kritisch punt, status, neerslag en looptijd per beurt
- **Sproeiers** – positie, worpwijdte, boog, richting, debiet, berekende druk en kop
- **Leidingen** – per leidingdeel diameter, lengte, debiet, snelheid en drukverlies

## Rekenmodel (indicatief)

- Sproeierdebiet: `Q [l/u] = neerslag [mm/u] × r² × sproeihoek/360` (gelijke neerslag bij vierkantsverband); strooksproeier `Q = neerslag × lengte × breedte`.
- Neerslagsimulatie: driehoeksprofiel per sproeier op een raster van 0,15–0,5 m.
- Max. zonedebiet: 90% van het opgegeven beschikbare debiet.
- Drukverlies: Hazen-Williams (C = 140, PE PN6), +10% voor hulpstukken, 0,3 bar voor filter/terugstroombeveiliging/hoofdkraan en 0,2 bar per magneetventiel. Hoogteverschillen worden niet meegenomen.
- Diameterkeuze: kleinste PE-buis met stroomsnelheid ≤ 1,5 m/s.

## Aanpassen

- **Artikelen en prijzen**: `beregeningsplanner/frontend/beregening/js/catalog.js` → `C.articles` (prijzen zijn indicatief, excl. btw).
- **Sproeiertypes, druppelslang, buizen en hydraulische uitgangspunten**: eveneens in `beregeningsplanner/frontend/beregening/js/catalog.js`.

## Opslag

Ingelogd wordt een plan op de server bewaard (met historie); zonder server wordt het project in de browser (localStorage) bewaard. Met **Opslaan/Openen** werk je met een `.aquaplan.json`-bestand, zodat je projecten kunt archiveren of delen.

## Nieuwe module toevoegen

1. Maak `beregeningsplanner/frontend/<id>/index.html` met eigen css/js in die
   map en laad `../shared/brand.css` voor de huisstijl, `../shared/common.js` in de `<head>`, daarna
   `../dashboard/modules.js` en `../shared/sidebar.js`. Alle URL's relatief; terug naar het dashboard met `href="../"`.
2. Zet de module in `beregeningsplanner/frontend/dashboard/modules.js` op
   `status: 'actief'` met `href: '<id>/'`.
3. Klaar: de server serveert elke map met een `index.html` als module (ook
   `<id>` zonder slash en diepe paden). Tests controleren de verwijzingen.

## Structuur

```
docker-compose.yml, .env.example     de server als Docker-container (poort 3300)
deploy/apps01/                       uitrol op de server (update.sh, compose.yml)
scripts/check_version.py             CI: versie moet omhoog bij een wijziging in de app
beregeningsplanner/                  de app
  Dockerfile, CHANGELOG.md, DOCS.md
  backend/
    src/server.js                    Express: pagina's, modules, login en alle /api-routes
    src/backup.js                    versleutelde back-ups (ook als opdracht: node src/backup.js create)
    src/migrate-to-postgres.js       overstap SQLite -> PostgreSQL (opdracht)
    src/paths.js                     vaste mappen (frontend, pagina's)
    src/paginas/                     inloggen, eerste beheerder, wachtwoord wijzigen
    src/database/                    SQLite/PostgreSQL, schema en migraties, kopiëren
    src/beveiliging/                 sessies, versleuteling, limieten, netwerkcontrole, meekijken
    src/platform/                    gebruikers/tenants (store), instellingen, rollen, mail, nieuws, foutmeldingen, testdata
    src/beregening/                  plan herkennen (AI), geleerde herkenning, tekening indienen, sproeiers
    src/verkoop/                     offertes, facturen (+ PDF en mail), debiteuren, Visma
    src/webshop/                     eigen webshop (storefront-*), betalen (Mollie), bestellingen, retouren, SEO, WooCommerce
    src/uitvoering/                  werkorders, uren/materiaal, foto's, uitbesteden, meldingen, klantportaal
    src/artikelen/                    artikelen en voorraad
    test/                            node --test (ook tegen PostgreSQL met TEST_DATABASE_URL)
    tools/codestyle.js               controle op de codestijl (npm run codestyle)
    tools/tenant-filter.js           controle dat elke query op tenant_id filtert (npm run tenant-filter)
  frontend/                          alle paden relatief, gewone <script>-tags (werkt ook via file://)
    index.html, dashboard/           startpagina en moduleregister (dashboard/modules.js)
    shared/                          huisstijl, zijbalk, rollen, thema, offline, gedeelde hulpfuncties
    sw.js, manifest.json             offline werken (PWA)
    beregening/                      de beregeningsplanner (index.html, css/, js/, vendor/)
    beheer/, hoofdbeheer/            beheer van de organisatie en van het platform
    offertes/, facturen/             verkoop (rekenkern: quote-core.js, invoice-core.js)
    werkorders/, planning/           uitvoering (rekenkern: workorder-core.js, worklog-core.js)
    artikelen/, webshop-bestellingen/, uitbesteden/, meldingen/, klantdossier/, plannen/, nieuws/, profiel/, portaal/
    openbaar/                        pagina's zonder login (digitale offerte, afspraak)
```

Elke module is een map onder `frontend/` met een eigen `index.html`; de
serverkant van een module staat in de map van het onderwerp onder
`backend/src/`. Een `*-core.js` in de frontend is UMD en wordt ook door de
server geladen (dezelfde berekening aan beide kanten).

## Ontwikkelen

```sh
cd beregeningsplanner/backend && npm install
DATA_DIR=/tmp/bp PORT=3300 node src/server.js   # http://localhost:3300/app/ -> eerste beheerder aanmaken
npm test                                        # node --test (SQLite)
TEST_DATABASE_URL=postgres://… npm test         # dezelfde suite tegen PostgreSQL
```

- `master` is productie. Elke wijziging gaat via een eigen branch en een pull request; een wijziging in
  `beregeningsplanner/` vraagt een hogere versie in `backend/package.json`, een regel in `CHANGELOG.md` en in
  `frontend/nieuws/releases.js`. Werk dit README bij als een PR features of de installatie wijzigt.
- Een PR merget pas als de tests (SQLite en PostgreSQL), de versiecontrole en de verplichte controles **Claude code
  review** en **Claude security review** (`.github/workflows/claude-review.yml`) groen zijn. CodeRabbit reviewt ook,
  maar adviserend: open bevindingen worden na het mergen een issue en in een opruim-PR opgelost.
- Na het mergen bouwt `release.yml` het image `ghcr.io/danieldh00/aquatech:<versie>`; de server
  (`deploy/apps01/`) rolt het binnen 15 minuten uit, met een back-up vooraf en rollback bij een fout.
- Werkafspraken (codestijl, queries, beveiliging, mappen) staan in `CLAUDE.md`.
