# Aquatech

Aquatech is een modulair pakket (in de richting van een ERP voor
beregeningsbedrijven). De startpagina is een dashboard met een tegel per
module; de **beregeningsplanner** is de eerste module, planning en
Artikelen (voorheen voorraadbeheer) volgen.

## Beregeningsplanner

Webapplicatie om een automatische tuinberegening te ontwerpen, geïnspireerd op de werkwijze van de DVS Beregnungsplaner: gebieden tekenen → systeemelementen → sproeiers → zones en leidingen → stuklijst.

De planner zelf is volledig client-side (HTML/JS, geen build-stap). Er zijn drie manieren om hem te draaien:

| Manier | Hoe |
|---|---|
| **Eigen server** (Docker) | `docker compose up -d --build` in de root → `http://<server>:3300`; bij de eerste aanmelding maak je het eerste beheerdersaccount aan. Zie *Server (Docker)* in `beregeningsplanner/DOCS.md`. |
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

## Instellingen

API-sleutel, toegangscode, AI-limieten en modules stel je als beheerder in
onder **Beheer → Instellingen** (opgeslagen in de database, werkt zonder
herstart). Docker-omgevingsvariabelen zijn alleen startwaarden.

## Opslag

Het project wordt automatisch in de browser (localStorage) bewaard. Met **Opslaan/Openen** werk je met een `.aquaplan.json`-bestand, zodat je projecten kunt archiveren of delen.

## Nieuwe module toevoegen

1. Maak `beregeningsplanner/frontend/<id>/index.html` met eigen css/js in die
   map en laad `../shared/brand.css` voor de huisstijl. Alle URL's relatief; terug naar het dashboard met `href="../"`.
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
    src/platform/                    gebruikers/tenants (store), instellingen, rollen, mail, nieuws, AI-kosten, testdata
    src/beregening/                  plan herkennen (AI), geleerde herkenning, tekening indienen, sproeiers
    src/verkoop/                     offertes, facturen (+ PDF en mail), debiteuren, Visma
    src/webshop/                     WooCommerce: producten, synchronisatie, bestellingen
    src/uitvoering/                  werkorders, uren/materiaal, foto's, uitbesteden, meldingen, klantportaal
    src/artikelen/                    artikelen en voorraad
    test/                            node --test (ook tegen PostgreSQL met TEST_DATABASE_URL)
    tools/codestyle.js               controle op de codestijl (npm run codestyle)
  frontend/                          alle paden relatief, gewone <script>-tags (werkt ook via file://)
    index.html, dashboard/           startpagina en moduleregister (dashboard/modules.js)
    shared/                          huisstijl, zijbalk, rollen, thema, offline, gedeelde hulpfuncties
    sw.js, manifest.json             offline werken (PWA)
    beregening/                      de beregeningsplanner (index.html, css/, js/, vendor/)
    beheer/, hoofdbeheer/            beheer van de organisatie en van het platform
    offertes/, facturen/             verkoop (rekenkern: quote-core.js, invoice-core.js)
    werkorders/, planning/           uitvoering (rekenkern: workorder-core.js, worklog-core.js)
    artikelen/, uitbesteden/, meldingen/, klantdossier/, plannen/, nieuws/, profiel/, portaal/
    openbaar/                        pagina's zonder login (digitale offerte, afspraak)
```

Elke module is een map onder `frontend/` met een eigen `index.html`; de
serverkant van een module staat in de map van het onderwerp onder
`backend/src/`. Een `*-core.js` in de frontend is UMD en wordt ook door de
server geladen (dezelfde berekening aan beide kanten).
