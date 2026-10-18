# Changelog

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
