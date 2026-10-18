# Changelog

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
