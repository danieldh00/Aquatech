# Changelog

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
