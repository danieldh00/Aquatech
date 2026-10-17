# Aquatech Beregeningsplanner

Webapplicatie om een automatische tuinberegening te ontwerpen, geïnspireerd op de werkwijze van de DVS Beregnungsplaner: gebieden tekenen → systeemelementen → sproeiers → zones en leidingen → stuklijst.

De planner zelf is volledig client-side (HTML/JS, geen build-stap). Er zijn drie manieren om hem te draaien:

| Manier | Hoe |
|---|---|
| **Home Assistant-add-on** (testen) | Instellingen → Add-ons → Add-on-winkel → ⋮ → Repositories → `https://github.com/danieldh00/Aquatech` toevoegen, daarna **Beregeningsplanner** installeren en starten. Openen via het **Beregening**-paneel in het zijmenu. |
| **Eigen server** (Docker) | `docker compose up -d` in de root → `http://<server>:3300` |
| **Lokaal** | `beregeningsplanner/frontend/index.html` direct in de browser openen |

## Stappen

| Stap | Functie |
|---|---|
| 1. Project & ondergrond | Projectgegevens; plattegrond/luchtfoto laden (JPG/PNG) en schaal kalibreren met een bekende maat |
| 2. Gebieden tekenen | Gazon, beplanting/border, haag, *mag nat worden*, *moet droog blijven*; vrije vorm of rechthoek, hoekpunten verslepen/toevoegen |
| 3. Systeemelementen | Wateraansluiting (dynamische druk + debiet, emmertest-tip), besturing, ventielkast, waterpunten |
| 4. Sproeiers | Automatisch kop-tot-kop plaatsen of handmatig (boog wordt op rand/hoek automatisch bepaald); neerslagsimulatie met DU<sub>lq</sub>, droge plekken en overspray |
| 5. Zones & leidingen | Automatische zone-indeling per sproeiergroep binnen het beschikbare debiet; leidingtracé (MST) met PE-diameterkeuze en drukverlies |
| 6. Stuklijst & export | Uitvoering Eco / Expert / Premium, beregeningsschema (looptijd per zone) en **export naar Excel** |

## Excel-export

Het `.xlsx`-bestand bevat de tabbladen:

- **Project** – uitgangspunten, aandachtspunten en een afbeelding van het plan
- **Stuklijst** – artikelcode, omschrijving, aantal, eenheid, prijs, totaal (formules), subtotaal, btw 21% en totaal
- **Zones** – debiet, druk na ventiel, druk op kritisch punt, status, neerslag en looptijd per beurt
- **Sproeiers** – positie, worpwijdte, boog, richting, debiet, berekende druk en kop
- **Leidingen** – per leidingdeel diameter, lengte, debiet, snelheid en drukverlies

## Rekenmodel (indicatief)

- Sproeierdebiet: `Q [l/h] = neerslag [mm/h] × r² × boog/360` (gelijke neerslag bij vierkantsverband); strooksproeier `Q = neerslag × lengte × breedte`.
- Neerslagsimulatie: driehoeksprofiel per sproeier op een raster van 0,15–0,5 m.
- Max. zonedebiet: 90% van het opgegeven beschikbare debiet.
- Drukverlies: Hazen-Williams (C = 140, PE PN6), +10% voor hulpstukken, 0,3 bar voor filter/terugstroombeveiliging/hoofdkraan en 0,2 bar per magneetventiel. Hoogteverschillen worden niet meegenomen.
- Diameterkeuze: kleinste PE-buis met stroomsnelheid ≤ 1,5 m/s.

## Aanpassen

- **Artikelen en prijzen**: `beregeningsplanner/frontend/js/catalog.js` → `C.articles` (prijzen zijn indicatief, excl. btw).
- **Sproeiertypes, druppelslang, buizen en hydraulische uitgangspunten**: eveneens in `beregeningsplanner/frontend/js/catalog.js`.

## Opslag

Het project wordt automatisch in de browser (localStorage) bewaard. Met **Opslaan/Openen** werk je met een `.aquaplan.json`-bestand, zodat je projecten kunt archiveren of delen.

## Structuur

```
repository.yaml                     HA add-on-store
docker-compose.yml                  draaien buiten HA (poort 3300)
beregeningsplanner/                 de add-on
  config.yaml, Dockerfile, apparmor.txt, CHANGELOG.md, DOCS.md, icon.png, logo.png
  backend/src/server.js             express: serveert frontend + /api/health
  backend/test/                     node --test
  frontend/                         de planner (alle paden relatief, i.v.m. ingress)
    frontend/index.html          UI-opbouw
    frontend/css/app.css         Opmaak
    frontend/js/geometry.js      Geometrie (polygonen, afstanden, omsluitende rechthoek)
    frontend/js/catalog.js       Producten, prijzen en technische uitgangspunten
    frontend/js/planner.js       Automatische sproeierplaatsing
frontend/js/hydraulics.js    Zones, leidingtracé en drukverlies
frontend/js/simulation.js    Neerslagsimulatie
frontend/js/bom.js           Stuklijst en Excel-export
frontend/js/editor.js        Canvas-editor (tekenen, selecteren, zoomen)
frontend/js/app.js           Applicatielogica en panelen
frontend/vendor/exceljs.min.js  ExcelJS 4.4.0 (MIT) voor .xlsx-export
```
