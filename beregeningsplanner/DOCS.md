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

## Gebruikers, rollen en historie van aanvragen

Er zijn twee rollen:

| Rol | Ziet | Wie |
| --- | --- | --- |
| **Beheerder** | alle plannen, de historie van alle aanvragen, gebruikersbeheer en instellingen (module **Beheer**) | accounts met rol beheerder, en inloggen met de (optionele) toegangscode |
| **Gebruiker** | alleen de eigen plannen | accounts met rol gebruiker, en gasten |

- **Accounts** maak je als beheerder aan onder **Beheer → Gebruikers**
  (gebruikersnaam, naam, rol, wachtwoord van minimaal 8 tekens). Inloggen
  via `.../login` of de knop **Inloggen** rechtsboven. Een nieuw wachtwoord
  of uitschakelen logt de gebruiker op alle toestellen uit.
- **Gasten**: standaard uit; zonder inloggen zie je alleen de inlogpagina.
  Zet je onder **Beheer → Instellingen** *Gasten zonder inloggen toestaan*
  aan (en is er geen toegangscode), dan kan iedereen de planner gebruiken.
  Elke browser krijgt dan een eigen anonieme gebruiker en ziet alleen de
  eigen plannen.
- De **laatste actieve beheerder** kan niet worden uitgeschakeld of
  gebruiker gemaakt; maak eerst een andere beheerder aan.
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
  (zie *Gebruik*). Doe dat meteen na het starten: tot dan kan iedereen die
  de URL kent dat scherm zien. Is er via `ACCESS_CODE` al een toegangscode
  ingesteld, dan vraagt het scherm die code ter bevestiging.
- **Gegevens** staan in het volume `aquatech-data` (`/data` in de container):
  de database met plannen, historie, gebruikers en instellingen, en de
  sessiesleutel. Back-up: `docker compose cp aquatech:/data ./backup`.
- **Bijwerken**: `git pull && docker compose up -d --build`.
- **HTTPS**: zet er een reverse proxy (Caddy, Traefik, nginx) of een
  Cloudflare-tunnel voor die `X-Forwarded-Proto: https` meestuurt; dan
  krijgen de inlogcookies de `Secure`-vlag.
- **Overzetten** van een eerdere installatie: kopieer `aquatech.db` en
  `session-secret` uit de oude `/data`-map naar het volume; alle plannen,
  gebruikers, instellingen en inlogs gaan mee. Heeft die database nog geen
  beheerdersaccount, dan verschijnt bij de eerste aanmelding het scherm om
  er een aan te maken.
- **Cloudflare-tunnel**: laat de tunnel naar `http://<server>:3300` wijzen
  (of naar de containernaam `aquatech:3300` als cloudflared in hetzelfde
  Docker-netwerk draait).

## Let op

- Prijzen in de stuklijst zijn indicatief.
- Berekeningen zijn indicatief (geen hoogteverschillen). Controleer druk en
  debiet altijd ter plaatse.
