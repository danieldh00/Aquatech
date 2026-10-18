# Aquatech

Dashboard met modules. De eerste module is de **beregeningsplanner**:
ontwerp een automatische tuinberegening en exporteer de stuklijst naar
Excel. Planning en voorraadbeheer volgen.

## Gebruik

1. Start de server (zie *Server (Docker)* hieronder) en open de app in de
   browser, bijvoorbeeld `https://aquatech.den-hollander.com`.
2. **Eerste keer**: zolang er nog geen beheerder is, toont de app op elk
   pad het scherm **Welkom bij Aquatech**. Vul je naam, een gebruikersnaam
   en een wachtwoord in; dat wordt het eerste beheerdersaccount en je bent
   meteen ingelogd. Daarna verschijnt dat scherm nooit meer.
3. Daarna logt iedereen in met een eigen account (het toestel onthoudt de
   inlog een jaar). Accounts maak je aan onder **Beheer → Gebruikers**.
4. Klik op de tegel **Beregeningsplanner** (of ga direct naar
   `.../beregening/`) en klik op **Voorbeeld** of begin met **Nieuw**.

## Beregeningsmethode

In stap 1 kies je per soort vlak hoe het water krijgt:

| Vlak | Keuzes (standaard vet) |
|---|---|
| Gazon | **Meerstraalsrotator**, pop-up sproeier, turbinesproeier |
| Beplanting / border | **Druppelslang**, druppelaars, sproeiers, geen |
| Haag | **Druppelslang**, druppelaars, sproeiers, geen |
| Plantenbak | **Druppelaars**, druppelslang, geen |

Per vlak kun je afwijken: selecteer het vlak en kies bij **Beregening** een
andere methode. Iedere methode krijgt eigen zones, omdat de neerslag verschilt.

## Plan laden en concept maken

Herkennen kan **lokaal** (standaard, zonder AI, gratis) of met **AI** (als er
een API-sleutel is ingesteld).

**Lokaal** werkt op gekleurde tuinontwerpen: digitaal, maar ook een foto of
scan van een met potlood of stift ingekleurde tekening. Ongelijke belichting,
grijs papier en een kleurzweem worden eerst gecorrigeerd; daarna telt de
gemiddelde kleur per plek (zwarte lijnen en tekst tellen niet mee):

| Kleur in het plan | Wordt |
|---|---|
| Licht- en middengroen (ook bleek potlood) | Gazon |
| Donkergroen, blauwgroen | Haag / heesters |
| Bruin, oranje, roze, paars | Beplanting |
| Grijs, licht beige, geel, lichte baksteen | Bebouwing en verharding (droog houden) |
| Blauw | Water (mag nat worden) |
| Wit (papier), zwart (lijnen, tekst) | Genegeerd |

Titelblok, legenda en de rand van een foto (tafel, schaduw) worden genegeerd.
Een vlak midden in een ander vlak (gazon in de verharding) blijft een eigen
vlak; het omringende vlak krijgt daarvoor een smalle snede naar buiten.

**Labels** in het plan bepalen het soort vlak, ook als ze met de hand
geschreven zijn: *gras/gazon*, *border/beplanting/heesters*, *haag*,
*plantenbak*, *terras/woning/pad/oprit*, *vijver/grind*. In een gekleurd plan
gaat het label vóór de kleur. In een lijntekening of handschets wordt het vlak
dat door de lijnen rond het label wordt omsloten automatisch uitgetrokken;
teken de lijnen daarvoor zo gesloten mogelijk. Duidelijk blokschrift wordt het
best gelezen; zeer grillig handschrift lukt niet altijd (dan helpt de
toverstaf of de AI-optie).

De schaal wordt, in deze volgorde, bepaald uit:

1. een maat met maatlijn: "12,00 m", "450 cm" of een getal als "8500"
   (millimeters, zoals op bouwtekeningen);
2. bij een PDF: de schaalaanduiding "1:N" en het paginaformaat;
3. de breedte van de tuin: staat er geen maat op, dan vraagt de planner hoe
   breed de herkende tuin (van links naar rechts) is. Leeg laten = 10 m.

Bij een foto zegt "schaal 1:50" niets, omdat het papierformaat onbekend is.
Kalibreer de schaal na afloop met een bekende maat als die er is.
Lijntekeningen zonder kleur trek je uit met de toverstaf. **AI** leest ook
lijntekeningen, schetsen en luchtfoto's.

1. Ga naar stap 1 en klik op **Plan laden en concept maken…**.
2. Kies een tuinontwerp, plattegrond, schets of luchtfoto (JPG, PNG of PDF;
   bij een PDF wordt de eerste pagina gebruikt).
3. Na 1 à 2 minuten staat er een concept klaar: schaal, vlakken,
   wateraansluiting, besturing, ventielkast, sproeiers, zones en leidingen.
4. Controleer de schaal (stap 1, **Schaal kalibreren**) als de planner meldt
   dat hij geschat is, en pas vlakken en sproeiers aan waar nodig.

Hiervoor is een API-sleutel van Anthropic nodig:

- Maak een sleutel aan op https://console.anthropic.com en vul hem in onder
  **Beheer → Instellingen** (met **Sleutel testen** controleer je hem
  zonder kosten). Hij werkt meteen, zonder herstart.
- Elke analyse kost een paar dubbeltjes aan API-tegoed. Het maximum per dag
  (standaard 30, hele app) en per uur per IP-adres (standaard 10) stel je in
  op dezelfde plek; daar zet je AI-herkenning ook helemaal uit.
- Het plan wordt voor de analyse naar Anthropic gestuurd. Zonder sleutel blijft
  alles lokaal.

## Toverstaf

Werkt zonder API-sleutel. Laad een plan als ondergrond, kies in stap 2 bij een
soort vlak **Toverstaf** en klik midden in het vlak op het plan. De rand wordt
op kleur uitgetrokken; met **Gevoeligheid toverstaf** stel je in hoe sterk
kleuren mogen afwijken.

## Opslag

Plannen worden automatisch op twee plekken bewaard: in de browser van het
toestel en, een paar seconden na elke wijziging, in **Mijn plannen** op de
server (database `/data/aquatech.db`, zit in de back-ups van Home
Assistant). Via **Mijn plannen** in de planner (of op het dashboard) open je
een eerder plan. Iedere gebruiker ziet daar alleen de eigen plannen.
**Opslaan** downloadt daarnaast nog steeds een `.aquaplan.json`-bestand en
**Openen** laadt zo'n bestand als nieuw plan.

## Plannenoverzicht

De tegel **Plannenoverzicht** op het dashboard (of *Alle plannen →* bij
Mijn plannen) toont de plannen als tabel: projectnaam, klant, adres,
oppervlaktes, sproeiers, zones en datums, met zoeken, sorteren (klik op een
kolomkop), totalen en **Exporteer naar Excel**. Een klant ziet zijn eigen
plannen (tegel **Mijn plannen**); installateurs en beheerders zien alle
plannen van de organisatie met de gebruiker en kunnen per gebruiker
filteren; beheerders kunnen ook verwijderde plannen tonen en zien per plan
de historie.

## Offertes

De module **Offertes** bouwt een offerte op uit een beregeningsplan. Start
vanuit de planner (stap *Stuklijst & export* → **Offerte maken van dit
plan**), vanuit het plannenoverzicht (**Offerte maken**) of in de module zelf
met **Nieuwe offerte uit plan**.

- **Materialen** komen uit de stuklijst van het plan (zelfde berekening als
  de Excel-stuklijst, inclusief uitvoeringsniveau), met de ingestelde opslag
  op de artikelprijzen.
- **Arbeid** wordt geschat uit het plan: sproeiers, meters sleuf en leiding,
  ventielen en ventielkast, besturing en kabel, druppelslang of druppelaars,
  wateraansluiting, waterpunten en inregelen, afgerond op kwartieren tegen het
  uurtarief. **Overig** bevat de voorrijkosten (als ingesteld) en eigen regels.
- Alles is aan te passen: omschrijving, aantal, eenheid, prijs en btw-tarief
  (21, 9 of 0%) per regel, regels toevoegen en verwijderen, een kortings-
  percentage over het geheel (naar rato over de btw-tarieven), klantgegevens,
  datum, geldigheid, inleiding en voorwaarden. Wijzigingen worden automatisch
  bewaard. **Regels opnieuw uit het plan** neemt een gewijzigd plan over.
- **PDF / afdrukken** opent de afdrukversie in huisstijl (A4); kies in het
  printvenster *Opslaan als PDF*. Op de offerte staan alle regels met
  prijzen, of per onderdeel alleen een totaalbedrag. **Excel** geeft de
  offerte als werkblad met formules.
- Elke offerte krijgt een vast nummer per jaar (`OF-2026-0001`, voorvoegsel
  instelbaar) en een status: concept, verzonden, akkoord of afgewezen;
  verlopen offertes zijn in het overzicht te herkennen. Het overzicht is naar
  Excel te exporteren.
- **Bedrijfsgegevens** (alleen beheerders): naam, adres, contact, KvK, btw-
  nummer en IBAN voor op de offerte, plus uurtarief, opslag materiaal,
  voorrijkosten, standaard btw-tarief, geldigheid en standaardteksten. Ze
  gelden per tenant en omgeving.

Installateurs en beheerders zien hun eigen offertes en met *Van alle
gebruikers* die van de hele organisatie; alleen beheerders kunnen een
offerte definitief wissen (AVG). Een testomgeving heeft eigen offertes en
nummering.

**Klant**: koppel een offerte bij *Klantaccount* aan een account met de rol
klant. Zodra de status **Verzonden** is, ziet de klant de offerte onder
**Mijn offertes** als document (af te drukken als PDF) en kan hij **Akkoord
geven** of **Afwijzen**; de status gaat dan mee en de reactie staat in het
auditlog. Concepten ziet een klant nooit; een verlopen offerte kan hij niet
meer accepteren. Met de opmaak *totaal per onderdeel* krijgt de klant ook
via de API geen prijzen per regel.

## Gebruikers, rollen en historie van aanvragen

Elke rol ziet op het dashboard alleen de modules die erbij horen; de server
controleert de rechten zelf (vastgelegd in `frontend/shared/roles.js`).

| Rol | Mag | Wie |
| --- | --- | --- |
| **Hoofdbeheerder** | alles, in elke tenant, plus **Hoofdbeheer** (tenants en testomgevingen) | de eerste beheerder van het platform |
| **Beheerder** | alles binnen de eigen organisatie: gebruikers, instellingen, historie, auditlog, alle plannen en offertes, bedrijfsgegevens, testomgevingen | accounts met rol beheerder, en inloggen met de (optionele) toegangscode |
| **Installateur** | plannen maken en bewerken, alle plannen en offertes van de organisatie, offertes opstellen en aan een klant koppelen; geen gebruikers, instellingen of historie | accounts met rol installateur (vóór 0.22.0: *gebruiker*) |
| **Klant** | alleen de eigen plannen, en de verzonden offertes voor zijn account inzien, afdrukken en accepteren of afwijzen | accounts met rol klant, en gasten |

- **Accounts** maak je als beheerder aan onder **Beheer → Gebruikers**
  (gebruikersnaam, naam, rol, wachtwoord van minimaal 8 tekens). Inloggen
  via `.../login` of de knop **Inloggen** rechtsboven. Een nieuw wachtwoord
  of uitschakelen logt de gebruiker op alle toestellen uit.
- **Gasten**: standaard uit; zonder inloggen zie je alleen de inlogpagina.
  Zet je onder **Beheer → Instellingen** *Gasten zonder inloggen toestaan*
  aan (en is er geen toegangscode), dan kan iedereen de planner gebruiken.
  Elke browser krijgt dan een eigen anonieme gebruiker en ziet alleen de
  eigen plannen.
- De **laatste actieve beheerder** kan niet worden uitgeschakeld of een
  andere rol krijgen; maak eerst een andere beheerder aan.
- **Inloggen als een gebruiker (impersonatie)**: een hoofdbeheerder kan in
  **Hoofdbeheer → Gebruikers → Inloggen als** tijdelijk werken met de rol en
  rechten van een gebruiker, om mee te kijken of te helpen.
  - In een **testomgeving** zonder goedkeuring.
  - In **live** alleen als de gebruiker zelf toestemming heeft gegeven op het
    dashboard bij **Support op afstand** (1 uur, 4 uur, 1 dag of 3 dagen).
    De gebruiker kan die toestemming altijd intrekken; een lopende
    impersonatie stopt dan meteen. Hij ziet daar ook wie er onlangs heeft
    meegekeken.
  - Een impersonatie duurt hoogstens 8 uur (in live nooit langer dan de
    toestemming). Zolang die loopt staat onderin elke pagina een rode balk
    met **Terug naar eigen account**; uitloggen stopt de impersonatie ook.
  - Elke start en elk einde staat in het auditlog (van de omgeving én van de
    hoofdtenant, met de optionele reden), en wat er tijdens een impersonatie
    gebeurt staat in het auditlog met de naam van de hoofdbeheerder erbij.
    Een hoofdbeheerder kan niet worden overgenomen, en tijdens een
    impersonatie kun je niet van omgeving wisselen of toestemming geven
    namens de gebruiker.
- **Historie** (**Beheer → Aanvragen**): elke aanvraag krijgt een regel met
  datum, gebruiker, plan, klant, adres, oppervlaktes, sproeiers en zones:
  een nieuw plan, wijzigingen (opeenvolgende wijzigingen van dezelfde
  gebruiker binnen een half uur vormen één regel), een verwijdering en elke
  automatische planherkenning. De historie is alleen voor beheerders, kan
  niet door gebruikers worden gewist en blijft staan als een gebruiker het
  plan verwijdert. Klik op een regel voor de details of om een kopie van dat
  plan in de planner te openen; **Exporteer naar Excel** downloadt de
  (gefilterde) historie als `.xlsx`.
- Achter de Cloudflare-tunnel toont de historie als IP-adres dat van de
  tunnel, niet dat van de bezoeker.

## Testomgeving vullen met testdata

In **Hoofdbeheer** staat bij elke testomgeving de knop **Vullen met
testdata** (alleen voor testomgevingen, nooit voor live). Die maakt in één
keer:

- **Testaccounts** voor elke rol: een beheerder, twee installateurs en drie
  klanten, met gebruikersnamen als `<code-van-de-omgeving>.klant1`. Alle
  testaccounts krijgen hetzelfde willekeurige wachtwoord; dat staat alleen
  in het venster na het vullen (ook als Excel te downloaden) en wordt
  nergens bewaard.
- **Nepklanten met tuinen**: zeven plannen met terras, gazon, border, haag,
  plantenbak, systeemelementen, sproeiers en zones, met een regel in de
  historie.
- **Offertes** in alle statussen (concept, verzonden, akkoord, afgewezen),
  opgebouwd uit die plannen met de bedrijfsgegevens van de omgeving; drie
  zijn gekoppeld aan de testklanten.

Wat er al in de testomgeving stond (plannen, offertes, historie,
testaccounts) wordt eerst gewist. Opnieuw vullen geeft een nieuw wachtwoord
en logt de testaccounts uit; **Leegmaken** en **Verwijderen** ruimen de
testaccounts mee op.

Testaccounts horen bij de testomgeving zelf: wie ermee inlogt (bijvoorbeeld
in een privévenster) komt direct in die testomgeving, met de rechten van de
rol. Een testbeheerder beheert alleen de testaccounts, nooit de gebruikers
van live. De knop **Testaccounts** toont ze en daar kun je er ook losse bij
maken.

## Instellingen

Beheerders regelen alles onder **Beheer → Instellingen** (ook direct via
`.../beheer/#settings`):

| Instelling | Standaard |
|---|---|
| AI-herkenning aan/uit | aan (werkt alleen met een API-sleutel) |
| API-sleutel van Anthropic | leeg |
| Maximaal aantal AI-analyses per dag (hele app) | 30 |
| Maximaal aantal AI-analyses per uur per IP-adres | 10 |
| Gasten zonder inloggen toestaan | uit |
| Toegangscode (optioneel, gedeelde beheerderscode) | leeg |
| Modules op het dashboard aan/uit | alle aan |

- De instellingen staan in de database (`/data/aquatech.db`) en werken
  meteen, zonder herstart.
- Geheimen (API-sleutel, toegangscode) gaan nooit terug naar de browser; je
  ziet alleen of ze zijn ingesteld en van de sleutel de laatste 4 tekens.
- Omgevingsvariabelen in Docker (`ACCESS_CODE`, `GUEST_ACCESS`,
  `ANTHROPIC_API_KEY`, `AI_DAILY_LIMIT`, zie `.env.example`) zijn alleen
  **startwaarden**: zodra je een
  instelling in het scherm opslaat, gaat die voor. Met **Terugzetten naar
  startwaarde** haal je de opgeslagen waarde weer weg.
- Wie met de toegangscode is ingelogd kan die niet leegmaken (dan zou je
  jezelf buitensluiten); maak daarvoor eerst een beheerdersaccount aan.

## Server (Docker)

De app is een gewone webserver in een Docker-container
(`docker-compose.yml` in de root van de repository):

```sh
git clone https://github.com/danieldh00/Aquatech.git && cd Aquatech
docker compose up -d --build        # http://<server>:3300
```

- **Eerste start**: open de app en maak het eerste beheerdersaccount aan
  (zie *Gebruik*). Het scherm vraagt de **installatiecode** die bij het
  starten in het log staat (`docker compose logs aquatech`), of de
  toegangscode als die via `ACCESS_CODE` is ingesteld. Een vaste code kan
  ook met `SETUP_CODE`.
- **Gegevens** staan in het volume `aquatech-data` (`/data` in de container):
  de database met plannen, historie, gebruikers en instellingen, de
  sessiesleutel en (zonder `AQUATECH_MASTER_KEY_FILE`) de hoofdsleutel
  `master-key`. Back-up: `docker compose cp aquatech:/data ./backup`.
- **Bijwerken**: `git pull && docker compose up -d --build`.
- **HTTPS**: zet er een reverse proxy (Caddy, Traefik, nginx) of een
  Cloudflare-tunnel voor die `X-Forwarded-Proto: https` meestuurt; dan
  krijgen de inlogcookies de `Secure`-vlag.
- **Overzetten** van een eerdere installatie: kopieer `aquatech.db`,
  `master-key` en `session-secret` uit de oude `/data`-map naar het volume; alle plannen,
  gebruikers, instellingen en inlogs gaan mee. Heeft die database nog geen
  beheerdersaccount, dan verschijnt bij de eerste aanmelding het scherm om
  er een aan te maken.
- **Cloudflare-tunnel**: laat de tunnel naar `http://<server>:3300` wijzen
  (of naar de containernaam `aquatech:3300` als cloudflared in hetzelfde
  Docker-netwerk draait).

## Beveiliging en privacy

Getoetst aan OWASP ASVS (niveau 2) en de AVG.

| Onderdeel | Hoe |
|---|---|
| Geheimen (API-sleutel, toegangscode) | AES-256-GCM in de database, sleutel per doel afgeleid (HKDF) van de hoofdsleutel |
| Wachtwoorden | scrypt (N=2^17, r=8, p=1), minimaal 12 tekens, geen voorspelbare woorden of gebruikersnaam |
| Sessies | op de server, token alleen als SHA-256-hash opgeslagen; verloopt na 14 dagen zonder gebruik, uiterlijk na 30 dagen |
| Inloggen | max. 10 pogingen per kwartier per IP en per gebruikersnaam |
| Eerste beheerder | alleen met de installatiecode uit het serverlog of de toegangscode |
| Auditlog | inloggen, uitloggen, gebruikers en instellingen (Beheer → Auditlog) |
| Bewaartermijnen | IP-adressen 90 dagen, auditlog 365 dagen (instelbaar) |
| Back-ups | dagelijks, AES-256-GCM, 14 dagen bewaard (instelbaar), downloadbaar voor opslag elders |
| Recht op vergetelheid | Plannenoverzicht → plan → *Definitief wissen* (plan + inhoud van de historie) |
| Database | rechten 0600, `secure_delete`, integriteitscontrole bij de start |
| Proces | draait als gewone gebruiker (uid 1000), niet als root |
| Browser | Content-Security-Policy, X-Frame-Options, HSTS via https, `no-store` op de API |

**Hoofdsleutel.** Standaard maakt de app bij de eerste start
`/data/master-key` aan. Daarmee is een gelekt databasebestand alleen niet
genoeg, maar wie het hele volume heeft, heeft ook de sleutel. Beter: zet de
sleutel buiten het volume als Docker-secret:

```sh
mkdir -p secrets && docker compose cp aquatech:/data/master-key secrets/master-key   # of: openssl rand -hex 32 > secrets/master-key (alleen bij een nieuwe installatie)
chmod 600 secrets/master-key
```

en zet in `docker-compose.yml` de regels onder *Hoofdsleutel als
Docker-secret* aan. Bewaar daarnaast een kopie van de sleutel in een
wachtwoordkluis: zonder de sleutel zijn de opgeslagen geheimen onbruikbaar
(een nieuwe sleutel betekent API-sleutel en toegangscode opnieuw invullen).

**Back-ups terugzetten.** Stop de app, ontsleutel de back-up en zet die
als database terug:

```sh
docker compose stop aquatech
docker compose run --rm --no-deps -e RUN_AS_ROOT=1 aquatech \
  node src/backup.js decrypt /data/backups/aquatech-JJJJMMDD-UUMMSS.db.enc /data/terug.db
# controleer, en vervang daarna /data/aquatech.db door /data/terug.db
docker compose start aquatech
```

Een wis-opdracht (definitief wissen) staat nog in de back-ups tot die na de
bewaartermijn verdwijnen; vermeld dat in de privacyverklaring.

**Nog te regelen bij de serverinrichting**

- Schijfversleuteling op de host (LUKS/BitLocker) of een VPS-aanbieder met
  versleutelde opslag in de EU.
- De versleutelde back-ups uit `/data/backups` (of `BACKUP_DIR` op een
  andere schijf) dagelijks naar een andere locatie kopiëren, periodiek een
  terugzettest; de hoofdsleutel apart bewaren.
- HTTPS via de Cloudflare-tunnel of een reverse proxy; poort 3300 niet
  rechtstreeks open zetten naar internet (alleen de tunnel).
- Host bijwerken (`git pull && docker compose up -d --build` voor de app,
  en het besturingssysteem/Docker zelf).
- AVG: verwerkersovereenkomst met hosting- en AI-aanbieder (Anthropic, alleen
  als AI-herkenning aanstaat), privacyverklaring voor klanten en een
  register van verwerkingen.

## Let op

- Prijzen in de stuklijst zijn indicatief.
- Berekeningen zijn indicatief (geen hoogteverschillen). Controleer druk en
  debiet altijd ter plaatse.
