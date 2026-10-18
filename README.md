# Aquatech

Aquatech is een modulair pakket (in de richting van een ERP voor
beregeningsbedrijven). De startpagina is een dashboard met een tegel per
module; de **beregeningsplanner** is de eerste module, planning en
voorraadbeheer volgen.

## Beregeningsplanner

Webapplicatie om een automatische tuinberegening te ontwerpen, geïnspireerd op de werkwijze van de DVS Beregnungsplaner: gebieden tekenen → systeemelementen → sproeiers → zones en leidingen → stuklijst.

De planner zelf is volledig client-side (HTML/JS, geen build-stap). Er zijn drie manieren om hem te draaien:

| Manier | Hoe |
|---|---|
| **Home Assistant-add-on** (testen) | Instellingen → Add-ons → Add-on-winkel → ⋮ → Repositories → `https://github.com/danieldh00/Aquatech` toevoegen, daarna **Aquatech** installeren en starten. Openen via het **Aquatech**-paneel in het zijmenu. |
| **Eigen server** (Docker) | `docker compose up -d` in de root → `http://<server>:3300` |
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
repository.yaml                     HA add-on-store
docker-compose.yml                  draaien buiten HA (poort 3300)
beregeningsplanner/                 de add-on
  config.yaml, Dockerfile, apparmor.txt, CHANGELOG.md, DOCS.md, icon.png, logo.png
  backend/src/server.js             express: dashboard + modules, login, /api/health, /api/plan/*
  backend/src/planAnalyzer.js       plan lezen via de Claude API (schaal, vlakken, elementen)
  backend/test/                     node --test
  frontend/                         alle paden relatief, i.v.m. ingress
    frontend/index.html          dashboard (startpagina)
    frontend/dashboard/          opmaak, script en moduleregister (modules.js) van het dashboard
    frontend/shared/             huisstijl voor alle modules: brand.css (kleuren, Montserrat), logo's
  frontend/beregening/              module beregeningsplanner (bereikbaar op beregening/)
    frontend/index.html          UI-opbouw
    frontend/css/app.css         Opmaak
    frontend/js/geometry.js      Geometrie (polygonen, afstanden, omsluitende rechthoek)
    frontend/js/catalog.js       Producten, prijzen en technische uitgangspunten
    frontend/js/planner.js       Automatische sproeierplaatsing (worpwijdte via simulatie)
    frontend/js/planimport.js    Plan inlezen (JPG/PNG/PDF via pdf.js)
    frontend/js/autotrace.js     Toverstaf (vlak op kleur uittrekken)
    frontend/js/concept.js       Van herkend plan naar concept
    frontend/js/localrecog.js    Lokale herkenning: vlakken op kleur, schaal via OCR (Tesseract)
frontend/js/hydraulics.js    Zones, leidingtracé en drukverlies
frontend/js/simulation.js    Neerslagsimulatie
frontend/js/bom.js           Stuklijst en Excel-export
frontend/js/editor.js        Canvas-editor (tekenen, selecteren, zoomen)
frontend/js/app.js           Applicatielogica en panelen
frontend/beregening/vendor/exceljs.min.js  ExcelJS 4.4.0 (MIT) voor .xlsx-export
```
